'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, getScope, inScope } from '@/lib/authz'
import { getMarketingOverviewCard, type MarketingOverviewCard } from '@/actions/marketing-decomposition'
import { getUnlinkedInventorySalesDaily, sumInventorySales } from '@/lib/analytics/inventory-sales'

export type ActionResult = { success: true } | { success: false; error: string }

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface CompanyPlanInput {
  date_start:       string  // YYYY-MM-DD
  date_end:         string
  target_revenue:   number
  avg_check:        number
  conv_appeal_lead: number  // %
  conv_lead_nv:     number
  conv_nv_fv:       number
  conv_fv_sale:     number
}

export interface CompanyPlan extends CompanyPlanInput {
  id: string
}

/** Рассчитанный план по воронке (реверсивно от выручки) */
export interface FunnelPlan {
  appeals: number
  leads:   number
  nv:      number
  fv:      number
  sales:   number
  revenue: number
}

/** Факт по воронке за период */
export interface FunnelFact {
  appeals:    number
  leads:      number
  nv:         number
  fv:         number
  sales:      number
  revenue:    number
  // Посетители без записи (is_nv = false) — только факт, план не рассчитывается
  no_nv_visitors: number
  no_nv_fv:       number
  no_nv_sales:    number
  no_nv_revenue:  number
}

/** Фактическая конверсия по переходам, % (null если делитель = 0) */
export interface FunnelConversions {
  appeal_lead: number | null
  lead_nv:     number | null
  nv_fv:       number | null
  fv_sale:     number | null
}

// ─── Расчёт воронки (реверсивный) ─────────────────────────────────────────────
// Единственное место с формулой — UI вызывает её же через computeFunnelPlan.

export async function computeFunnelPlan(input: {
  target_revenue:   number
  avg_check:        number
  conv_appeal_lead: number
  conv_lead_nv:     number
  conv_nv_fv:       number
  conv_fv_sale:     number
}): Promise<FunnelPlan> {
  const sales   = Math.ceil(input.target_revenue / input.avg_check)
  const fv      = Math.ceil(sales / (input.conv_fv_sale     / 100))
  const nv      = Math.ceil(fv    / (input.conv_nv_fv       / 100))
  const leads   = Math.ceil(nv    / (input.conv_lead_nv     / 100))
  const appeals = Math.ceil(leads / (input.conv_appeal_lead / 100))
  return { appeals, leads, nv, fv, sales, revenue: input.target_revenue }
}

// ─── Auth guard ────────────────────────────────────────────────────────────────

// План компании — часть раздела «Декомпозиция». Управление (upsert/delete) — только owner.
async function requireOwner(): Promise<boolean> {
  const actor = await getActor()
  return actor?.role === 'owner'
}

// Чтение плана/факта — при праве decomposition.view (fail-closed через getActor+can).
async function requireDecompositionView(): Promise<boolean> {
  const actor = await getActor()
  return !!actor && await can(actor, 'decomposition', 'view')
}

// ─── Чтение плана ─────────────────────────────────────────────────────────────

/** План, покрывающий указанную дату (по умолчанию — сегодня) */
export async function getCompanyPlan(forDate?: string): Promise<CompanyPlan | null> {
  if (!await requireDecompositionView()) return null
  const admin = createAdminClient()
  const d = forDate ?? new Date().toISOString().slice(0, 10)
  const { data } = await admin
    .from('company_plans')
    .select('id, date_start, date_end, target_revenue, avg_check, conv_appeal_lead, conv_lead_nv, conv_nv_fv, conv_fv_sale')
    .lte('date_start', d)
    .gte('date_end', d)
    .maybeSingle()
  return data as CompanyPlan | null
}

/** Все планы (для списка периодов) */
export async function getCompanyPlans(): Promise<CompanyPlan[]> {
  if (!await requireDecompositionView()) return []
  const admin = createAdminClient()
  const { data } = await admin
    .from('company_plans')
    .select('id, date_start, date_end, target_revenue, avg_check, conv_appeal_lead, conv_lead_nv, conv_nv_fv, conv_fv_sale')
    .order('date_start', { ascending: false })
  return (data ?? []) as CompanyPlan[]
}

// ─── Запись плана ─────────────────────────────────────────────────────────────

function validatePlanInput(input: CompanyPlanInput): string | null {
  if (!input.date_start || !input.date_end) return 'Укажите даты периода'
  if (input.date_end < input.date_start) return 'Дата окончания раньше даты начала'
  if (input.target_revenue <= 0) return 'Целевая выручка должна быть больше 0'
  if (input.avg_check <= 0) return 'Средний чек должен быть больше 0'
  for (const [label, v] of [
    ['Обращение→Лид', input.conv_appeal_lead],
    ['Лид→НВ',        input.conv_lead_nv],
    ['НВ→ФВ',         input.conv_nv_fv],
    ['ФВ→Продажа',    input.conv_fv_sale],
  ] as const) {
    if (v <= 0 || v > 100) return `Конверсия «${label}» должна быть в диапазоне 0–100%`
  }
  return null
}

export async function upsertCompanyPlan(
  input: CompanyPlanInput,
  planId?: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const validationError = validatePlanInput(input)
  if (validationError) return { success: false, error: validationError }

  const admin = createAdminClient()

  if (planId) {
    const { error } = await admin.from('company_plans').update(input).eq('id', planId)
    if (error) {
      if (error.code === '23P01') return { success: false, error: 'Период пересекается с существующим планом' }
      return { success: false, error: error.message }
    }
    revalidatePath('/dashboard/decomposition')
    return { success: true, id: planId }
  }

  const { data, error } = await admin
    .from('company_plans')
    .insert(input)
    .select('id')
    .single()
  if (error || !data) {
    if (error?.code === '23P01') return { success: false, error: 'Период пересекается с существующим планом' }
    return { success: false, error: error?.message ?? 'Ошибка создания плана' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true, id: data.id as string }
}

export async function deleteCompanyPlan(planId: string): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.from('company_plans').delete().eq('id', planId)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/decomposition')
  return { success: true }
}

// ─── Агрегация факта из существующих источников ───────────────────────────────
// Обращения/Лиды/НВ — только из daily_activity (там их единственный источник).
// ФВ/Продажи/Выручка — override из daily_activity, иначе consultations.
// Без НВ — из consultations (is_nv = false), override nv_* полей daily_activity
//   здесь не применяется, т.к. nv_* хранят факт ПО НВ, а не «без НВ».
//
// ВАЖНО (исправлено): override разрешается ПО СОТРУДНИКУ, а не по всему дню.
// Раньше достаточно было одной ручной правки за день, чтобы факт ВСЕХ остальных
// сотрудников за этот день выпал из подсчёта. С появлением формы ручной правки
// у МП на эти грабли стало легко наступить, поэтому логика такая:
//   за день  →  сотрудники с override дают свои значения,
//               консультации сотрудников БЕЗ override считаются как обычно.
// Консультации без manager_id перекрыть нельзя — они всегда учитываются.

const isSold = (s: string | null) => s === 'Купила' || s === 'Предоплата'

interface DaRow {
  date:         string
  employee_id:  string | null
  appeals_fact: number | null
  leads_fact:   number | null
  nv_fact:      number | null
  fv_fact:      number | null
  sales_fact:   number | null
  revenue_fact: number | null
}

interface ConsRow {
  date:                  string
  manager_id:            string | null
  actual_status:         string | null
  status_after_fv:       string | null
  amount:                number | null
  delivery_cost:         number | null
  is_nv:                 boolean | null
  is_returning_customer: boolean | null
}

/** Разрешение «override по сотруднику» для одного дня и одной метрики. */
function resolveDayMetric<T extends 'fv_fact' | 'sales_fact' | 'revenue_fact'>(
  daDay:   { employee_id: string | null; fv_fact: number | null; sales_fact: number | null; revenue_fact: number | null }[],
  consDay: { manager_id: string | null; actual_status: string | null; status_after_fv: string | null; amount: number | null; delivery_cost: number | null }[],
  field: T,
  fromConsultation: (rows: typeof consDay) => number,
): number {
  // Кто перекрыл эту метрику за день
  const overridden = new Map<string, number>()
  for (const r of daDay) {
    const v = r[field]
    if (v !== null && r.employee_id) overridden.set(r.employee_id, Number(v))
  }
  const overrideSum = [...overridden.values()].reduce((s, v) => s + v, 0)

  // Консультации сотрудников, которые НЕ перекрывали метрику
  const rest = consDay.filter(c => !c.manager_id || !overridden.has(c.manager_id))
  return overrideSum + fromConsultation(rest)
}

const countArrived = (rows: { actual_status: string | null }[]) =>
  rows.filter(c => c.actual_status === 'Пришла').length
const countSold = (rows: { status_after_fv: string | null }[]) =>
  rows.filter(c => isSold(c.status_after_fv)).length
const sumSold = (rows: { status_after_fv: string | null; amount: number | null; delivery_cost: number | null }[]) =>
  rows.filter(c => isSold(c.status_after_fv))
    .reduce((s, c) => s + Number(c.amount ?? 0) + Number(c.delivery_cost ?? 0), 0)

export async function getCompanyFact(dateStart: string, dateEnd: string): Promise<FunnelFact | null> {
  if (!await requireDecompositionView()) return null
  const admin = createAdminClient()

  const [{ data: daRows }, { data: consRows }, inventoryDays] = await Promise.all([
    admin
      .from('daily_activity')
      .select('date, employee_id, appeals_fact, leads_fact, nv_fact, fv_fact, sales_fact, revenue_fact')
      .gte('date', dateStart)
      .lte('date', dateEnd),
    admin
      .from('consultations')
      .select('date, manager_id, actual_status, status_after_fv, amount, delivery_cost, is_nv, is_returning_customer')
      .gte('date', dateStart)
      .lte('date', dateEnd)
      .is('deleted_at', null),
    getUnlinkedInventorySalesDaily(admin, dateStart, dateEnd),
  ])

  const da   = (daRows ?? []) as unknown as DaRow[]
  const cons = (consRows ?? []) as unknown as ConsRow[]

  // Прямые суммы из daily_activity
  const appeals = da.reduce((s, r) => s + (r.appeals_fact ?? 0), 0)
  const leads   = da.reduce((s, r) => s + (r.leads_fact ?? 0), 0)
  const nv      = da.reduce((s, r) => s + (r.nv_fact ?? 0), 0)

  const dayKeys = new Set<string>([...da.map(r => r.date), ...cons.map(r => r.date)])

  let fv = 0, sales = 0, revenue = 0
  for (const day of dayKeys) {
    const daDay   = da.filter(r => r.date === day)
    const consDay = cons.filter(r => r.date === day)
    fv      += resolveDayMetric(daDay, consDay, 'fv_fact',      countArrived)
    sales   += resolveDayMetric(daDay, consDay, 'sales_fact',   countSold)
    revenue += resolveDayMetric(daDay, consDay, 'revenue_fact', sumSold)
  }

  // Посетители без записи — только из consultations (is_nv = false)
  const noNv = cons.filter(c => c.is_nv === false)
  let no_nv_visitors = noNv.length  // все зашедшие без записи, независимо от исхода
  const no_nv_fv    = countArrived(noNv)
  let no_nv_sales   = countSold(noNv)
  let no_nv_revenue = sumSold(noNv)

  const inventory = sumInventorySales(inventoryDays)
  sales += inventory.sales
  revenue += inventory.revenue
  no_nv_visitors += inventory.sales
  no_nv_sales += inventory.sales
  no_nv_revenue += inventory.revenue

  return { appeals, leads, nv, fv, sales, revenue, no_nv_visitors, no_nv_fv, no_nv_sales, no_nv_revenue }
}

// ─── Факт по дням (для таблицы «План/Факт по дням») ──────────────────────────
// Возвращает строку на КАЖДЫЙ календарный день диапазона (включая нулевые).

export interface DailyFactRow {
  date:    string  // YYYY-MM-DD
  appeals: number
  leads:   number
  nv:      number
  fv:      number
  sales:   number
  revenue: number
  // Посетители без записи — только факт
  no_nv_visitors: number
  no_nv_sales:    number
  no_nv_revenue:  number
}

export async function getCompanyFactDaily(dateStart: string, dateEnd: string): Promise<DailyFactRow[]> {
  if (!await requireDecompositionView()) return []
  const admin = createAdminClient()

  const [{ data: daRows }, { data: consRows }, inventoryDays] = await Promise.all([
    admin
      .from('daily_activity')
      .select('date, employee_id, appeals_fact, leads_fact, nv_fact, fv_fact, sales_fact, revenue_fact')
      .gte('date', dateStart)
      .lte('date', dateEnd),
    admin
      .from('consultations')
      .select('date, manager_id, actual_status, status_after_fv, amount, delivery_cost, is_nv, is_returning_customer')
      .gte('date', dateStart)
      .lte('date', dateEnd)
      .is('deleted_at', null),
    getUnlinkedInventorySalesDaily(admin, dateStart, dateEnd),
  ])

  const da   = (daRows ?? []) as unknown as DaRow[]
  const cons = (consRows ?? []) as unknown as ConsRow[]
  const inventoryByDate = new Map(inventoryDays.map(row => [row.date, row]))

  // Генерируем все календарные дни диапазона
  const days: string[] = []
  const cursor = new Date(dateStart + 'T00:00:00')
  const endD   = new Date(dateEnd + 'T00:00:00')
  while (cursor <= endD) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setDate(cursor.getDate() + 1)
    if (days.length > 366) break
  }

  return days.map(day => {
    const daDay   = da.filter(r => r.date === day)
    const consDay = cons.filter(r => r.date === day)

    const appeals = daDay.reduce((s, r) => s + (r.appeals_fact ?? 0), 0)
    const leads   = daDay.reduce((s, r) => s + (r.leads_fact ?? 0), 0)
    const nv      = daDay.reduce((s, r) => s + (r.nv_fact ?? 0), 0)

    // Override по сотруднику (см. комментарий у getCompanyFact)
    const fv      = resolveDayMetric(daDay, consDay, 'fv_fact',      countArrived)
    const inventory = inventoryByDate.get(day)
    const inventorySales = inventory?.sales ?? 0
    const inventoryRevenue = inventory?.revenue ?? 0
    const sales   = resolveDayMetric(daDay, consDay, 'sales_fact',   countSold) + inventorySales
    const revenue = resolveDayMetric(daDay, consDay, 'revenue_fact', sumSold) + inventoryRevenue

    // Посетители без записи — только из consultations (is_nv = false)
    const noNvDay = consDay.filter(c => c.is_nv === false)
    const no_nv_visitors = noNvDay.length + inventorySales
    const no_nv_sales   = countSold(noNvDay) + inventorySales
    const no_nv_revenue = sumSold(noNvDay) + inventoryRevenue

    return { date: day, appeals, leads, nv, fv, sales, revenue, no_nv_visitors, no_nv_sales, no_nv_revenue }
  })
}

// ─── Вклад менеджеров в общий факт (Часть 1, п.4) ────────────────────────────
// Мини-рейтинг внутри отдела: кто сколько принёс продаж и выручки.
// Считаем по consultations.manager_id с учётом override из daily_activity
// (тот же принцип «по сотруднику»), поэтому ручная правка видна и здесь.
//
// SCOPE (Блокер Codex #1b): блок раскрывает имена/продажи/выручку менеджеров, поэтому
// охват обязателен. Раньше любой decomposition.view=true отдавал ВСЕХ активных МП —
// МП/ЛМ со scope='own' прямым вызовом получали данные коллег. Теперь:
//   own  → блок не отдаётся (пусто) — у МП свой личный экран;
//   team → только свой отдел; доля считается внутри видимого (team) множества;
//   all  → все МП, доля от общей выручки компании.

export interface ManagerContribution {
  employeeId: string
  name:       string
  sales:      number
  revenue:    number
  /** Доля в выручке видимого охвата за период, % (team — по отделу, all — по компании) */
  sharePct:   number
}

export async function getManagerContributions(
  dateStart: string,
  dateEnd: string,
): Promise<ManagerContribution[]> {
  const actor = await getActor()
  if (!actor) return []
  if (!await can(actor, 'decomposition', 'view')) return []
  const scope = await getScope(actor, 'decomposition')
  if (!scope) return []
  // own не видит чужих — а один свой ряд в рейтинге бессмыслен: блок не показываем.
  if (scope === 'own') return []

  const admin = createAdminClient()

  const [{ data: mps }, { data: daRows }, { data: consRows }] = await Promise.all([
    admin
      .from('employees')
      .select('id, name, department_id')
      .eq('role', 'mp')
      .is('deleted_at', null)
      .order('created_at'),
    admin
      .from('daily_activity')
      .select('date, employee_id, fv_fact, sales_fact, revenue_fact, appeals_fact, leads_fact, nv_fact')
      .gte('date', dateStart)
      .lte('date', dateEnd),
    admin
      .from('consultations')
      .select('date, manager_id, actual_status, status_after_fv, amount, is_nv, is_returning_customer')
      .gte('date', dateStart)
      .lte('date', dateEnd)
      .is('deleted_at', null),
  ])

  const da   = (daRows ?? []) as unknown as DaRow[]
  const cons = (consRows ?? []) as unknown as ConsRow[]

  // Только МП в охвате актора (team — свой отдел; all — все). Чужие даже не считаются.
  const visibleMps = (mps ?? []).filter(m =>
    inScope(actor, scope, m.id as string, (m.department_id as string | null) ?? null))

  const rows = visibleMps.map(m => {
    const id = m.id as string
    const myDa   = da.filter(r => r.employee_id === id)
    const myCons = cons.filter(c => c.manager_id === id)

    // По дням: если сотрудник перекрыл метрику в этот день — берём override
    const days = new Set<string>([...myDa.map(r => r.date), ...myCons.map(c => c.date)])
    let sales = 0, revenue = 0
    for (const day of days) {
      const d = myDa.filter(r => r.date === day)
      const c = myCons.filter(r => r.date === day)
      sales   += resolveDayMetric(d, c, 'sales_fact',   countSold)
      revenue += resolveDayMetric(d, c, 'revenue_fact', sumSold)
    }
    return { employeeId: id, name: m.name as string, sales, revenue, sharePct: 0 }
  })

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  return rows
    .map(r => ({ ...r, sharePct: totalRevenue > 0 ? (r.revenue / totalRevenue) * 100 : 0 }))
    .sort((a, b) => b.revenue - a.revenue)
}

// ─── Фактическая конверсия ────────────────────────────────────────────────────

export async function computeFactConversions(fact: FunnelFact): Promise<FunnelConversions> {
  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 10000) / 100 : null
  return {
    appeal_lead: pct(fact.leads, fact.appeals),
    lead_nv:     pct(fact.nv,    fact.leads),
    nv_fv:       pct(fact.fv,    fact.nv),
    fv_sale:     pct(fact.sales, fact.fv),
  }
}

// ─── Композитная загрузка обзора декомпозиции ─────────────────────────────────
// Те же три чтения (план → факт, и независимая карточка маркетинга), но одним
// Server Action: POST'ы всё равно сериализуются, поэтому объединение на сервере —
// единственный способ их совместить. Идентичность внутри резолвится один раз.
// getCompanyFact зависит от дат плана, поэтому идёт после него; карточка маркетинга
// от плана не зависит и стартует параллельно.
export interface DecompositionOverviewBundle {
  plan: CompanyPlan | null
  fact: FunnelFact | null
  marketing: MarketingOverviewCard | null
}

export async function getDecompositionOverviewBundle(
  withMarketing: boolean,
): Promise<DecompositionOverviewBundle> {
  const [plan, marketing] = await Promise.all([
    getCompanyPlan(),
    withMarketing ? getMarketingOverviewCard() : Promise.resolve(null),
  ])

  const fact = plan ? await getCompanyFact(plan.date_start, plan.date_end) : null

  return { plan, fact, marketing }
}
