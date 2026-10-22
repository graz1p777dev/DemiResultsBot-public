import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { ingestChannelMessage } from '@/lib/crm-ingest'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

export const runtime = 'nodejs'
const Payload = z.object({
  typeWebhook: z.string().max(100),
  instanceData: z.object({ idInstance: z.union([z.string(), z.number()]) }).optional(),
  idMessage: z.string().min(1).max(255).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  timestamp: z.number().finite().nonnegative().max(8640000000000).optional(),
  chatId: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  senderData: z.object({ chatId: z.string().max(100), chatName: z.string().max(255).optional(), senderContactName: z.string().max(255).optional(), senderName: z.string().max(255).optional() }).optional(),
  messageData: z.object({
    typeMessage: z.string().max(100).optional(),
    textMessageData: z.object({ textMessage: z.string().max(20000) }).optional(),
    extendedTextMessageData: z.object({ text: z.string().max(20000).optional() }).optional(),
    fileMessageData: z.object({ downloadUrl: z.string().url().max(4096), caption: z.string().max(20000).optional(), fileName: z.string().max(255).optional() }).optional(),
  }).optional(),
})

async function readBody(request: Request) {
  const limit = 256 * 1024
  if (Number(request.headers.get('content-length')) > limit) throw new RangeError()
  const reader = request.body?.getReader()
  if (!reader) throw new SyntaxError()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new RangeError()
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const expected = process.env.GREEN_API_WEBHOOK_TOKEN
  const { token } = await params
  if (!expected || !safeEqual(token, expected)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let raw: unknown
  try { raw = await readBody(request) } catch (error) {
    return NextResponse.json({ error: 'Invalid body' }, { status: error instanceof RangeError ? 413 : 400 })
  }
  const parsed = Payload.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const body = parsed.data
  if (!process.env.GREEN_API_ID_INSTANCE || String(body.instanceData?.idInstance) !== process.env.GREEN_API_ID_INSTANCE) return NextResponse.json({ error: 'Invalid instance' }, { status: 400 })
  const webhookType = body.typeWebhook
  const eventChatId = webhookType === 'outgoingMessageStatus' ? body.chatId : body.senderData?.chatId
  if (/^\d+(?:-\d+)?@g\.us$/.test(eventChatId || '')) return NextResponse.json({ ok: true, ignored: true })
  if (webhookType === 'outgoingMessageStatus') {
    if (!body.idMessage || !/^(?:\d{8,15}@c\.us|\d{1,20}@lid)$/.test(body.chatId || '')) return NextResponse.json({ error: 'Invalid status payload' }, { status: 400 })
    const status = body.status === 'noAccount' ? 'failed' : body.status
    if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') return NextResponse.json({ ok: true, ignored: true })
    const previous = { sent: ['queued', 'sent'], delivered: ['queued', 'sent', 'delivered'], read: ['queued', 'sent', 'delivered', 'read'], failed: ['queued', 'sent', 'failed'] }
    try {
      const result = await createAdminClient().from('crm_messages').update({ status })
        .eq('company_id', '00000000-0000-0000-0000-000000000001').eq('channel', 'whatsapp').eq('direction', 'outgoing').eq('external_id', body.idMessage).in('status', previous[status])
      if (result.error) throw result.error
      const base = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, ''), key = process.env.BOT_BACKEND_ADMIN_API_KEY
      if (!base || !key) throw new Error('Backend status sync is not configured')
      const response = await fetch(`${base}/admin/crm/whatsapp-status`, { method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'X-Admin-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: body.idMessage, status, provider: 'green_api' }),
      })
      if (!response.ok) throw new Error('Status sync failed')
    } catch { return NextResponse.json({ error: 'Status sync failed' }, { status: 502 }) }
    return NextResponse.json({ ok: true })
  }
  const isIncoming = webhookType === 'incomingMessageReceived'
  const isManagerOutgoing = webhookType === 'outgoingMessageReceived'
  if (!isIncoming && !isManagerOutgoing) return NextResponse.json({ ok: true, ignored: true })
  const chatId = String(body.senderData?.chatId ?? '')
  if (!body.idMessage || !/^\d{8,15}@c\.us$/.test(chatId) || !body.messageData || body.timestamp === undefined) return NextResponse.json({ error: 'Invalid message payload' }, { status: 400 })
  const messageData = body.messageData ?? {}
  const file = messageData.fileMessageData
  const text = messageData.textMessageData?.textMessage
    ?? messageData.extendedTextMessageData?.text
    ?? file?.caption
    ?? null
  if (file) {
    const url = new URL(file.downloadUrl)
    const allowedHost = url.hostname === 'do-media-7107.fra1.digitaloceanspaces.com'
      || ['green-api.com', 'greenapi.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowedHost) return NextResponse.json({ error: 'Invalid attachment URL' }, { status: 400 })
  }
  if (!process.env.BOT_BACKEND_API_URL || !process.env.BOT_BACKEND_ADMIN_API_KEY) return NextResponse.json({ error: 'Bot backend is not configured' }, { status: 503 })
  try { await ingestChannelMessage({
    channel: 'whatsapp',
    provider: 'green-api',
    direction: isManagerOutgoing ? 'outgoing' : 'incoming',
    externalMessageId: String(body.idMessage ?? ''),
    externalConversationId: chatId,
    externalClientId: chatId,
    name: body.senderData?.chatName ?? body.senderData?.senderContactName ?? body.senderData?.senderName ?? null,
    phone: chatId,
    text,
    attachments: file?.downloadUrl ? [{ type: messageData.typeMessage ?? 'file', url: file.downloadUrl, name: file.fileName }] : [],
    occurredAt: new Date(body.timestamp * 1000).toISOString(),
  }) } catch { return NextResponse.json({ error: 'CRM ingest failed' }, { status: 502 }) }
  return NextResponse.json({ ok: true })
}
