'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can } from '@/lib/authz'
import { DEAL_COMPANY_ID, getDealAccess, getAccessibleDeal, canAssignDealResponsible } from '@/lib/deal-access'
import type { Deal, DealConversation, DealEmployee, DealPipeline, DealStage } from '@/types'
import { missingStageData } from '@/components/deals/deal-view'

const DEMI_COMPANY_ID = DEAL_COMPANY_ID

type Result<T = undefined> = T extends undefined
  ? { success: true } | { success: false; error: string }
  : { success: true; data: T } | { success: false; error: string }

async function requireDeals(action: 'view' | 'edit') {
  const actor = await getActor()
  if (!actor || !await can(actor, 'deals', action)) return null
  return actor
}

async function botAdminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, '')
  const key = process.env.BOT_BACKEND_ADMIN_API_KEY
  if (!base || !key) throw new Error('Интеграция с ботом не настроена')

  const response = await fetch(`${base}/admin${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-API-Key': key,
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `Бот вернул HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export async function getDealsData(pipelineCode?: 'new-sales' | 'repeat-sales'): Promise<{ pipelines: DealPipeline[]; stages: DealStage[]; deals: Deal[]; employees: DealEmployee[] }> {
  const access = await getDealAccess('view')
  if (!access) return { pipelines: [], stages: [], deals: [], employees: [] }
  const admin = createAdminClient()
  const [{ data: pipelines, error: pipelinesError }, { data: stages, error: stagesError }] = await Promise.all([
    admin.from('crm_pipelines').select('*').eq('company_id', DEMI_COMPANY_ID).eq('is_active', true).order('sort_order'),
    admin.from('deal_stages').select('*').eq('company_id', DEMI_COMPANY_ID).order('sort_order'),
  ])
  if (pipelinesError) throw new Error('Не удалось загрузить воронки')
  if (stagesError) throw new Error('Не удалось загрузить этапы сделок')
  const targetPipelineId = pipelineCode
    ? (pipelines ?? []).find(pipeline => pipeline.code === pipelineCode)?.id
    : undefined

  // Authorization is checked above. Use the server-only client for the large
  // board query so row-level visibility checks are not repeated for every deal.
  const deals: Deal[] = []
  // Fetch every authorized deal: board counts, search and stage columns all
  // depend on the complete pipeline, not just its most recently updated rows.
  const pageSize = 500
  for (let from = 0; ; from += pageSize) {
    let query = admin
      .from('deals')
      .select('*')
      .eq('company_id', DEMI_COMPANY_ID)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (pipelineCode) {
      if (!targetPipelineId) break
      query = query.eq('pipeline_id', targetPipelineId)
    }
    if (access.responsibleIds !== null) {
      query = access.allowUnassigned
        ? query.or(`responsible_employee_id.is.null,responsible_employee_id.in.(${access.responsibleIds.join(',')})`)
        : query.in('responsible_employee_id', access.responsibleIds)
    }
    const { data, error } = await query
    if (error) throw new Error('Не удалось загрузить сделки')
    deals.push(...((data ?? []) as Deal[]))
    if (!data || data.length < pageSize) break
  }
  // A deal card must show when an AI response is waiting for the manager.
  // If the bot is temporarily unavailable the board stays usable and simply
  // omits the status chip.
  try {
    const approvals = await botAdminFetch<{ items: Array<{ status: 'pending' | 'edited'; lead: { amocrm_lead_id: string } }> }>('/approvals?status=pending,edited&limit=200', {
      signal: AbortSignal.timeout(2500),
    })
    const statusByLead = new Map(approvals.items.map(item => [String(item.lead.amocrm_lead_id), item.status]))
    deals.forEach(deal => { deal.ai_approval_status = deal.amocrm_lead_id ? statusByLead.get(String(deal.amocrm_lead_id)) ?? null : null })
  } catch {
    // The badge is supplementary; never block the sales board for it.
  }
  const clientIds = Array.from(new Set(deals.map(deal => deal.client_id).filter((id): id is string => Boolean(id))))
  const dealIds = deals.map(deal => deal.id)
  // Bound URL sizes for PostgREST IN filters without truncating the deal list.
  const relatedPages = []
  for (let from = 0; from < Math.max(clientIds.length, dealIds.length); from += 50) {
    const pageClients = clientIds.slice(from, from + 50)
    const pageDeals = dealIds.slice(from, from + 50)
    const page = await Promise.all([
      pageClients.length ? admin.from('crm_clients').select('id, first_name, last_name, instagram_username, telegram_username, whatsapp_id').in('id', pageClients) : Promise.resolve({ data: [], error: null }),
      pageDeals.length ? admin.from('tasks').select('deal_id, due_date, status, priority').in('deal_id', pageDeals).neq('status', 'done') : Promise.resolve({ data: [], error: null }),
      pageClients.length ? admin.from('crm_client_tags').select('client_id, tag:crm_tags(id, name, color)').in('client_id', pageClients) : Promise.resolve({ data: [], error: null }),
      pageClients.length ? admin.from('crm_conversations').select('client_id, last_message_at').in('client_id', pageClients).order('last_message_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ])
    const enrichmentError = page.find(result => result.error)?.error
    if (enrichmentError) throw new Error('Не удалось загрузить данные клиентов и задач', { cause: enrichmentError })
    relatedPages.push(page)
  }
  const clients = relatedPages.flatMap(page => page[0].data ?? [])
  const taskRows = relatedPages.flatMap(page => page[1].data ?? [])
  const tagRows = relatedPages.flatMap(page => page[2].data ?? [])
  const conversations = relatedPages.flatMap(page => page[3].data ?? [])
  const clientById = new Map((clients ?? []).map(client => [client.id as string, client]))
  const tasksByDeal = new Map<string, Array<{ due_date: string | null; status: string; priority: string }>>()
  ;(taskRows ?? []).forEach(task => {
    const key = task.deal_id as string
    tasksByDeal.set(key, [...(tasksByDeal.get(key) ?? []), task as { due_date: string | null; status: string; priority: string }])
  })
  const tagsByClient = new Map<string, Array<{ id: string; name: string; color: string }>>()
  ;(tagRows ?? []).forEach(row => {
    const tag = row.tag as unknown as { id: string; name: string; color: string } | null
    if (tag) tagsByClient.set(row.client_id as string, [...(tagsByClient.get(row.client_id as string) ?? []), tag])
  })
  const lastMessageByClient = new Map<string, string>()
  ;(conversations ?? []).forEach(row => {
    if (row.client_id && row.last_message_at && !lastMessageByClient.has(row.client_id as string)) lastMessageByClient.set(row.client_id as string, row.last_message_at as string)
  })
  deals.forEach(deal => {
    const client = deal.client_id ? clientById.get(deal.client_id) : null
    const openTasks = tasksByDeal.get(deal.id) ?? []
    const dated = openTasks.map(task => task.due_date).filter((date): date is string => Boolean(date)).sort()
    deal.client_first_name = client?.first_name as string | null ?? null
    deal.client_last_name = client?.last_name as string | null ?? null
    deal.client_city = null
    deal.client_instagram_username = client?.instagram_username as string | null ?? null
    deal.client_telegram_username = client?.telegram_username as string | null ?? null
    deal.client_whatsapp_id = client?.whatsapp_id as string | null ?? null
    deal.tags = deal.client_id ? tagsByClient.get(deal.client_id) ?? [] : []
    deal.has_open_tasks = openTasks.length > 0
    deal.next_task_at = dated[0] ?? null
    deal.last_message_at = deal.client_id ? lastMessageByClient.get(deal.client_id) ?? null : null
    deal.is_urgent = Boolean(deal.is_urgent || openTasks.some(task => task.priority === 'urgent'))
  })
  const { data: employees } = await admin
    .from('employees')
    .select('id, name, crm_company_members!inner(company_id)')
    .eq('crm_company_members.company_id', DEMI_COMPANY_ID)
    .is('deleted_at', null)
    .neq('status', 'archived')
    .order('name')
  const employeeName = new Map((employees ?? []).map(employee => [employee.id as string, employee.name as string]))
  deals.forEach(deal => { deal.responsible_name = deal.responsible_employee_id ? employeeName.get(deal.responsible_employee_id) ?? null : null })
  return { pipelines: (pipelines ?? []) as DealPipeline[], stages: (stages ?? []) as DealStage[], deals, employees: (employees ?? []) as DealEmployee[] }
}

export async function getPipelineSettingsData(): Promise<{ pipelines: DealPipeline[]; stages: DealStage[] }> {
  const actor = await requireDeals('view')
  if (!actor || actor.role !== 'owner') return { pipelines: [], stages: [] }
  const admin = createAdminClient()
  const [{ data: pipelines, error: pipelinesError }, { data: stages, error: stagesError }] = await Promise.all([
    admin.from('crm_pipelines').select('*').eq('company_id', DEMI_COMPANY_ID).eq('is_active', true).order('sort_order'),
    admin.from('deal_stages').select('*').eq('company_id', DEMI_COMPANY_ID).order('sort_order'),
  ])
  if (pipelinesError || stagesError) throw new Error('Не удалось загрузить настройки воронок')
  return { pipelines: (pipelines ?? []) as DealPipeline[], stages: (stages ?? []) as DealStage[] }
}

export async function updateStageGuidance(stageId: string, guidance: string): Promise<Result<{ guidance: string | null }>> {
  const actor = await getActor()
  if (actor?.role !== 'owner') return { success: false, error: 'Настраивать подсказки этапов может только владелец' }
  const value = guidance.trim()
  if (value.length > 600) return { success: false, error: 'Подсказка не должна быть длиннее 600 символов' }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('deal_stages')
    .update({ guidance: value || null })
    .eq('id', stageId)
    .eq('company_id', DEMI_COMPANY_ID)
    .select('guidance')
    .maybeSingle()
  if (error || !data) return { success: false, error: 'Не удалось сохранить подсказку этапа' }
  revalidatePath('/dashboard/deals')
  return { success: true, data: { guidance: data.guidance as string | null } }
}

const REQUIRED_FIELDS = ['client', 'phone', 'amount', 'note', 'responsible'] as const
const CLOSING_RULES = ['amount', 'note', 'loss_reason'] as const

export interface StageConfigurationInput {
  id: string
  name: string
  color: string
  guidance: string
  requiredFields: string[]
  closingRules: string[]
}

export async function saveStageConfiguration(input: StageConfigurationInput): Promise<Result<DealStage>> {
  const actor = await getActor()
  if (actor?.role !== 'owner') return { success: false, error: 'Настраивать этапы может только владелец' }
  const name = input.name.trim()
  const guidance = input.guidance.trim()
  if (!name || name.length > 120) return { success: false, error: 'Название этапа должно содержать от 1 до 120 символов' }
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) return { success: false, error: 'Выберите цвет в формате #RRGGBB' }
  if (guidance.length > 600) return { success: false, error: 'Подсказка не должна быть длиннее 600 символов' }
  if (input.requiredFields.some(field => !REQUIRED_FIELDS.includes(field as typeof REQUIRED_FIELDS[number])) || input.closingRules.some(rule => !CLOSING_RULES.includes(rule as typeof CLOSING_RULES[number]))) return { success: false, error: 'Переданы недопустимые правила этапа' }
  const admin = createAdminClient()
  const { data, error } = await admin.from('deal_stages').update({ name, color: input.color, guidance: guidance || null, required_fields: input.requiredFields, closing_rules: input.closingRules }).eq('id', input.id).eq('company_id', DEMI_COMPANY_ID).select('*').maybeSingle()
  if (error || !data) return { success: false, error: 'Не удалось сохранить этап' }
  revalidatePath('/dashboard/deals'); revalidatePath('/dashboard/settings/pipelines')
  return { success: true, data: data as DealStage }
}

export async function reorderPipelineStages(pipelineId: string, stageIds: string[]): Promise<Result> {
  const actor = await getActor()
  if (actor?.role !== 'owner') return { success: false, error: 'Менять порядок этапов может только владелец' }
  const admin = createAdminClient()
  const { data: stages, error } = await admin.from('deal_stages').select('id').eq('company_id', DEMI_COMPANY_ID).eq('pipeline_id', pipelineId).order('sort_order')
  if (error || !stages || stages.length !== stageIds.length || new Set(stageIds).size !== stageIds.length || stages.some(stage => !stageIds.includes(stage.id))) return { success: false, error: 'Нельзя изменить состав этапов при перестановке' }
  for (const [index, id] of stageIds.entries()) {
    const { error: updateError } = await admin.from('deal_stages').update({ sort_order: (index + 1) * 10 }).eq('id', id).eq('pipeline_id', pipelineId)
    if (updateError) return { success: false, error: 'Не удалось сохранить порядок этапов' }
  }
  revalidatePath('/dashboard/deals'); revalidatePath('/dashboard/settings/pipelines')
  return { success: true }
}

export interface SaveDealInput {
  id?: string
  title: string
  stageId: string
  amount?: number | null
  customerName?: string | null
  customerPhone?: string | null
  responsibleEmployeeId?: string | null
  note?: string | null
  lossReasonCode?: string | null
  lossReasonNote?: string | null
}

export async function saveDeal(input: SaveDealInput): Promise<Result<{ id: string }>> {
  const access = await getDealAccess('edit')
  if (!access) return { success: false, error: 'Недостаточно прав' }
  const title = input.title.trim()
  if (!title) return { success: false, error: 'Укажите название сделки' }
  const admin = createAdminClient()
  const current = input.id ? await getAccessibleDeal(access, input.id) : null
  if (input.id && !current) return { success: false, error: 'Сделка не найдена' }
  if ((!current || current.responsible_employee_id !== (input.responsibleEmployeeId || null)) && !await canAssignDealResponsible(access, input.responsibleEmployeeId || null)) return { success: false, error: 'Недостаточно прав для назначения ответственного' }
  const { data: stage } = await admin.from('deal_stages').select('pipeline_id, company_id, kind, required_fields, closing_rules').eq('id', input.stageId).eq('company_id', DEMI_COMPANY_ID).maybeSingle()
  if (!stage) return { success: false, error: 'Этап сделки не найден' }
  if (current && current.pipeline_id !== stage.pipeline_id) return { success: false, error: 'Этап относится к другой воронке или компании' }
  const row = {
    title,
    stage_id: input.stageId,
    amount: input.amount ?? null,
    customer_name: input.customerName?.trim() || null,
    customer_phone: input.customerPhone?.trim() || null,
    responsible_employee_id: input.responsibleEmployeeId || null,
    note: input.note?.trim() || null,
    loss_reason_code: input.lossReasonCode?.trim() || null,
    loss_reason_note: input.lossReasonNote?.trim() || null,
  }
  try {
    if (input.id) {
      if (!current) return { success: false, error: 'Сделка не найдена' }
      let transition = {}
      if (current.stage_id !== input.stageId) {
        const missing = missingStageData({ ...current, ...row }, stage.required_fields ?? [], stage.closing_rules ?? [], stage.kind === 'won' || stage.kind === 'lost', row.loss_reason_code ?? current.loss_reason_code)
        if (missing.length) return { success: false, error: `Перед переходом заполните: ${missing.join(', ')}` }
        transition = {
          status: stage.kind === 'won' ? 'won' : stage.kind === 'lost' ? 'lost' : 'open',
          sale_at: stage.kind === 'won' ? new Date().toISOString() : null,
          last_synced_at: new Date().toISOString(),
        }
      }
      const { data: updated, error } = await admin.rpc('update_crm_deal', {
        p_actor: access.actor.employeeId, p_id: input.id, p_patch: { ...row, ...transition },
        p_expected_stage: current.stage_id, p_expected_responsible: current.responsible_employee_id,
      })
      if (error) throw error
      if (updated?.status === 404) return { success: false, error: 'Сделка не найдена' }
      if (updated?.status === 403) return { success: false, error: updated.error === 'assignment_forbidden' ? 'Недостаточно прав для назначения ответственного' : 'Недостаточно прав' }
      if (updated?.status === 409) return { success: false, error: 'Сделка изменилась, обновите страницу' }
      if (updated?.status !== 200) throw new Error('Deal update failed')
      revalidatePath('/dashboard/deals')
      return { success: true, data: { id: input.id } }
    }
    const { data, error } = await admin
      .from('deals')
      .insert({ ...row, pipeline_id: stage.pipeline_id, company_id: stage.company_id, source: 'manual', currency: 'KGS', status: stage.kind === 'won' ? 'won' : stage.kind === 'lost' ? 'lost' : 'open', sale_at: stage.kind === 'won' ? new Date().toISOString() : null })
      .select('id')
      .single()
    if (error) throw error
    revalidatePath('/dashboard/deals')
    return { success: true, data: { id: data.id } }
  } catch (error) {
    console.error('[saveDeal]', error)
    return { success: false, error: 'Не удалось сохранить сделку' }
  }
}

export async function deleteDeal(dealId: string): Promise<Result> {
  const access = await getDealAccess('edit')
  if (!access || access.actor.role !== 'owner') return { success: false, error: 'Удалять сделки может только владелец' }
  const admin = createAdminClient()
  const deal = await getAccessibleDeal(access, dealId)
  if (!deal) return { success: false, error: 'Сделка не найдена' }
  const { error } = await admin.from('deals').update({ deleted_at: new Date().toISOString() }).eq('id', dealId).eq('company_id', DEMI_COMPANY_ID).is('deleted_at', null)
  if (error) return { success: false, error: 'Не удалось удалить сделку' }
  revalidatePath('/dashboard/deals')
  return { success: true }
}

interface BotChatResponse {
  internal_lead_id: number
  ai_enabled: boolean
  client_name: string | null
  client_phone: string | null
  amocrm_url: string
  messages: Array<{
    id: string | number
    role: 'user' | 'assistant' | 'manager'
    speaker?: 'client' | 'bot' | 'manager' | null
    author_name?: string | null
    text: string
    status?: string | null
    created_at?: string | null
  }>
}

export async function getDealConversation(dealId: string): Promise<Result<DealConversation>> {
  const access = await getDealAccess('view')
  if (!access) return { success: false, error: 'Недостаточно прав' }
  const deal = await getAccessibleDeal(access, dealId)
  if (!deal?.amocrm_lead_id) return { success: false, error: 'У этой сделки пока нет связанного диалога' }
  try {
    const chat = await botAdminFetch<BotChatResponse>(`/chat/${deal.amocrm_lead_id}`)
    return {
      success: true,
      data: {
        internalLeadId: chat.internal_lead_id,
        aiEnabled: chat.ai_enabled,
        clientName: chat.client_name,
        clientPhone: chat.client_phone,
        amocrmUrl: chat.amocrm_url,
        messages: chat.messages.map(message => ({
          id: message.id,
          role: message.role,
          speaker: message.speaker ?? (message.role === 'user' ? 'client' : 'manager'),
          author_name: message.author_name ?? null,
          text: message.text,
          status: message.status ?? null,
          created_at: message.created_at ?? null,
        })),
      },
    }
  } catch (error) {
    console.error('[getDealConversation]', error)
    return { success: false, error: 'Не удалось загрузить диалог клиента' }
  }
}

export async function sendDealMessage(dealId: string, text: string): Promise<Result<{ aiDisabled: boolean }>> {
  if (!await getDealAccess('edit')) return { success: false, error: 'Недостаточно прав' }
  const value = text.trim()
  if (!value) return { success: false, error: 'Сообщение пустое' }
  const chat = await getDealConversation(dealId)
  if (!chat.success) return chat
  try {
    const response = await botAdminFetch<{ ai_disabled?: boolean }>(`/leads/${chat.data.internalLeadId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: value }),
    })
    return { success: true, data: { aiDisabled: Boolean(response.ai_disabled) } }
  } catch (error) {
    console.error('[sendDealMessage]', error)
    return { success: false, error: 'Сообщение не отправлено' }
  }
}

export async function setDealAiControl(dealId: string, enabled: boolean): Promise<Result> {
  if (!await getDealAccess('edit')) return { success: false, error: 'Недостаточно прав' }
  const chat = await getDealConversation(dealId)
  if (!chat.success) return chat
  try {
    await botAdminFetch(`/leads/${chat.data.internalLeadId}/ai`, {
      method: 'PATCH', body: JSON.stringify({ enabled }),
    })
    return { success: true }
  } catch (error) {
    console.error('[setDealAiControl]', error)
    return { success: false, error: 'Не удалось изменить режим AI' }
  }
}

export type DealCommerce = {
  orderNumber: number
  status: string
  paymentStatus: string
  paymentMethod: string
  deliveryStatus: string
  deliveryMethod: string
  address: string | null
  totalAmount: number
  items: Array<{ name: string; quantity: number; unitPrice: number; lineTotal: number }>
}

export async function getDealCommerce(dealId: string): Promise<Result<DealCommerce | null>> {
  const access = await getDealAccess('view')
  if (!access) return { success: false, error: 'Недостаточно прав' }
  if (!await getAccessibleDeal(access, dealId)) return { success: false, error: 'Сделка не найдена' }
  const admin = createAdminClient()
  const { data: order, error } = await admin.from('shop_orders')
    .select('id, order_number, status, payment_status, payment_method, delivery_status, delivery_method, address, total_amount')
    .eq('crm_deal_id', dealId).maybeSingle()
  if (error) return { success: false, error: 'Не удалось загрузить заказ магазина' }
  if (!order) return { success: true, data: null }
  const { data: items, error: itemsError } = await admin.from('shop_order_items')
    .select('product_name, quantity, unit_price, line_total').eq('order_id', order.id).order('product_name')
  if (itemsError) return { success: false, error: 'Не удалось загрузить товары заказа' }
  return { success: true, data: {
    orderNumber: Number(order.order_number), status: order.status,
    paymentStatus: order.payment_status, paymentMethod: order.payment_method,
    deliveryStatus: order.delivery_status, deliveryMethod: order.delivery_method,
    address: order.address, totalAmount: Number(order.total_amount),
    items: (items ?? []).map(item => ({ name: item.product_name, quantity: item.quantity,
      unitPrice: Number(item.unit_price), lineTotal: Number(item.line_total) })),
  } }
}

export async function syncDealsFromAmo(): Promise<Result<{ synced: number }>> {
  return { success: false, error: 'Внешний импорт отключён' }
}

export async function moveDeal(dealId: string, stageId: string, overrides?: Partial<Pick<Deal, 'customer_name' | 'customer_phone' | 'amount' | 'note' | 'responsible_employee_id'>> & { loss_reason_code?: string | null }): Promise<Result> {
  const access = await getDealAccess('edit')
  if (!access) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const [deal, { data: stage }] = await Promise.all([
    getAccessibleDeal(access, dealId),
    admin.from('deal_stages').select('id, company_id, pipeline_id, amocrm_pipeline_id, amocrm_status_id, kind, required_fields, closing_rules').eq('id', stageId).eq('company_id', DEMI_COMPANY_ID).maybeSingle(),
  ])
  if (!deal || !stage) return { success: false, error: 'Сделка или этап не найдены' }
  if (deal.company_id !== stage.company_id || deal.pipeline_id !== stage.pipeline_id) {
    return { success: false, error: 'Этап относится к другой воронке или компании' }
  }
  if (overrides?.responsible_employee_id !== undefined && overrides.responsible_employee_id !== deal.responsible_employee_id && !await canAssignDealResponsible(access, overrides.responsible_employee_id)) return { success: false, error: 'Недостаточно прав для назначения ответственного' }
  if (deal.stage_id === stageId) return { success: true }

  const missing = missingStageData({ ...deal, ...overrides }, stage.required_fields ?? [], stage.closing_rules ?? [], stage.kind === 'won' || stage.kind === 'lost', overrides?.loss_reason_code ?? deal.loss_reason_code)
  if (missing.length) return { success: false, error: `Перед переходом заполните: ${missing.join(', ')}` }

  try {
    const isWon = stage.kind === 'won'
    const isLost = stage.kind === 'lost'
    const { data: updated, error } = await admin.rpc('update_crm_deal', {
      p_actor: access.actor.employeeId, p_id: dealId,
      p_expected_stage: deal.stage_id, p_expected_responsible: deal.responsible_employee_id,
      p_patch: {
        stage_id: stageId,
        status: isWon ? 'won' : isLost ? 'lost' : 'open',
        sale_at: isWon ? new Date().toISOString() : null,
        last_synced_at: new Date().toISOString(),
      },
    })
    if (error) throw error
    if (updated?.status === 404) return { success: false, error: 'Сделка или этап не найдены' }
    if (updated?.status === 403) return { success: false, error: 'Недостаточно прав' }
    if (updated?.status === 409) return { success: false, error: 'Сделка изменилась, обновите страницу' }
    if (updated?.status !== 200) throw new Error('Deal update failed')
    revalidatePath('/dashboard/deals')
    return { success: true }
  } catch (error) {
    console.error('[moveDeal]', error)
    return { success: false, error: 'Не удалось сохранить новый этап сделки' }
  }
}
