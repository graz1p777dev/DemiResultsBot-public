export class WhatsAppProviderError extends Error {
  constructor(public status: number, message: string, public providerCode?: number) { super(message) }
}

export function whatsAppConfig() {
  const token = process.env.META_WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID
  const accountId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID
  const version = process.env.META_GRAPH_API_VERSION || 'v23.0'
  if (!token || !phoneId || !accountId || !/^\d+$/.test(phoneId) || !/^\d+$/.test(accountId) || !/^v\d+\.0$/.test(version)) return null
  return { token, phoneId, accountId, version }
}

export function whatsAppRecipient(value: string) {
  const recipient = value.replace(/@c\.us$/, '').replace(/^\+/, '')
  if (!/^\d{8,15}$/.test(recipient)) throw new WhatsAppProviderError(400, 'Нужен личный WhatsApp-номер с кодом страны')
  return recipient
}

export async function sendMetaWhatsApp(recipientId: string, text: string, audioUrl?: string, mediaType: 'audio' | 'image' = 'audio') {
  const config = whatsAppConfig()
  if (!config) throw new WhatsAppProviderError(503, 'Meta WhatsApp не подключён: нужны access token, Phone Number ID и WABA ID')
  const to = whatsAppRecipient(recipientId)
  const response = await fetch(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to,
      ...(audioUrl ? { type: mediaType, [mediaType]: { link: audioUrl, ...(mediaType === 'image' ? { caption: text.slice(0, 1024) } : {}) } } : { type: 'text', text: { preview_url: false, body: text } }),
    }),
  })
  const body = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { code?: number } }
  if (!response.ok) throw new WhatsAppProviderError(502, 'Meta WhatsApp не принял сообщение', body.error?.code)
  const messageId = body.messages?.[0]?.id
  if (typeof messageId !== 'string' || !messageId.startsWith('wamid.')) throw new WhatsAppProviderError(502, 'Meta не вернула идентификатор сообщения')
  return { messageId, recipient: to }
}

export async function downloadMetaWhatsAppMedia(mediaId: string) {
  const config = whatsAppConfig()
  if (!config) throw new WhatsAppProviderError(503, 'Meta WhatsApp не подключён')
  if (!/^\d{1,30}$/.test(mediaId)) throw new WhatsAppProviderError(400, 'Некорректное вложение')
  const headers = { Authorization: `Bearer ${config.token}` }
  const metadata = await fetch(`https://graph.facebook.com/${config.version}/${mediaId}?phone_number_id=${config.phoneId}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) })
  const body = await metadata.json().catch(() => ({})) as { url?: string; mime_type?: string; file_size?: number }
  if (!metadata.ok || !body.url) throw new WhatsAppProviderError(502, 'Не удалось получить вложение Meta')
  let url: URL
  try { url = new URL(body.url) } catch { throw new WhatsAppProviderError(502, 'Некорректный адрес вложения Meta') }
  const allowed = ['facebook.com', 'fbsbx.com', 'fbcdn.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new WhatsAppProviderError(502, 'Недопустимый адрес вложения Meta')
  const limit = 25 * 1024 * 1024
  if (body.file_size && body.file_size > limit) throw new WhatsAppProviderError(413, 'Вложение больше 25 МБ')
  const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok || !response.body) throw new WhatsAppProviderError(502, 'Не удалось скачать вложение Meta')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new WhatsAppProviderError(413, 'Вложение больше 25 МБ')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return { bytes: Buffer.concat(chunks), contentType: body.mime_type || 'application/octet-stream' }
}
