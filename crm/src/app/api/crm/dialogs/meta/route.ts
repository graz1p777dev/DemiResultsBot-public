import { NextResponse } from 'next/server'
import { getActor, can } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { canAccessDealResponsible, DEAL_COMPANY_ID, getDealAccess } from '@/lib/deal-access'
import { getClientAccess } from '@/lib/client-access'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const actor = await getActor()
  if (!actor || !await can(actor, 'inbox', 'view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const leads = new URL(request.url).searchParams.get('leads')?.split(',').map(Number).filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 250) ?? []
  if (!leads.length) return NextResponse.json({ items: [], stages: [], employees: [] })
  const [access, clientAccess, viewTasks, user] = await Promise.all([
    getDealAccess('view'), getClientAccess(actor, 'view'), can(actor, 'tasks', 'view'), createClient(),
  ])
  if (!access) return NextResponse.json({ items: [], stages: [], employees: [] })
  const admin = createAdminClient()
  const [{ data: dealRows }, { data: stages }, { data: employeeRows }] = await Promise.all([
    admin.from('deals').select('id, client_id, amocrm_lead_id, stage_id, responsible_employee_id, source, sla_due_at, next_action_at').eq('company_id', DEAL_COMPANY_ID).in('amocrm_lead_id', leads).is('deleted_at', null),
    admin.from('deal_stages').select('id, name, color, pipeline_id, sort_order').eq('company_id', DEAL_COMPANY_ID).eq('pipeline_id', '10000000-0000-0000-0000-000000000001').order('sort_order'),
    admin.from('employees').select('id, name, crm_company_members!inner(company_id)').eq('crm_company_members.company_id', DEAL_COMPANY_ID).is('deleted_at', null).neq('status', 'archived').order('name'),
  ])
  const deals = (dealRows ?? []).filter(deal => canAccessDealResponsible(access, deal.responsible_employee_id))
  const employees = (employeeRows ?? []).filter(employee => canAccessDealResponsible(access, employee.id)).map(employee => ({ id: employee.id, name: employee.name }))
  const clientIds = (deals ?? []).map(deal => deal.client_id as string).filter(Boolean)
  const dealIds = (deals ?? []).map(deal => deal.id as string)
  const [{ data: clientRows }, { data: tasks }] = await Promise.all([
    clientAccess && clientIds.length ? admin.from('crm_clients').select('id, first_name, last_name, phone, instagram_username, city, responsible_employee_id').eq('company_id', DEAL_COMPANY_ID).is('deleted_at', null).in('id', clientIds) : Promise.resolve({ data: [] }),
    viewTasks && dealIds.length ? user.from('tasks').select('deal_id, due_date, status, priority').eq('company_id', DEAL_COMPANY_ID).in('deal_id', dealIds).neq('status', 'done') : Promise.resolve({ data: [] }),
  ])
  const clients = (clientRows ?? []).filter(client => clientAccess && canAccessDealResponsible(clientAccess, client.responsible_employee_id))
  const authorizedClientIds = clients.map(client => client.id)
  const { data: tagRows } = authorizedClientIds.length
    ? await admin.from('crm_client_tags').select('client_id, tag:crm_tags!inner(id, name, color)').eq('tag.company_id', DEAL_COMPANY_ID).in('client_id', authorizedClientIds)
    : { data: [] }
  const clientsById = new Map((clients ?? []).map(client => [client.id as string, client]))
  const employeeById = new Map((employees ?? []).map(employee => [employee.id as string, employee.name as string]))
  const tagsByClient = new Map<string, unknown[]>()
  ;(tagRows ?? []).forEach(row => tagsByClient.set(row.client_id as string, [...(tagsByClient.get(row.client_id as string) ?? []), row.tag]))
  const tasksByDeal = new Map<string, Array<{ due_date: string | null; priority: string }>>()
  ;(tasks ?? []).forEach(task => tasksByDeal.set(task.deal_id as string, [...(tasksByDeal.get(task.deal_id as string) ?? []), task as { due_date: string | null; priority: string }]))
  const items = (deals ?? []).map(deal => {
    const client = clientsById.get(deal.client_id as string)
    const openTasks = tasksByDeal.get(deal.id as string) ?? []
    const nextTaskAt = openTasks.map(task => task.due_date).filter((value): value is string => Boolean(value)).sort()[0] ?? null
    const overdue = Boolean(nextTaskAt && new Date(`${nextTaskAt}T23:59:59`).getTime() < Date.now())
    return {
      leadId: String(deal.amocrm_lead_id), dealId: deal.id, clientId: deal.client_id, stageId: deal.stage_id,
      responsibleEmployeeId: deal.responsible_employee_id,
      responsibleName: deal.responsible_employee_id ? employeeById.get(deal.responsible_employee_id as string) ?? null : null,
      source: deal.source, urgent: Boolean(openTasks.some(task => task.priority === 'urgent')),
      attention: Boolean(deal.sla_due_at && new Date(deal.sla_due_at as string).getTime() < Date.now()),
      overdue, hasTasks: openTasks.length > 0, nextTaskAt,
      city: client?.city ?? null, phone: client?.phone ?? null, instagramUsername: client?.instagram_username ?? null,
      fullName: [client?.first_name, client?.last_name].filter(Boolean).join(' ') || null,
      tags: tagsByClient.get(deal.client_id as string) ?? [],
    }
  })
  return NextResponse.json({ items, stages, employees })
}
