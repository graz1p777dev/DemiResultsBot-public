'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { can, getActor } from '@/lib/authz'
import { partitionCustomFieldValues } from '@/lib/custom-field-values'
import { getAccessibleClient, getClientAccess } from '@/lib/client-access'
import { canAccessDealResponsible, getAccessibleDeal, getDealAccess } from '@/lib/deal-access'
import { createClient } from '@/lib/supabase/server'

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

export type DialogClientWorkspace = {
  client: {
    id: string
    firstName: string
    lastName: string
    phone: string
    whatsappId: string
    instagramUsername: string
    city: string
    comments: string
    extraData: Record<string, string>
  }
  tags: Array<{ id: string; name: string; color: string }>
  selectedTagIds: string[]
  tasks: Array<{ id: string; title: string; status: string; priority: string; dueDate: string | null }>
  deals: Array<{ id: string; title: string; status: string; amount: number; stageName: string; stageColor: string; createdAt: string }>
  consultations: Array<{ id: string; dealId: string | null; date: string; time: string | null; status: string | null; result: string | null; amount: number; comment: string | null; createdAt: string }>
  botMemory: Array<{ id: string; text: string; updatedAt: string }>
  history: Array<{ id: string; kind: 'message' | 'note'; text: string; actor: string; occurredAt: string }>
  customFields: Array<{ id: string; key: string; label: string; fieldType: string }>
}

type Result<T = undefined> = T extends undefined
  ? { success: true } | { success: false; error: string }
  : { success: true; data: T } | { success: false; error: string }

async function replaceClientTags(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
  tagIds: string[],
  employeeId: string,
): Promise<{ success: true; tags: DialogClientWorkspace['tags'] } | { success: false; error: string }> {
  const uniqueTagIds = Array.from(new Set(tagIds))
  const { data: client, error: clientError } = await admin
    .from('crm_clients')
    .select('id')
    .eq('id', clientId)
    .eq('company_id', COMPANY_ID)
    .is('deleted_at', null)
    .maybeSingle()
  if (clientError || !client) return { success: false, error: 'Карточка клиента не найдена' }

  const { data: allowedTags, error: allowedTagsError } = uniqueTagIds.length
    ? await admin.from('crm_tags').select('id,name,color').eq('company_id', COMPANY_ID).in('id', uniqueTagIds)
    : { data: [], error: null }
  if (allowedTagsError || (allowedTags ?? []).length !== uniqueTagIds.length) {
    return { success: false, error: 'Один из выбранных тегов больше недоступен. Обновите страницу.' }
  }

  const { data: currentTags, error: currentTagsError } = await admin
    .from('crm_client_tags')
    .select('tag_id')
    .eq('client_id', clientId)
  if (currentTagsError) return { success: false, error: 'Не удалось прочитать теги клиента' }

  const currentIds = (currentTags ?? []).map(tag => tag.tag_id)
  const addedIds = uniqueTagIds.filter(tagId => !currentIds.includes(tagId))
  const removedIds = currentIds.filter(tagId => !uniqueTagIds.includes(tagId))

  if (addedIds.length) {
    const { error } = await admin.from('crm_client_tags').insert(
      addedIds.map(tagId => ({ client_id: clientId, tag_id: tagId, assigned_by: employeeId })),
    )
    if (error) return { success: false, error: 'Не удалось добавить тег клиенту' }
  }
  if (removedIds.length) {
    const { error } = await admin.from('crm_client_tags').delete().eq('client_id', clientId).in('tag_id', removedIds)
    if (error) return { success: false, error: 'Не удалось убрать тег у клиента' }
  }

  const byId = new Map((allowedTags ?? []).map(tag => [tag.id, tag]))
  return { success: true, tags: uniqueTagIds.flatMap(tagId => byId.get(tagId) ?? []) }
}

export async function getDialogClientWorkspace(clientId: string, _dealId?: string | null): Promise<Result<DialogClientWorkspace>> {
  // The dialog's current deal is supplied for compatibility; the client card
  // intentionally aggregates all of this client's tasks and purchases.
  void _dealId
  const actor = await getActor()
  if (!actor || !await can(actor, 'inbox', 'view')) return { success: false, error: 'Недостаточно прав' }
  const access = await getClientAccess(actor, 'view')
  if (!access) return { success: false, error: 'Недостаточно прав' }
  const client = await getAccessibleClient(access, clientId)
  if (!client) return { success: false, error: 'Карточка клиента не найдена' }
  const [dealAccess, viewTasks, viewConsultations, user] = await Promise.all([
    getDealAccess('view'), can(actor, 'tasks', 'view'), can(actor, 'consultations', 'view'), createClient(),
  ])
  const admin = createAdminClient()
  const [{ data: tags }, { data: selectedTags }, { data: tasks }, { data: deals }, { data: stages }, { data: customFields }, { data: notes }, { data: messages }] = await Promise.all([
    admin.from('crm_tags').select('id,name,color').eq('company_id', COMPANY_ID).order('sort_order'),
    admin.from('crm_client_tags').select('tag_id').eq('client_id', clientId),
    viewTasks ? user.from('tasks').select('id,title,status,priority,due_date').eq('company_id', COMPANY_ID).eq('client_id', clientId).neq('status', 'done').order('due_date', { ascending: true, nullsFirst: false }) : Promise.resolve({ data: [] }),
    dealAccess ? admin.from('deals').select('id,title,status,amount,stage_id,created_at,responsible_employee_id').eq('company_id', COMPANY_ID).eq('client_id', clientId).is('deleted_at', null).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    admin.from('deal_stages').select('id,name,color').eq('company_id', COMPANY_ID),
    admin.from('crm_custom_fields').select('id,key,label,field_type').eq('company_id', COMPANY_ID).eq('entity', 'client').order('sort_order'),
    admin.from('crm_client_notes').select('id,text,created_at,updated_at,author_employee_id').eq('company_id', COMPANY_ID).eq('client_id', clientId).order('created_at', { ascending: false }).limit(30),
    admin.from('crm_messages').select('id,text,sender_type,occurred_at').eq('company_id', COMPANY_ID).eq('client_id', clientId).order('occurred_at', { ascending: false }).limit(30),
  ])
  const clientDeals = (deals ?? []).filter(deal => dealAccess && canAccessDealResponsible(dealAccess, deal.responsible_employee_id))
  const linkedDealIds = clientDeals.map(deal => deal.id)
  const { data: consultations } = viewConsultations && linkedDealIds.length
    ? await user.from('consultations').select('id,crm_deal_id,date,time,status,status_after_fv,amount,comment,ai_memory,created_at,updated_at').in('crm_deal_id', linkedDealIds).is('deleted_at', null).order('date', { ascending: false })
    : { data: [] }
  const stageById = new Map((stages ?? []).map(stage => [stage.id, stage]))
  const history = [
    ...(notes ?? []).map(note => ({ id: `note:${note.id}`, kind: 'note' as const, text: note.text as string, actor: 'Заметка сотрудника', occurredAt: (note.updated_at ?? note.created_at) as string })),
    ...(messages ?? []).filter(message => message.text).map(message => ({ id: `message:${message.id}`, kind: 'message' as const, text: message.text as string, actor: message.sender_type === 'employee' ? 'Сотрудник' : message.sender_type === 'ai' ? 'ИИ-бот' : message.sender_type === 'client' ? 'Клиент' : 'Система', occurredAt: message.occurred_at as string })),
  ].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
  return {
    success: true,
    data: {
      client: {
        id: client.id,
        firstName: client.first_name ?? '',
        lastName: client.last_name ?? '',
        phone: client.phone ?? '',
        whatsappId: client.whatsapp_id ?? '',
        instagramUsername: client.instagram_username ?? '',
        city: client.city ?? '',
        comments: client.comments ?? '',
        extraData: Object.fromEntries(Object.entries((client.extra_data ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])),
      },
      tags: tags ?? [],
      selectedTagIds: (selectedTags ?? []).map(item => item.tag_id),
      tasks: (tasks ?? []).map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueDate: task.due_date,
      })),
      deals: clientDeals.map(deal => {
        const stage = stageById.get(deal.stage_id)
        return { id: deal.id, title: deal.title, status: deal.status, amount: Number(deal.amount ?? 0), stageName: stage?.name ?? 'Без этапа', stageColor: stage?.color ?? '#64748b', createdAt: deal.created_at }
      }),
      consultations: (consultations ?? []).map(item => ({ id: item.id, dealId: item.crm_deal_id, date: item.date, time: item.time, status: item.status, result: item.status_after_fv, amount: Number(item.amount ?? 0), comment: item.comment, createdAt: item.created_at })),
      botMemory: (consultations ?? []).flatMap(item => item.ai_memory ? [{ id: item.id, text: item.ai_memory as string, updatedAt: (item.updated_at ?? item.created_at) as string }] : []),
      history,
      customFields: (customFields ?? []).map(field => ({ id: field.id, key: field.key, label: field.label, fieldType: field.field_type })),
    },
  }
}

export async function saveDialogClientCard(input: {
  clientId: string
  firstName: string
  lastName: string
  phone: string
  whatsappId: string
  instagramUsername: string
  city: string
  comments: string
  extraData?: Record<string, string>
  tagIds: string[]
}): Promise<Result> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'clients', 'edit')) return { success: false, error: 'Недостаточно прав' }
  const access = await getClientAccess(actor, 'edit')
  const currentClient = access && await getAccessibleClient(access, input.clientId)
  if (!currentClient) return { success: false, error: 'Карточка клиента не найдена' }
  const admin = createAdminClient()
  const phone = input.phone.trim()
  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const fullName = [firstName, lastName].filter(Boolean).join(' ')
  const { data: customFields } = await admin.from('crm_custom_fields').select('key').eq('company_id', COMPANY_ID).eq('entity', 'client')
  const customFieldKeys = (customFields ?? []).map(field => field.key)
  const { known } = partitionCustomFieldValues(input.extraData ?? {}, customFieldKeys)
  const nextExtraData = { ...((currentClient.extra_data ?? {}) as Record<string, unknown>) }
  for (const key of customFieldKeys) {
    if (!Object.hasOwn(known, key)) continue
    const value = String(known[key] ?? '').trim()
    if (value) nextExtraData[key] = value
    else delete nextExtraData[key]
  }
  const { error } = await admin.from('crm_clients').update({
    first_name: firstName || null,
    last_name: lastName || null,
    phone: phone || null,
    phone_normalized: phone.replace(/\D/g, '') || null,
    whatsapp_id: input.whatsappId.trim() || null,
    instagram_username: input.instagramUsername.trim().replace(/^@/, '') || null,
    city: input.city.trim() || null,
    comments: input.comments.trim() || null,
    // Only configured fields are accepted from the browser. Integration and
    // legacy keys already stored in the card stay untouched.
    extra_data: nextExtraData,
    updated_at: new Date().toISOString(),
  }).eq('id', input.clientId).eq('company_id', COMPANY_ID)
  if (error) return { success: false, error: 'Не удалось сохранить данные клиента. Проверьте телефон и контакты.' }

  const dealAccess = await getDealAccess('edit')
  if (dealAccess) {
    const { data: deals } = await admin.from('deals').select('id,responsible_employee_id')
      .eq('company_id', COMPANY_ID).eq('client_id', input.clientId).is('deleted_at', null)
    const dealIds = (deals ?? []).filter(deal => canAccessDealResponsible(dealAccess, deal.responsible_employee_id)).map(deal => deal.id)
    if (dealIds.length) await admin.from('deals').update({
      customer_name: fullName || null,
      customer_phone: phone || null,
    }).eq('company_id', COMPANY_ID).in('id', dealIds).is('deleted_at', null)
  }

  const tagsResult = await replaceClientTags(admin, input.clientId, input.tagIds, actor.employeeId)
  if (!tagsResult.success) return tagsResult
  revalidatePath('/dashboard/dialogs')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function saveDialogClientTags(input: { clientId: string; tagIds: string[] }): Promise<Result<DialogClientWorkspace['tags']>> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'clients', 'edit')) return { success: false, error: 'Недостаточно прав' }
  const access = await getClientAccess(actor, 'edit')
  if (!access || !await getAccessibleClient(access, input.clientId)) return { success: false, error: 'Карточка клиента не найдена' }
  const result = await replaceClientTags(createAdminClient(), input.clientId, input.tagIds, actor.employeeId)
  if (!result.success) return result
  revalidatePath('/dashboard/dialogs')
  revalidatePath('/dashboard/deals')
  return { success: true, data: result.tags }
}

export async function createDialogClientTask(input: {
  clientId: string
  dealId: string | null
  title: string
  dueDate: string | null
  priority: 'low' | 'medium' | 'high' | 'urgent'
}): Promise<Result> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'tasks', 'create')) return { success: false, error: 'Недостаточно прав' }
  const access = await getClientAccess(actor, 'view')
  if (!access || !await getAccessibleClient(access, input.clientId)) return { success: false, error: 'Карточка клиента не найдена' }
  if (input.dealId) {
    const dealAccess = await getDealAccess('view')
    const deal = dealAccess && await getAccessibleDeal(dealAccess, input.dealId)
    if (!deal || deal.client_id !== input.clientId) return { success: false, error: 'Сделка не найдена' }
  }
  const title = input.title.trim()
  if (!title) return { success: false, error: 'Напишите название задачи' }
  const user = await createClient()
  const { error } = await user.from('tasks').insert({
    company_id: COMPANY_ID,
    title,
    status: 'todo',
    priority: input.priority,
    visibility: 'all',
    assignee_id: actor.employeeId,
    created_by: actor.employeeId,
    client_id: input.clientId,
    deal_id: input.dealId,
    due_date: input.dueDate || null,
    task_type: `dialog_manual_${Date.now()}`,
    context_type: 'client',
  })
  if (error) return { success: false, error: 'Не удалось создать задачу' }
  revalidatePath('/dashboard/dialogs')
  revalidatePath('/dashboard/tasks/kanban')
  return { success: true }
}
