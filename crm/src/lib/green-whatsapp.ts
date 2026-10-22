export class GreenWhatsAppError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function greenWhatsAppConfig() {
  const base = process.env.GREEN_API_URL
  const id = process.env.GREEN_API_ID_INSTANCE
  const token = process.env.GREEN_API_TOKEN_INSTANCE
  if (!base || !id || !token || !/^\d+$/.test(id) || !/^[a-zA-Z0-9_-]+$/.test(token)) return null
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.port && url.port !== '443')) return null
    if (!['green-api.com', 'greenapi.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null
    return { base: url.origin, id, token }
  } catch { return null }
}

export function greenRecipient(value: string) {
  const recipient = value.replace(/@c\.us$/, '').replace(/^\+/, '')
  if (!/^\d{8,15}$/.test(recipient)) throw new GreenWhatsAppError(400, 'Нужен личный WhatsApp-номер с кодом страны')
  return recipient
}

export function greenMediaUrl(value: string) {
  try {
    const url = new URL(value)
    const origins = [process.env.BOT_BACKEND_API_URL, process.env.BOT_BACKEND_PUBLIC_URL || 'https://api-crm.example.invalid']
      .filter((item): item is string => Boolean(item)).map(item => new URL(item).origin)
    if (url.protocol !== 'https:' || !origins.includes(url.origin) || !/^\/media\/[a-zA-Z0-9_.-]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error()
    return url
  } catch { throw new GreenWhatsAppError(400, 'Invalid media URL') }
}

export async function sendGreenWhatsApp(recipientId: string, text: string, mediaUrl?: string, mediaType: 'audio' | 'image' = 'audio') {
  const config = greenWhatsAppConfig()
  if (!config) throw new GreenWhatsAppError(503, 'Green API не настроен')
  const recipient = greenRecipient(recipientId)
  const media = mediaUrl ? greenMediaUrl(mediaUrl) : null
  const fileName = media?.pathname.split('/').pop()
  if (media && !/\.[a-zA-Z0-9]+$/.test(fileName || '')) throw new GreenWhatsAppError(400, 'Media filename needs an extension')
  let resolution: Response
  try {
    resolution = await fetch(`${config.base}/waInstance${config.id}/checkWhatsapp/${config.token}`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: `${recipient}@c.us`, force: true }),
    })
  } catch { throw new GreenWhatsAppError(502, 'Green API временно недоступен') }
  const resolved = await resolution.json().catch(() => null) as { existsWhatsapp?: unknown, chatId?: unknown } | null
  if (!resolution.ok || resolved?.existsWhatsapp !== true || typeof resolved.chatId !== 'string' || !/^(?:\d{8,15}@c\.us|\d{1,20}@lid)$/.test(resolved.chatId)) throw new GreenWhatsAppError(502, 'Green API не подтвердил личного получателя')
  const providerChatId = resolved.chatId
  let response: Response
  try {
    response = await fetch(`${config.base}/waInstance${config.id}/${media ? 'sendFileByUrl' : 'sendMessage'}/${config.token}`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: providerChatId, ...(media ? { urlFile: media.href, fileName, ...(mediaType === 'image' ? { caption: text } : {}) } : { message: text, linkPreview: false }) }),
    })
  } catch { throw new GreenWhatsAppError(502, 'Green API временно недоступен') }
  const body = await response.json().catch(() => null) as { idMessage?: unknown } | null
  if (!response.ok || typeof body?.idMessage !== 'string' || !/^[A-Za-z0-9._:-]{1,255}$/.test(body.idMessage)) throw new GreenWhatsAppError(502, 'Green API не принял сообщение')
  return { provider: 'green_api' as const, messageId: body.idMessage, status: 'queued' as const, recipient, providerChatId }
}
