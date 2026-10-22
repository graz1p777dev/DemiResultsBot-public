// From crm/: node --test tests-local/green.test.cjs
// Load the isolated source copy; all application dependencies with side effects are mocked.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const deps = process.env.DEMI_CRM_NODE_MODULES
  ? path.resolve(process.env.DEMI_CRM_NODE_MODULES)
  : path.resolve(__dirname, '../node_modules')
const ts = require(`${deps}/typescript`)
const root = path.resolve(__dirname, '../src')
const originalLoad = Module._load
const originalFetch = global.fetch
const originalEnv = { ...process.env }
let ingested, updates, calls, ingestFails, dbFails, allowed, actor, filters, previousStatuses
const query = { update(value) { updates.push(value); return this }, eq(...args) { filters.push(args); return this }, in(column, values) { previousStatuses = values; return Promise.resolve({ error: dbFails ? new Error('mock db') : null }) } }
Module._load = function (name, parent, main) {
  if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } }
  if (name === '@/lib/crm-ingest') return { ingestChannelMessage: async (...args) => { if (ingestFails) throw new Error('mock ingest'); ingested.push(args) } }
  if (name === '@/lib/supabase/admin') return { createAdminClient: () => ({ from: () => query }) }
  if (name === '@/lib/authz') return { getActor: async () => actor, can: async () => allowed }
  if (name.startsWith('@/')) return originalLoad.call(this, path.join(root, name.slice(2)) + '.ts', parent, main)
  if (name === 'zod') return originalLoad.call(this, `${deps}/zod`, parent, main)
  return originalLoad.call(this, name, parent, main)
}
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  mod._compile(compiled.outputText, filename)
}
const transport = require('../src/lib/green-whatsapp.ts')
const send = require('../src/app/api/internal/channel-send/route.ts')
const webhook = require('../src/app/api/integrations/green-api/webhook/[token]/route.ts')
const status = require('../src/app/api/integrations/status/route.ts')
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(GREEN_|META_|BOT_|INSTAGRAM_|INTERNAL_NOTIFY)/.test(name)) delete process.env[name]
  Object.assign(process.env, { GREEN_API_URL: 'https://api.green-api.com', GREEN_API_ID_INSTANCE: '12345', GREEN_API_TOKEN_INSTANCE: 'fake-api-secret', GREEN_API_WEBHOOK_TOKEN: 'fake-hook-secret', INTERNAL_NOTIFY_TOKEN: 'fake-internal', BOT_BACKEND_API_URL: 'https://backend.example', BOT_BACKEND_ADMIN_API_KEY: 'fake-backend-key' })
  ingested = []; updates = []; calls = []; filters = []; previousStatuses = []; ingestFails = false; dbFails = false; allowed = true; actor = { id: 'mock' }
  global.fetch = async (url, options) => { calls.push({ url: String(url), options, body: JSON.parse(options.body) }); return Response.json(String(url).includes('/checkWhatsapp/') ? { existsWhatsapp: true, chatId: '10000000000001@lid' } : { idMessage: 'green.message:1-2_3', message_id: 'ig1' }) }
})
after(() => { global.fetch = originalFetch; Module._load = originalLoad; process.env = originalEnv })
const post = (payload, token = 'fake-internal') => send.POST(new Request('http://localhost/api/internal/channel-send', { method: 'POST', headers: { 'x-internal-token': token }, body: JSON.stringify(payload) }))
const event = (extra = {}) => ({ typeWebhook: 'incomingMessageReceived', instanceData: { idInstance: 12345 }, timestamp: 1700000000, idMessage: 'green.message:1-2_3', senderData: { chatId: '996000000000@c.us' }, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'hello' } }, ...extra })
const hook = (body, token = 'fake-hook-secret') => webhook.POST(new Request('http://localhost/hook', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ token }) })
test('text uses documented sendMessage and returns queued/provider/messageId; persistence skips bot', async () => {
  const result = await post({ channel: 'whatsapp', recipientId: '+996000000000', text: 'hello' })
  assert.deepEqual(await result.json(), { ok: true, provider: 'green_api', messageId: 'green.message:1-2_3', status: 'queued' })
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/waInstance12345\/checkWhatsapp\//)
  assert.deepEqual(calls[0].body, { chatId: '996000000000@c.us', force: true })
  assert.match(calls[1].url, /\/waInstance12345\/sendMessage\//)
  assert.deepEqual(calls[1].body, { chatId: '10000000000001@lid', message: 'hello', linkPreview: false })
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal)
    assert.equal(call.options.cache, 'no-store')
  }
  assert.equal(ingested[0][0].provider, 'green-api'); assert.deepEqual(ingested[0][1], { queueBot: false })
  assert.equal(ingested[0][0].phone, '996000000000')
  assert.equal(ingested[0][0].externalConversationId, '996000000000@c.us')
})
test('audio and image use sendFileByUrl, extension and image caption', async () => {
  for (const mediaType of ['audio', 'image']) {
    const result = await post({ channel: 'whatsapp', recipientId: '996000000000@c.us', text: 'caption', audioUrl: 'https://backend.example/media/test.mp3', mediaType })
    assert.equal(result.status, 200)
    assert.equal(calls.at(-1).body.fileName, 'test.mp3'); assert.match(calls.at(-1).url, /sendFileByUrl/)
    assert.match(calls.at(-2).url, /checkWhatsapp/)
    assert.equal(calls.at(-1).body.chatId, '10000000000001@lid')
    assert.equal(calls.at(-1).body.urlFile, 'https://backend.example/media/test.mp3')
    assert.equal(calls.at(-1).body.caption, mediaType === 'image' ? 'caption' : undefined)
  }
})
test('internal secret, recipients and media allowlist fail before fetch', async () => {
  const base = { channel: 'whatsapp', recipientId: '996000000000', text: 'hello' }
  assert.equal((await post(base, 'wrong')).status, 403)
  for (const recipientId of ['123@g.us', '10000000000001@lid', 'invalid', '123']) assert.equal((await post({ ...base, recipientId })).status, 400)
  for (const audioUrl of ['http://backend.example/media/a.mp3', 'https://evil.example/media/a.mp3', 'https://backend.example/media/a.mp3?q=1', 'https://u:p@backend.example/media/a.mp3', 'https://backend.example/private/a.mp3', 'https://backend.example/media/noextension']) assert.equal((await post({ ...base, audioUrl })).status, 400)
  assert.equal(calls.length, 0)
})
test('missing/unsafe config fails closed; errors never reflect token or provider response', async () => {
  for (const base of ['', 'http://api.green-api.com', 'https://evil.example', 'https://api.green-api.com/path']) {
    process.env.GREEN_API_URL = base
    await assert.rejects(transport.sendGreenWhatsApp('996000000000', 'hello'), { status: 503 })
  }
  assert.equal(calls.length, 0)
  process.env.GREEN_API_URL = 'https://api.green-api.com'
  for (const fakeFetch of [async () => { throw new Error('fake-api-secret') }, async () => Response.json({ error: 'fake-api-secret' }, { status: 401 }), async () => Response.json({}), async () => Response.json(null)]) {
    global.fetch = fakeFetch
    const response = await post({ channel: 'whatsapp', recipientId: '996000000000', text: 'hello' })
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('fake-api-secret'))
  }
})
test('Instagram preserves existing send branch', async () => {
  process.env.INSTAGRAM_ACCESS_TOKEN = 'fake-ig'; process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = '123'
  assert.deepEqual(await (await post({ channel: 'instagram', recipientId: '42', text: 'hi' })).json(), { ok: true, messageId: 'ig1' })
  assert.match(calls[0].url, /^https:\/\/graph.instagram.com/); assert.equal(ingested.length, 0)
})
test('canonical personal addresses are returned separately from the phone', async () => {
  for (const chatId of ['10000000000001@lid', '996000000000@c.us']) {
    calls = []
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return Response.json(calls.length === 1 ? { existsWhatsapp: true, chatId } : { idMessage: 'message-1' })
    }
    const result = await transport.sendGreenWhatsApp('+996000000000', 'hello')
    assert.equal(result.recipient, '996000000000')
    assert.equal(result.providerChatId, chatId)
    assert.equal(calls[1].body.chatId, chatId)
  }
})
test('unconfirmed, malformed and non-personal resolutions never send', async () => {
  for (const body of [null, {}, { existsWhatsapp: false, chatId: '10000000000001@lid' }, { existsWhatsapp: 'true', chatId: '10000000000001@lid' },
    ...['123@g.us', 'status@broadcast', '996000000000', '10000000000001@lid\n', 'abc@lid', '', '1'.repeat(21) + '@lid', 'fake-api-secret@c.us', null, 123].map(chatId => ({ existsWhatsapp: true, chatId }))]) {
    calls = []
    global.fetch = async (url) => { calls.push(String(url)); return Response.json(body) }
    await assert.rejects(transport.sendGreenWhatsApp('996000000000', 'hello'), { status: 502 })
    assert.equal(calls.length, 1)
  }
})
test('resolution and send failures are sanitized, bounded and never retried', async () => {
  for (const stage of ['checkWhatsapp', 'sendMessage']) {
    for (const failure of ['timeout', 'redirect', 'http', 'json', 'missing-id']) {
      calls = []
      global.fetch = async (url, options) => {
        calls.push(String(url))
        assert.equal(options.redirect, 'error'); assert.ok(options.signal)
        if (!String(url).includes(`/${stage}/`)) return Response.json({ existsWhatsapp: true, chatId: '10000000000001@lid' })
        if (failure === 'timeout') throw new DOMException('fake-api-secret', 'TimeoutError')
        if (failure === 'redirect') throw new TypeError('redirect fake-api-secret')
        if (failure === 'http') return Response.json({ error: 'fake-api-secret' }, { status: 401 })
        if (failure === 'json') return new Response('fake-api-secret')
        return Response.json({})
      }
      await assert.rejects(transport.sendGreenWhatsApp('996000000000', 'hello'), error => error.status === 502 && !error.message.includes('fake-api-secret'))
      assert.equal(calls.length, stage === 'checkWhatsapp' ? 1 : 2)
    }
  }
})
test('integration status has authorization and no webhook/provider secrets', async () => {
  const body = await (await status.GET()).json()
  assert.equal(body.whatsapp.provider, 'green_api'); assert.equal(body.whatsapp.configured, true)
  assert.match(body.whatsapp.webhook, /\{token\}$/); assert.ok(!JSON.stringify(body).includes('fake-'))
  actor = null; assert.equal((await status.GET()).status, 401)
  actor = {}; allowed = false; assert.equal((await status.GET()).status, 403)
})
test('incoming and phone-outgoing events use existing Green ingest', async () => {
  assert.equal((await hook(event())).status, 200)
  assert.equal(ingested[0][0].provider, 'green-api'); assert.equal(ingested[0][0].direction, 'incoming')
  assert.equal((await hook(event({ typeWebhook: 'outgoingMessageReceived' }))).status, 200)
  assert.equal(ingested[1][0].direction, 'outgoing'); assert.equal(calls.length, 0)
})
test('webhook auth, malformed input, instance, invalid chat and timestamp rejected before ingest', async () => {
  assert.equal((await hook(event(), 'wrong')).status, 401)
  for (const body of ['{', 'null', event({ instanceData: { idInstance: 999 } }), event({ senderData: { chatId: 'invalid' } }), event({ idMessage: '' }), event({ timestamp: -1 }), event({ timestamp: 1e20 })]) assert.equal((await hook(body)).status, 400)
  assert.equal((await hook(' '.repeat(256 * 1024 + 1))).status, 413)
  assert.equal(ingested.length, 0); assert.equal(calls.length, 0)
})
test('webhook incoming media rejects foreign hosts and accepts Green storage', async () => {
  const media = url => event({ messageData: { typeMessage: 'audioMessage', fileMessageData: { downloadUrl: url, fileName: 'audio.ogg' } } })
  assert.equal((await hook(media('https://evil.example/audio.ogg'))).status, 400)
  assert.equal((await hook(media('https://api.green-api.com.evil.example/audio.ogg'))).status, 400)
  assert.equal((await hook(media('https://sw-media.green-api.com/audio.ogg'))).status, 200)
  assert.equal(ingested[0][0].attachments[0].type, 'audioMessage')
})
test('real Green storage accepts only the exact observed DigitalOcean host', async () => {
  const media = downloadUrl => event({ messageData: { typeMessage: 'imageMessage', fileMessageData: { downloadUrl, fileName: 'image.jpg' } } })
  const host = 'do-media-7107.fra1.digitaloceanspaces.com'
  for (const url of [
    'https://do-media-7108.fra1.digitaloceanspaces.com/image.jpg',
    'https://do-media-7107.ams3.digitaloceanspaces.com/image.jpg',
    `https://${host}.evil.example/image.jpg`, `https://evil.${host}/image.jpg`,
    `https://${host}@evil.example/image.jpg`, `https://user:pass@${host}/image.jpg`,
    `http://${host}/image.jpg`, `https://${host}:8443/image.jpg`,
    'https://127.0.0.1/image.jpg',
  ]) assert.equal((await hook(media(url))).status, 400)
  assert.equal(ingested.length, 0); assert.equal(calls.length, 0)
  const body = media(`https://${host}/mock-instance/image.jpg`)
  assert.equal((await hook(body, 'wrong')).status, 401)
  delete process.env.GREEN_API_WEBHOOK_TOKEN
  assert.equal((await hook(body)).status, 401)
  process.env.GREEN_API_WEBHOOK_TOKEN = 'fake-hook-secret'
  assert.equal((await hook({ ...body, instanceData: { idInstance: 999 } })).status, 400)
  assert.equal(ingested.length, 0); assert.equal(updates.length, 0)
  assert.equal((await hook(body)).status, 200)
  assert.deepEqual(ingested[0][0].attachments, [{ type: 'imageMessage', url: body.messageData.fileMessageData.downloadUrl, name: 'image.jpg' }])
  assert.equal(calls.length, 0)
})
test('trusted group messages and statuses are acknowledged without DB or backend work', async () => {
  for (const chatId of ['120363123456789@g.us', '123456789-123456789@g.us']) {
    for (const typeWebhook of ['incomingMessageReceived', 'outgoingMessageReceived', 'outgoingMessageStatus']) {
      const body = event({ typeWebhook, chatId, status: 'read', senderData: { chatId } })
      assert.equal((await hook(body, 'wrong')).status, 401)
      assert.equal((await hook({ ...body, instanceData: { idInstance: 999 } })).status, 400)
      const response = await hook(body)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, ignored: true })
    }
  }
  assert.equal(ingested.length, 0); assert.equal(updates.length, 0)
  assert.equal(filters.length, 0); assert.equal(calls.length, 0)
})
test('status forwards provider and protected backend key, never ingests a new message', async () => {
  for (const status of ['sent', 'delivered', 'read', 'failed', 'noAccount']) {
    assert.equal((await hook(event({ typeWebhook: 'outgoingMessageStatus', chatId: '996000000000@c.us', status }))).status, 200)
    assert.deepEqual(calls.at(-1).body, { message_id: 'green.message:1-2_3', status: status === 'noAccount' ? 'failed' : status, provider: 'green_api' })
    assert.equal(calls.at(-1).options.headers['X-Admin-API-Key'], 'fake-backend-key')
    assert.equal(calls.at(-1).url, 'https://backend.example/admin/crm/whatsapp-status')
  }
  assert.equal(ingested.length, 0)
})
test('status sync failure is retryable and unknown status ignored', async () => {
  const body = event({ typeWebhook: 'outgoingMessageStatus', chatId: '996000000000@c.us', status: 'read' })
  global.fetch = async () => Response.json({}, { status: 500 })
  assert.equal((await hook(body)).status, 502)
  dbFails = true; assert.equal((await hook(body)).status, 502)
  assert.equal((await hook({ ...body, status: 'pending' })).status, 200)
})
test('LID statuses sync without widening incoming or manager message recipients', async () => {
  for (const status of ['sent', 'delivered', 'read', 'failed', 'noAccount']) {
    assert.equal((await hook(event({ typeWebhook: 'outgoingMessageStatus', chatId: '10000000000001@lid', status }))).status, 200)
    assert.deepEqual(calls.at(-1).body, { message_id: 'green.message:1-2_3', status: status === 'noAccount' ? 'failed' : status, provider: 'green_api' })
  }
  const synced = calls.length
  for (const chatId of ['status@broadcast', 'abc@lid', '@lid', '1'.repeat(21) + '@lid']) {
    assert.equal((await hook(event({ typeWebhook: 'outgoingMessageStatus', chatId, status: 'read' }))).status, 400)
  }
  for (const typeWebhook of ['incomingMessageReceived', 'outgoingMessageReceived']) {
    assert.equal((await hook(event({ typeWebhook, senderData: { chatId: '10000000000001@lid' } }))).status, 400)
  }
  assert.equal(calls.length, synced); assert.equal(ingested.length, 0)
})
test('status DB update is tenant/channel/direction/id scoped and blocks regression', async () => {
  await hook(event({ typeWebhook: 'outgoingMessageStatus', chatId: '996000000000@c.us', status: 'sent' }))
  assert.deepEqual(filters, [['company_id', '00000000-0000-0000-0000-000000000001'], ['channel', 'whatsapp'], ['direction', 'outgoing'], ['external_id', 'green.message:1-2_3']])
  assert.deepEqual(previousStatuses, ['queued', 'sent'])
})
test('webhook rejects chunked overflow without content-length', async () => {
  let cancelled = false
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(70000)) }, cancel() { cancelled = true } })
  const request = new Request('http://localhost/hook', { method: 'POST', body: stream, duplex: 'half' })
  const result = await webhook.POST(request, { params: Promise.resolve({ token: 'fake-hook-secret' }) })
  assert.equal(result.status, 413); assert.equal(cancelled, true); assert.equal(ingested.length, 0)
})
test('missing webhook secret fails closed and ingest failures return retryable response', async () => {
  delete process.env.GREEN_API_WEBHOOK_TOKEN
  assert.equal((await hook(event())).status, 401)
  process.env.GREEN_API_WEBHOOK_TOKEN = 'fake-hook-secret'; ingestFails = true
  assert.equal((await hook(event())).status, 502)
})
test('Green incoming and manager outgoing require backend configuration before ingest', async () => {
  for (const typeWebhook of ['incomingMessageReceived', 'outgoingMessageReceived']) {
    for (const name of ['BOT_BACKEND_API_URL', 'BOT_BACKEND_ADMIN_API_KEY']) {
      const configured = process.env[name]
      for (const missing of [undefined, '']) {
        if (missing === undefined) delete process.env[name]
        else process.env[name] = missing
        const response = await hook(event({ typeWebhook }))
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { error: 'Bot backend is not configured' })
        assert.equal(ingested.length, 0); assert.equal(calls.length, 0)
      }
      process.env[name] = configured
    }
  }
})
