import { NextResponse } from 'next/server'
import { can, getActor } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

export async function GET(request: Request) {
  const actor = await getActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await can(actor, 'bot_analytics', 'view')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const params = new URL(request.url).searchParams
  const parsedFrom = params.get('from') ? new Date(params.get('from') as string) : monthStart
  const parsedTo = params.get('to') ? new Date(params.get('to') as string) : now
  const dateFrom = Number.isNaN(parsedFrom.getTime()) ? monthStart : parsedFrom
  const dateTo = Number.isNaN(parsedTo.getTime()) ? now : parsedTo

  const admin = createAdminClient()
  let query = admin
    .from('deals')
    .select('status, amount, source, loss_reason_code, amocrm_lead_id, sale_at, created_at, responsible_employee_id')
    .eq('company_id', COMPANY_ID)
    .is('deleted_at', null)
    .gte('created_at', dateFrom.toISOString())
    .lte('created_at', dateTo.toISOString())

  if (actor.role !== 'owner' && actor.role !== 'rop') {
    query = query.eq('responsible_employee_id', actor.employeeId)
  }

  const { data: deals, error } = await query
  if (error) return NextResponse.json({ error: 'Не удалось загрузить сделки' }, { status: 500 })

  let assisted = new Set<string>()
  const botBase = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, '')
  const botKey = process.env.BOT_BACKEND_ADMIN_API_KEY
  if (botBase && botKey) {
    try {
      const response = await fetch(`${botBase}/admin/analytics/assisted-leads`, {
        cache: 'no-store',
        headers: { 'X-Admin-API-Key': botKey },
      })
      if (response.ok) {
        const body = await response.json() as { lead_ids?: string[] }
        assisted = new Set((body.lead_ids ?? []).map(String))
      }
    } catch {
      // Sales metrics remain available even if the bot is temporarily offline.
    }
  }

  const rows = deals ?? []
  const { data: employees } = await admin.from('employees').select('id, name').is('deleted_at', null)
  const employeeNames = new Map((employees ?? []).map(employee => [employee.id, employee.name]))
  const won = rows.filter(deal => deal.status === 'won')
  const aiWon = won.filter(deal => deal.amocrm_lead_id && assisted.has(String(deal.amocrm_lead_id)))
  const bySource = Object.entries(rows.reduce<Record<string, { deals: number; won: number; revenue: number }>>((acc, deal) => {
    const source = deal.source || 'other'
    acc[source] ??= { deals: 0, won: 0, revenue: 0 }
    acc[source].deals += 1
    if (deal.status === 'won') {
      acc[source].won += 1
      acc[source].revenue += Number(deal.amount ?? 0)
    }
    return acc
  }, {})).map(([source, value]) => ({ source, ...value }))
  const byLossReason = Object.entries(rows.filter(deal => deal.status === 'lost').reduce<Record<string, number>>((acc, deal) => {
    const reason = String(deal.loss_reason_code || 'Не указана')
    acc[reason] = (acc[reason] ?? 0) + 1
    return acc
  }, {})).map(([reason, count]) => ({ reason, count }))
  const byManager = Object.entries(rows.reduce<Record<string, { deals: number; won: number; revenue: number }>>((acc, deal) => {
    const id = String(deal.responsible_employee_id || 'unassigned')
    acc[id] ??= { deals: 0, won: 0, revenue: 0 }
    acc[id].deals += 1
    if (deal.status === 'won') { acc[id].won += 1; acc[id].revenue += Number(deal.amount ?? 0) }
    return acc
  }, {})).map(([id, value]) => ({ manager_id: id === 'unassigned' ? null : id, manager: employeeNames.get(id) || 'Не назначен', ...value }))

  return NextResponse.json({
    period: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
    deals: rows.length,
    won: won.length,
    lost: rows.filter(deal => deal.status === 'lost').length,
    open: rows.filter(deal => deal.status === 'open').length,
    revenue: won.reduce((sum, deal) => sum + Number(deal.amount ?? 0), 0),
    ai_assisted_won: aiWon.length,
    ai_assisted_revenue: aiWon.reduce((sum, deal) => sum + Number(deal.amount ?? 0), 0),
    by_source: bySource,
    by_loss_reason: byLossReason,
    by_manager: byManager,
  })
}
