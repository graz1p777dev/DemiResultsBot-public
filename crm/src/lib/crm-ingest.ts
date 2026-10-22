import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { notify } from '@/lib/notifications/notify'

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'
type Channel = 'whatsapp' | 'instagram' | 'facebook' | 'telegram'

export interface IncomingChannelMessage {
  channel: Channel
  provider?: 'meta' | 'green-api'
  status?: 'queued' | 'sent'
  direction?: 'incoming' | 'outgoing'
  externalMessageId: string
  externalConversationId: string
  externalClientId: string
  name?: string | null
  username?: string | null
  phone?: string | null
  text?: string | null
  attachments?: Array<{ type: string; url?: string; name?: string; mediaId?: string }>
  occurredAt: string
}

function digits(value?: string | null) {
  const normalized = (value ?? '').replace(/\D/g, '')
  return normalized || null
}

function stableNumericId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return String(8_000_000_000_000 + Number.parseInt(hex, 16) % 900_000_000_000)
}

async function queueBotProcessing(input: IncomingChannelMessage, client: { id: string; first_name?: string | null }, conversationId: string): Promise<string | null> {
  const base = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, '')
  const key = process.env.BOT_BACKEND_ADMIN_API_KEY
  if (!base || !key || !['whatsapp', 'instagram'].includes(input.channel)) return null

  const firstAttachment = input.attachments?.[0]
  const rawAttachmentType = (firstAttachment?.type || '').toLowerCase()
  const attachmentType = rawAttachmentType.includes('image') || rawAttachmentType === 'photo'
    ? 'picture'
    : rawAttachmentType.includes('audio') || rawAttachmentType.includes('voice')
      ? 'voice'
      : firstAttachment?.type || null
  const response = await fetch(`${base}/admin/crm/incoming`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-API-Key': key,
    },
    body: JSON.stringify({
      text: input.text || '',
      direction: input.direction ?? 'incoming',
      chat_id: input.externalConversationId,
      message_id: `${input.channel}:${input.externalMessageId || stableNumericId(`${input.externalConversationId}:${input.occurredAt}`)}`,
      client_id: `${input.channel}:${input.externalClientId || client.id}`,
      client_name: input.name || client.first_name || input.phone || input.username || '',
      lead_id: stableNumericId(`${input.channel}:${conversationId}`),
      contact_id: input.phone || input.externalClientId || null,
      source: input.channel === 'whatsapp' ? (input.provider === 'meta' ? 'whatsapp_meta' : 'whatsapp_green') : 'instagram_meta',
      media: firstAttachment?.mediaId ? `meta-whatsapp:${firstAttachment.mediaId}` : firstAttachment?.url || null,
      attachment_type: attachmentType,
      attachment_link: firstAttachment?.mediaId ? `meta-whatsapp:${firstAttachment.mediaId}` : firstAttachment?.url || null,
      timestamp: input.occurredAt,
      raw: {
        channel: input.channel,
        conversation_id: conversationId,
        external_conversation_id: input.externalConversationId,
        external_message_id: input.externalMessageId,
      },
    }),
  })
  if (!response.ok) throw new Error(`Bot backend rejected CRM message: HTTP ${response.status}`)
  const result = await response.json().catch(() => null) as { lead_id?: string | number } | null
  return result?.lead_id ? String(result.lead_id) : null
}

export async function ingestChannelMessage(input: IncomingChannelMessage, options: { queueBot?: boolean } = {}) {
  input = { ...input, name: input.name?.trim() || null,
    username: input.username?.trim() || null, phone: input.phone?.trim() || null }
  const admin = createAdminClient()
  const isOutgoing = input.direction === 'outgoing'
  const idColumn = `${input.channel}_id` as 'whatsapp_id' | 'instagram_id' | 'facebook_id' | 'telegram_id'
  const phone = digits(input.phone)

  let clientQuery = admin.from('crm_clients').select('*').eq('company_id', COMPANY_ID).is('deleted_at', null).is('merged_into_id', null)
  clientQuery = phone
    ? clientQuery.or(`${idColumn}.eq.${input.externalClientId},phone_normalized.eq.${phone}`)
    : clientQuery.eq(idColumn, input.externalClientId)
  let { data: client } = await clientQuery.limit(1).maybeSingle()

  if (!client) {
    const values: Record<string, unknown> = {
      company_id: COMPANY_ID,
      first_name: input.name || null,
      phone: phone,
      phone_normalized: phone,
      [idColumn]: input.externalClientId,
    }
    if (input.channel === 'instagram') values.instagram_username = input.username || null
    if (input.channel === 'telegram') values.telegram_username = input.username || null
    const created = await admin.from('crm_clients').insert(values).select('*').single()
    if (created.error) {
      // Concurrent delivery can create the same identity first; select it again.
      const retry = await admin.from('crm_clients').select('*')
        .eq('company_id', COMPANY_ID).eq(idColumn, input.externalClientId).is('deleted_at', null).maybeSingle()
      if (!retry.data) throw created.error
      client = retry.data
    } else client = created.data
  } else {
    const patch: Record<string, unknown> = {}
    if (!client[idColumn]) patch[idColumn] = input.externalClientId
    if (!client.phone_normalized && phone) Object.assign(patch, { phone, phone_normalized: phone })
    if (!client.first_name && input.name) patch.first_name = input.name
    if (Object.keys(patch).length) await admin.from('crm_clients').update(patch).eq('id', client.id)
  }

  const existingConversation = await admin.from('crm_conversations').select('id, unread_count, responsible_employee_id')
    .eq('company_id', COMPANY_ID).eq('channel', input.channel)
    .eq('external_id', input.externalConversationId).maybeSingle()
  let conversation: { id: string; unread_count: number | null; responsible_employee_id: string | null } | null = existingConversation.data
  const isNewConversation = !conversation
  if (!conversation) {
    const created = await admin.from('crm_conversations').insert({
      company_id: COMPANY_ID,
      client_id: client.id,
      channel: input.channel,
      external_id: input.externalConversationId,
      last_message_at: input.occurredAt,
      unread_count: isOutgoing ? 0 : 1,
    }).select('id, unread_count, responsible_employee_id').single()
    if (created.error) throw created.error
    conversation = created.data
  }
  if (!conversation) throw new Error('Не удалось определить беседу')

  // Каждое новое обращение из подключённого канала должно быть видно не
  // только во входящих диалогах, но и на доске сделок. Создаём одну активную
  // сделку на беседу; повторные webhook-доставки не дублируют её.
  const externalKey = `${input.channel}:${input.externalConversationId}`
  const existingDeal = await admin.from('deals').select('id')
    .eq('company_id', COMPANY_ID).eq('external_key', externalKey).is('deleted_at', null).maybeSingle()
  let dealId = existingDeal.data?.id ?? null
  if (!dealId) {
    const { data: unsortedStage } = await admin.from('deal_stages')
      .select('id').eq('company_id', COMPANY_ID).eq('pipeline_id', '10000000-0000-0000-0000-000000000001')
      .eq('name', 'Неразобранное').maybeSingle()
    const stageId = unsortedStage?.id ?? (await admin.from('deal_stages').select('id')
      .eq('company_id', COMPANY_ID).eq('pipeline_id', '10000000-0000-0000-0000-000000000001')
      .eq('is_default', true).maybeSingle()).data?.id
    if (!stageId) throw new Error('Не найден этап для новой сделки')
    const { data: createdDeal, error: dealError } = await admin.from('deals').insert({
      company_id: COMPANY_ID,
      pipeline_id: '10000000-0000-0000-0000-000000000001',
      stage_id: stageId,
      title: input.name || input.phone || input.username || `Новый клиент ${input.channel}`,
      customer_name: input.name || input.username || null,
      customer_phone: phone,
      customer_username: input.username || null,
      source: input.channel,
      external_key: externalKey,
      amocrm_lead_id: null,
      client_id: client.id,
      status: 'open',
      currency: 'KGS',
      created_at: input.occurredAt,
      updated_at: input.occurredAt,
      stage_changed_at: input.occurredAt,
    }).select('id').single()
    if (dealError && dealError.code !== '23505') throw dealError
    dealId = createdDeal?.id ?? null
  }

  const message = await admin.from('crm_messages').upsert({
    company_id: COMPANY_ID,
    conversation_id: conversation.id,
    client_id: client.id,
    external_id: input.externalMessageId,
    channel: input.channel,
    direction: isOutgoing ? 'outgoing' : 'incoming',
    // The database uses `employee` for a human CRM author. `manager` is not a
    // valid sender_type and made imported outbound messages fail the CHECK.
    sender_type: isOutgoing ? 'employee' : 'client',
    text: input.text || null,
    attachments: input.attachments ?? [],
    status: isOutgoing ? input.status ?? 'sent' : 'received',
    occurred_at: input.occurredAt,
  }, { onConflict: 'company_id,channel,external_id', ignoreDuplicates: true }).select('id')
  if (message.error) throw message.error

  await admin.from('crm_conversations').update({
    client_id: client.id,
    last_message_at: input.occurredAt,
    ...(isNewConversation || isOutgoing ? {} : { unread_count: 1 }),
  }).eq('id', conversation.id)

  if (!isOutgoing) {
    await admin.from('crm_inbox_items').upsert({
      company_id: COMPANY_ID,
      conversation_id: conversation.id,
      client_id: client.id,
      status: 'unprocessed',
      last_message_text: input.text || (input.attachments?.length ? 'Вложение' : ''),
      received_at: input.occurredAt,
    }, { onConflict: 'conversation_id' })
  }

  const botLeadId = options.queueBot === false ? null : await queueBotProcessing(input, client, conversation.id)
  // This legacy-named column is the durable cross-service link to the bot
  // lead. It is never exposed as amoCRM in the UI.
  if (botLeadId && dealId) {
    await admin.from('deals').update({ amocrm_lead_id: botLeadId }).eq('id', dealId)
  }

  // Notify the assigned manager; unassigned conversations are visible to all
  // active sales staff. Duplicate webhook deliveries do not create alerts.
  if (!isOutgoing && message.data?.length) {
    let employeeIds: string[] | undefined
    if (conversation.responsible_employee_id) {
      employeeIds = [conversation.responsible_employee_id]
    } else {
      const { data: staff } = await admin.from('employees').select('id').in('role', ['owner', 'rop', 'mp', 'lmai']).is('deleted_at', null)
      employeeIds = (staff ?? []).map(item => item.id as string)
    }
    await notify({
      type: 'system',
      title: `Новое сообщение в ${input.channel}`,
      body: input.text || (input.attachments?.length ? 'Входящее вложение' : 'Новое обращение клиента'),
      actionUrl: `/dashboard/dialogs?conversation=${conversation.id}`,
      isImportant: isNewConversation,
      sourceType: 'crm_conversation',
      sourceId: String(conversation.id),
      employeeIds,
    })
  }

  return { clientId: client.id, conversationId: conversation.id, duplicate: false }
}
