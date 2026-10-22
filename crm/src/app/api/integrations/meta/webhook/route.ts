import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { ingestChannelMessage } from '@/lib/crm-ingest'
import { createAdminClient } from '@/lib/supabase/admin'
import { whatsAppConfig } from '@/lib/meta-whatsapp'
import { z } from 'zod'

const Media = z.object({ id: z.string().regex(/^\d{1,30}$/), caption: z.string().optional(), filename: z.string().optional() })
const WhatsAppPayload = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({ id: z.string(), changes: z.array(z.object({ field: z.string(), value: z.object({
    metadata: z.object({ phone_number_id: z.string() }),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
    messages: z.array(z.object({ id: z.string().min(1).max(255), from: z.string().regex(/^\d{8,15}$/), timestamp: z.string().regex(/^\d{1,12}$/), type: z.string(),
      text: z.object({ body: z.string() }).optional(), audio: Media.optional(), image: Media.optional(), video: Media.optional(), document: Media.optional(), sticker: Media.optional(),
      button: z.object({ text: z.string() }).optional(), interactive: z.object({ button_reply: z.object({ title: z.string() }).optional(), list_reply: z.object({ title: z.string() }).optional() }).optional(),
    })).max(100).optional(),
    statuses: z.array(z.object({ id: z.string().min(1).max(255), status: z.enum(['sent', 'delivered', 'read', 'failed']) })).max(100).optional(),
  }) })).max(100) })).max(100),
})

async function receiveWhatsApp(payload: unknown) {
  const config = whatsAppConfig()
  if (!config) return NextResponse.json({ error: 'Meta WhatsApp is not configured' }, { status: 503 })
  const parsed = WhatsAppPayload.safeParse(payload)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid WhatsApp payload' }, { status: 400 })
  for (const entry of parsed.data.entry) {
    if (entry.id !== config.accountId) continue
    for (const change of entry.changes) {
      if (change.field !== 'messages' || change.value.metadata.phone_number_id !== config.phoneId) continue
      for (const message of change.value.messages ?? []) {
        const media = message.audio || message.image || message.video || message.document || message.sticker
        const name = change.value.contacts?.find(contact => contact.wa_id === message.from)?.profile?.name
        const occurredAt = new Date(Number(message.timestamp) * 1000)
        if (!Number.isFinite(occurredAt.getTime())) return NextResponse.json({ error: 'Invalid timestamp' }, { status: 400 })
        await ingestChannelMessage({ channel: 'whatsapp', provider: 'meta', externalMessageId: message.id,
          externalConversationId: `${message.from}@c.us`, externalClientId: message.from, phone: message.from, name,
          text: message.text?.body || media?.caption || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || (media ? null : `[${message.type}]`),
          attachments: media ? [{ type: message.type, mediaId: media.id, name: media.filename }] : [], occurredAt: occurredAt.toISOString(),
        })
      }
      for (const status of change.value.statuses ?? []) {
        const previous = { sent: ['queued', 'sent'], delivered: ['queued', 'sent', 'delivered'], read: ['queued', 'sent', 'delivered', 'read'], failed: ['queued', 'sent', 'failed'] }
        const result = await createAdminClient().from('crm_messages').update({ status: status.status })
          .eq('company_id', '00000000-0000-0000-0000-000000000001').eq('channel', 'whatsapp').eq('direction', 'outgoing').eq('external_id', status.id).in('status', previous[status.status])
        if (result.error) throw result.error
        const base = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, ''), key = process.env.BOT_BACKEND_ADMIN_API_KEY
        if (!base || !key) throw new Error('Backend status sync is not configured')
        const response = await fetch(`${base}/admin/crm/whatsapp-status`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000),
          headers: { 'X-Admin-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: status.id, status: status.status }),
        })
        if (!response.ok) throw new Error('Backend status sync failed')
      }
    }
  }
  return NextResponse.json({ ok: true })
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  if (process.env.META_WEBHOOK_VERIFY_TOKEN && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(params.get('hub.challenge') ?? '', { status: 200 })
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

export async function POST(request: NextRequest) {
  const raw = await request.text()
  if (Buffer.byteLength(raw) > 1024 * 1024) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  const secret = process.env.META_APP_SECRET
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  if (!secret || !signature.startsWith('sha256=')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let payload
  try { payload = JSON.parse(raw) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!payload || typeof payload !== 'object') return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  if (payload.object === 'whatsapp_business_account') return receiveWhatsApp(payload)
  // Facebook Messenger is not a CRM channel; keep Instagram behavior separate.
  if (payload.object !== 'instagram') return NextResponse.json({ error: 'Unsupported channel' }, { status: 400 })
  const channel = 'instagram' as const
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (!event.message?.mid) continue
      const isOutgoing = Boolean(event.message.is_echo)
      const externalClientId = String(isOutgoing ? event.recipient?.id ?? '' : event.sender?.id ?? '')
      await ingestChannelMessage({
        channel,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        externalMessageId: String(event.message.mid),
        externalConversationId: externalClientId,
        externalClientId,
        text: event.message.text ?? null,
        attachments: (event.message.attachments ?? []).map((item: { type?: string; payload?: { url?: string } }) => ({
          type: item.type ?? 'file', url: item.payload?.url,
        })),
        occurredAt: new Date(Number(event.timestamp ?? Date.now())).toISOString(),
      })
    }
  }
  return NextResponse.json({ ok: true })
}
