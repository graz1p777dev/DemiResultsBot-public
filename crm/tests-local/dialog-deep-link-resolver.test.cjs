const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Source contract only. Browser navigation is checked separately in the QA harness.
const source = fs.readFileSync(path.resolve(__dirname, '../src/app/dashboard/dialogs/page.tsx'), 'utf8')
const start = source.indexOf('// Telegram/deal links use an external lead ID')
const end = source.indexOf('useEffect(() => { bottomRef', start)
assert.ok(start >= 0 && end > start, 'dialog lead resolver exists')
const resolver = source.slice(start, end)

test('lead resolver does not rerun on the unread-list update before URL replacement', () => {
  assert.match(source, /router\.replace\(`\$\{pathname\}\?\$\{params\.toString\(\)\}`,[\s\S]*?setConvs\(prev => prev\.map\(item => item\.id === c\.id/)
  assert.match(resolver, /\},\s*\[requestedLead,\s*requestedClient,\s*requestedConversation,\s*loading,\s*linkRetry\]\)/)
})

test('resolver still checks loaded dialogs and retries after initial list loading', () => {
  assert.match(resolver, /convs\.find\(item => String\(item\.amocrm_lead_id\) === requestedLead\)/)
  assert.match(resolver, /if \(loading\) return/)
  assert.match(resolver, /\/admin\/conversations\/by-lead\/\$\{encodeURIComponent\(leadId\)\}/)
  assert.match(resolver, /String\(conversation\.amocrm_lead_id\) !== String\(leadId\)/)
})
