import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sendGreenWhatsApp, greenMediaUrl, GreenWhatsAppError } from '@/lib/green-whatsapp'
import { ingestChannelMessage } from '@/lib/crm-ingest'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Payload = z.object({
  channel: z.enum(['instagram', 'whatsapp']),
  recipientId: z.string().min(1).max(255),
  text: z.string().trim().min(1).max(2000),
  audioUrl: z.string().url().optional(),
  mediaType: z.enum(['audio', 'image']).optional(),
})

function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const internalToken = process.env.INTERNAL_NOTIFY_TOKEN
  const providedToken = request.headers.get('x-internal-token') ?? ''
  if (!internalToken || !safeEqual(providedToken, internalToken)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = Payload.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  if (parsed.data.channel === 'whatsapp') {
    try {
      if (parsed.data.audioUrl) greenMediaUrl(parsed.data.audioUrl)
      const sent = await sendGreenWhatsApp(parsed.data.recipientId, parsed.data.text, parsed.data.audioUrl, parsed.data.mediaType)
      try {
        await ingestChannelMessage({ channel: 'whatsapp', provider: 'green-api', direction: 'outgoing', status: 'queued',
          externalMessageId: sent.messageId, externalConversationId: `${sent.recipient}@c.us`, externalClientId: sent.recipient,
          phone: sent.recipient, text: parsed.data.text, occurredAt: new Date().toISOString(),
          attachments: parsed.data.audioUrl ? [{ type: parsed.data.mediaType || 'audio', url: parsed.data.audioUrl }] : [],
        }, { queueBot: false })
      } catch { console.error('[internal/channel-send] Green accepted message but CRM persistence failed', sent.messageId) }
      return NextResponse.json({ ok: true, provider: sent.provider, messageId: sent.messageId, status: sent.status })
    } catch (error) {
      if (error instanceof GreenWhatsAppError) return NextResponse.json({ error: error.message }, { status: error.status })
      console.error('[internal/channel-send] Green WhatsApp transport failed')
      return NextResponse.json({ error: 'Green API временно недоступен' }, { status: 502 })
    }
  }

  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID
  if (!accessToken || !accountId) {
    return NextResponse.json({ error: 'Instagram is not configured' }, { status: 503 })
  }

  const response = await fetch(`https://graph.instagram.com/v23.0/${encodeURIComponent(accountId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: parsed.data.recipientId },
      message: { text: parsed.data.text },
    }),
    cache: 'no-store',
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error('[internal/channel-send] Instagram rejected message', response.status)
    return NextResponse.json({ error: 'Instagram rejected message' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, messageId: result.message_id ?? null })
}
