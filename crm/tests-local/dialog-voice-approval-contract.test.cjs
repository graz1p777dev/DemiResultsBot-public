const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// These checks inspect source contracts. They do not mount React or exercise a browser.
const source = fs.readFileSync(path.resolve(__dirname, '../src/app/dashboard/dialogs/page.tsx'), 'utf8')
function section(start, end) {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, `Missing dialog section: ${start}`)
  return source.slice(first, last)
}

test('AI edit prepares a preview with original snapshot and leaves send to explicit accept', () => {
  const edit = section('const editApprovalWithAi =', 'const discardApprovalEdit =')
  assert.match(edit, /\/edit-preview`, 'POST', \{ reply: approvalEdit\.text\.trim\(\), prompt: aiEditPrompt\.trim\(\), expected_current: approvalEdit\.original \}/)
  assert.match(edit, /proposalRef\.current = proposal/)
  assert.match(edit, /setApprovalEdit\(current => current && current\.id === message\.approval_id \? \{ \.\.\.current, text: result\.edited_reply \}/)
  assert.doesNotMatch(edit, /\/accept`|\/approve`|\/messages`/)
})

test('confirm accepts the displayed proposal, and manual changes request a fresh snapshot preview', () => {
  const decide = section('const decideApproval =', 'const editApprovalWithAi =')
  assert.match(decide, /proposal\?\.id !== message\.approval_id \|\| proposal\.text !== reply/)
  assert.match(decide, /\/edit-preview`, 'POST', \{ reply, expected_current: expectedCurrent \}/)
  assert.match(decide, /preview\.edited_reply !== reply/)
  assert.match(decide, /\/edit-preview\/\$\{encodeURIComponent\(proposal\.token\)\}\/accept`, 'POST'/)
  assert.doesNotMatch(decide, /\/admin\/approvals\/\$\{message\.approval_id\}\/approve`/)
  assert.match(source, /onChange=\{event => \{ invalidateProposal\(\); setApprovalEdit\(\{ \.\.\.editing, text: event\.target\.value \}\) \}\}/)
})

test('accept takes ownership of the matching proposal before its network await', () => {
  const decide = section('const decideApproval =', 'const editApprovalWithAi =')
  assert.match(decide, /if \(proposalRef\.current\?\.token === proposal\.token\) \{\s*proposalRef\.current = null;\s*setApprovalProposal\(null\)\s*\}\s*await botJson\(`\/admin\/approvals\/\$\{proposal\.id\}\/edit-preview\/\$\{encodeURIComponent\(proposal\.token\)\}\/accept`, 'POST'\)/)
})

test('discarding a preview is distinct from rejecting the whole approval', () => {
  const discard = section('const discardApprovalEdit =', 'const dialogTags =')
  assert.match(discard, /\/edit-preview\/\$\{encodeURIComponent\(proposal\.token\)\}\/discard`, 'POST'/)
  assert.match(discard, /setApprovalEdit\(null\)/)
  assert.doesNotMatch(discard, /\/reject`|\/accept`|\/messages`/)
})

test('external lead deep link resolves beyond loaded page and verifies returned lead', () => {
  const links = section('// Telegram/deal links use an external lead ID', 'useEffect(() => { bottomRef')
  assert.match(links, /\/admin\/conversations\/by-lead\/\$\{encodeURIComponent\(leadId\)\}/)
  assert.match(links, /String\(conversation\.amocrm_lead_id\) !== String\(leadId\)/)
  assert.match(source, /params\.set\('lead', String\(c\.amocrm_lead_id\)\)/)
})

test('recorded customer voice is previewed locally before a separate send click', () => {
  const recording = section('const toggleRecording =', 'const appendDictation =')
  assert.match(recording, /setRecordedVoice\(new File/)
  assert.doesNotMatch(recording, /sendMedia\(/)
  assert.match(source, /<audio controls src=\{recordedVoiceUrl\}/)
  assert.match(source, /onClick=\{\(\) => void sendMedia\(recordedVoice\)\}/)
})
