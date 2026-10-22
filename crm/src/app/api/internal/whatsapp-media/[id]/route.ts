import { timingSafeEqual } from 'node:crypto'
import { downloadMetaWhatsAppMedia, WhatsAppProviderError } from '@/lib/meta-whatsapp'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const expected = process.env.INTERNAL_NOTIFY_TOKEN
  const provided = request.headers.get('x-internal-token') || ''
  if (!expected || Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return Response.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const { id } = await params
    const media = await downloadMetaWhatsAppMedia(id)
    return new Response(new Uint8Array(media.bytes), { headers: { 'Content-Type': media.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch (error) {
    if (error instanceof WhatsAppProviderError) return Response.json({ error: error.message }, { status: error.status })
    return Response.json({ error: 'Не удалось получить вложение' }, { status: 502 })
  }
}
