const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('../node_modules/typescript')

const originalLoad = Module._load
const originalTs = require.extensions['.ts']
const originalFetch = global.fetch
const originalUrl = process.env.BOT_BACKEND_API_URL
const originalKey = process.env.BOT_BACKEND_ADMIN_API_KEY
process.env.BOT_BACKEND_API_URL = 'https://backend.example.test'
process.env.BOT_BACKEND_ADMIN_API_KEY = 'synthetic-key'

let actor, user, permissions, deals, approvals, backendCalls, dealAccess
Module._load = function (name, parent, main) {
  if (name === 'next/server') return { NextResponse: Object.assign(Response, { json: Response.json }) }
  if (name === '@/lib/authz') return {
    getActor: async () => actor,
    can: async (_actor, resource, action) => permissions.has(`${resource}:${action}`),
  }
  if (name === '@/lib/identity') return { getAuthUser: async () => user, getSelfEmployee: async () => ({ name: 'Test Staff' }) }
  if (name === '@/lib/deal-access') return {
    DEAL_COMPANY_ID: 'synthetic-company',
    getDealAccess: async () => dealAccess ? { employeeId: actor.employeeId } : null,
    canAccessDealResponsible: (access, responsible) => responsible === access.employeeId,
  }
  if (name === '@/lib/supabase/admin') return { createAdminClient: () => ({
    from: () => ({
      select() { return this }, eq() { return this }, is() { return this },
      async in(_column, ids) { return { data: deals.filter(deal => ids.includes(deal.amocrm_lead_id)), error: null } },
    }),
  }) }
  if (name === '@/lib/backend-record-access') return originalLoad.call(this, path.resolve(__dirname, '../src/lib/backend-record-access.ts'), parent, main)
  return originalLoad.call(this, name, parent, main)
}
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  mod._compile(output.outputText, filename)
}
const route = require('../src/app/api/backend/[...path]/route.ts')

beforeEach(() => {
  actor = { role: 'mp', employeeId: 'employee-1' }
  user = { id: 'synthetic-user' }
  permissions = new Set(['approvals:view', 'approvals:edit'])
  deals = [{ amocrm_lead_id: '71', responsible_employee_id: 'employee-1' }]
  approvals = { total: 1, items: [{ id: 12, status: 'pending', lead: { amocrm_lead_id: '71' } }] }
  dealAccess = true
  backendCalls = []
  global.fetch = async (url, options) => {
    backendCalls.push({ url: String(url), options })
    if (String(url).includes('/admin/approvals?')) return Response.json(approvals)
    return Response.json({ ok: true, proposal_token: 'a'.repeat(24), edited_reply: 'Synthetic reply' })
  }
})
after(() => {
  Module._load = originalLoad
  require.extensions['.ts'] = originalTs
  global.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.BOT_BACKEND_API_URL
  else process.env.BOT_BACKEND_API_URL = originalUrl
  if (originalKey === undefined) delete process.env.BOT_BACKEND_ADMIN_API_KEY
  else process.env.BOT_BACKEND_ADMIN_API_KEY = originalKey
})

const token = 'a'.repeat(24)
const preview = ['admin', 'approvals', '12', 'edit-preview']
const decision = action => [...preview, token, action]
async function invoke(method, segments, body = '{}') {
  const request = {
    method,
    headers: new Headers({ 'content-type': 'application/json', cookie: 'private', 'x-admin-api-key': 'browser-key' }),
    nextUrl: new URL('http://localhost/api/backend/' + segments.join('/')),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
  return route[method](request, { params: Promise.resolve({ path: segments }) })
}

test('preview, accept and discard use only POST and exact token/path allowlist', async () => {
  for (const segments of [preview, decision('accept'), decision('discard')]) {
    assert.equal((await invoke('POST', segments)).status, 200)
  }
  assert.equal(backendCalls.filter(call => call.options.method === 'POST').length, 3)
  for (const [method, segments] of [
    ['GET', preview], ['PATCH', preview], ['DELETE', decision('accept')],
    ['POST', [...preview, 'bad-token', 'accept']],
    ['POST', decision('approve')], ['POST', [...decision('accept'), 'extra']],
  ]) assert.equal((await invoke(method, segments)).status, 403)
  assert.equal(backendCalls.filter(call => call.options.method !== 'GET').length, 3)
})

test('preview requires authentication, staff role and approvals view plus edit', async () => {
  user = null
  assert.equal((await invoke('POST', preview)).status, 401)
  user = { id: 'synthetic-user' }
  actor.role = 'buh'
  assert.equal((await invoke('POST', preview)).status, 403)
  actor.role = 'mp'
  permissions.delete('approvals:edit')
  assert.equal((await invoke('POST', preview)).status, 403)
  permissions.add('approvals:edit')
  permissions.delete('approvals:view')
  assert.equal((await invoke('POST', preview)).status, 403)
  assert.equal(backendCalls.length, 0)
})

test('owner, ROP, manager and LMAI roles pass their intended approval policy', async () => {
  for (const role of ['owner', 'rop', 'mp', 'lmai']) {
    actor.role = role
    assert.equal((await invoke('POST', preview)).status, 200, role)
  }
  actor.role = 'owner'
  permissions.clear()
  dealAccess = false
  assert.equal((await invoke('POST', decision('discard'))).status, 200)
  assert.equal(backendCalls.filter(call => call.options.method === 'POST').length, 5)
})

test('each preview decision is scoped to an accessible pending approval record', async () => {
  for (const segments of [preview, decision('accept'), decision('discard')]) {
    deals[0].responsible_employee_id = 'other-employee'
    assert.equal((await invoke('POST', segments)).status, 403)
    deals[0].responsible_employee_id = 'employee-1'
    approvals = { total: 1, items: [{ id: 13, status: 'pending', lead: { amocrm_lead_id: '71' } }] }
    assert.equal((await invoke('POST', segments)).status, 403)
    approvals = { total: 1, items: [{ id: 12, status: 'sent', lead: { amocrm_lead_id: '71' } }] }
    assert.equal((await invoke('POST', segments)).status, 403)
    approvals = { total: 1, items: [{ id: 12, status: 'pending', lead: { amocrm_lead_id: '71' } }] }
    dealAccess = false
    assert.equal((await invoke('POST', segments)).status, 403)
    dealAccess = true
  }
  assert.equal(backendCalls.filter(call => call.options.method === 'POST').length, 0)
})

test('staff proxy sends server credentials only after record authorization', async () => {
  const response = await invoke('POST', preview, JSON.stringify({ reply: 'Synthetic reply', expected_current: 'Original' }))
  assert.equal(response.status, 200)
  const mutation = backendCalls.find(call => call.options.method === 'POST')
  assert.equal(mutation.url, 'https://backend.example.test/admin/approvals/12/edit-preview')
  assert.equal(mutation.options.headers.get('x-admin-api-key'), 'synthetic-key')
  assert.equal(mutation.options.headers.get('cookie'), null)
  assert.equal(new TextDecoder().decode(mutation.options.body), '{"reply":"Synthetic reply","expected_current":"Original"}')
})

test('decoded traversal and residual escaping fail before authentication or backend access', async () => {
  for (const bad of ['..', 'x/y', 'x%2fy', 'x\\y', 'x?y']) {
    assert.equal((await invoke('POST', ['admin', 'approvals', bad, 'edit-preview'])).status, 400)
  }
  assert.equal(backendCalls.length, 0)
})
