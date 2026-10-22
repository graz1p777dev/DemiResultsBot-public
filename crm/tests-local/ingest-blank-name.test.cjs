const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const originalLoad = Module._load
let inserts

function query(table) {
  let operation = 'select'
  const chain = {
    select() { return this }, eq() { return this }, is() { return this },
    or() { return this }, limit() { return this }, in() { return this },
    insert(value) { operation = 'insert'; inserts.push({ table, value }); return this },
    update() { operation = 'update'; return this }, upsert() { operation = 'upsert'; return this },
    maybeSingle() { return Promise.resolve(result()) }, single() { return Promise.resolve(result()) },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
  }
  function result() {
    if (operation === 'insert' && table === 'deals') {
      const row = inserts.at(-1).value
      if (!row.title.trim()) return { data: null, error: { code: '23514', message: 'deals_title_check' } }
      return { data: { id: 'deal-test' }, error: null }
    }
    const data = table === 'crm_clients' ? { id: 'client-test', first_name: ' ', whatsapp_id: 'test-chat', phone_normalized: '996000000000' }
      : table === 'crm_conversations' ? { id: 'conversation-test', unread_count: 0, responsible_employee_id: null }
        : table === 'deal_stages' ? { id: 'stage-test' }
          : table === 'crm_messages' ? [{ id: 'message-test' }]
            : table === 'employees' ? [] : null
    return { data, error: null }
  }
  return chain
}

Module._load = function (name, parent, main) {
  if (name === '@/lib/supabase/admin') return { createAdminClient: () => ({ from: query }) }
  if (name === '@/lib/notifications/notify') return { notify: async () => {} }
  return originalLoad.call(this, name, parent, main)
}
require.extensions['.ts'] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  module._compile(code, filename)
}
const { ingestChannelMessage } = require(path.resolve(__dirname, '../src/lib/crm-ingest.ts'))

for (const [label, fields, expectedTitle, expectedName] of [
  ['blank name falls back to phone', { name: '  \t ', phone: '996000000000' }, '996000000000', null],
  ['all labels blank use channel fallback', { name: ' ', username: '\n', phone: ' ' }, 'Новый клиент whatsapp', null],
  ['real name is trimmed', { name: '  Тестовый клиент  ', phone: '996000000000' }, 'Тестовый клиент', 'Тестовый клиент'],
]) test(label, async () => {
  inserts = []
  await ingestChannelMessage({ channel: 'whatsapp', provider: 'green-api',
    externalMessageId: 'test-message', externalConversationId: 'test-chat', externalClientId: 'test-client',
    text: 'Локальная проверка', occurredAt: '2026-10-22T08:00:00Z', ...fields }, { queueBot: false })
  const deal = inserts.find(row => row.table === 'deals').value
  assert.equal(deal.title, expectedTitle)
  assert.equal(deal.customer_name, expectedName)
})
