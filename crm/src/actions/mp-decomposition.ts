'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getViewer, isManager } from '@/lib/decomposition/viewer'
import { can, getActor, getScope, inScope } from '@/lib/authz'
import { computeFunnelPlan } from './company-plan'
import {
  countWorkDays,
  dailyNorm,
  distEven,
  NON_WORKING_STATUSES,
} from '@/lib/decomposition/schedule'

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface MpDailyFactRow {
  date:    string
  fv:      number
  sales:   number
  revenue: number
  no_nv_visitors: number
  no_nv_sales:    number
  no_nv_revenue:  number
}

export interface MpMetricNorm {
  target:    number   // личный план на период
  fact:      number   // сделано с начала периода
  norm:      number   // норма на сегодня (в день)
  remaining: number   // остаток плана
  done:      boolean
  noDaysLeft: boolean
}

export interface MpDecompositionData {
  employee:   { id: string; name: string }
  viewerRole: 'mp' | 'owner'
  plan: { id: string; date_start: string; date_end: string } | null
  mpCount: number
  scheduleType: string
  remainingWorkDays: number
  norms: { fv: MpMetricNorm; sales: MpMetricNorm; revenue: MpMetricNorm } | null
  daily: MpDailyFactRow[]
  noNvTotals: { visitors: number; sales: number; revenue: number }
  /** Постоянные клиенты (метка is_returning_customer) — только факт, Часть 4 */
  returningTotals: { sales: number; revenue: number }
  /** Место в рейтинге МП по выручке за период (1 = лучший) */
  rank: { place: number; total: number } | null
  /** Ручные правки текущей выбранной даты — чтобы форма показывала, что уже введено */
  overridesByDate: Record<string, MpOverrideRow>
}

/** Ручная правка факта за один день (все поля необязательны: NULL = «нет правки») */
export interface MpOverrideRow {
  fv_fact:               number | null
  sales_fact:            number | null
  revenue_fact:          number | null
  walk_in_visitors_fact: number | null
  walk_in_sales_fact:    number | null
  walk_in_revenue_fact:  number | null
}

// ─── Чтение данных экрана ─────────────────────────────────────────────────────

export async function getMpDecomposition(targetEmployeeId?: string): Promise<MpDecompositionData | null> {
  const me = await getViewer()
  if (!me) return null
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'decomposition', 'view')) return null

  const admin = createAdminClient()

  // ── Целевой сотрудник: МП видит себя, owner/руководитель — выбранного ──
  let employee: { id: string; name: string; schedule_type: string; anchor: string | null } | null = null

  if (me.role === 'mp') {
    const { data } = await admin
      .from('employees')
      .select('id, name, schedule_type, schedule_anchor_date, hire_date')
      .eq('id', me.id)
      .maybeSingle()
    if (data) {
      employee = {
        id: data.id as string,
        name: data.name as string,
        schedule_type: (data.schedule_type as string) ?? '5/2',
        anchor: (data.schedule_anchor_date as string | null) ?? (data.hire_date as string | null),
      }
    }
  } else if (isManager(me) && targetEmployeeId) {
    // Руководитель/владелец открывает экран выбранного МП — но только в пределах
    // своего охвата: department_head со scope='team' не должен видеть чужой отдел.
    const scope = await getScope(actor, 'decomposition')
    if (!scope) return null
    const { data } = await admin
      .from('employees')
      .select('id, name, schedule_type, schedule_anchor_date, hire_date, department_id')
      .eq('id', targetEmployeeId)
      .eq('role', 'mp')
      .is('deleted_at', null)
      .maybeSingle()
    if (data && inScope(actor, scope, data.id as string, (data.department_id as string | null) ?? null)) {
      employee = {
        id: data.id as string,
        name: data.name as string,
        schedule_type: (data.schedule_type as string) ?? '5/2',
        anchor: (data.schedule_anchor_date as string | null) ?? (data.hire_date as string | null),
      }
    }
  } else {
    return null
  }

  if (!employee) return null
  const viewerRole: 'mp' | 'owner' = me.role === 'mp' ? 'mp' : 'owner'

  // ── Активный план компании ──
  const today = new Date().toISOString().slice(0, 10)
  const { data: plan } = await admin
    .from('company_plans')
    .select('id, date_start, date_end, target_revenue, avg_check, conv_appeal_lead, conv_lead_nv, conv_nv_fv, conv_fv_sale')
    .lte('date_start', today)
    .gte('date_end', today)
    .maybeSingle()

  const empty: MpDecompositionData = {
    employee:   { id: employee.id, name: employee.name },
    viewerRole,
    plan: null,
    mpCount: 0,
    scheduleType: employee.schedule_type,
    remainingWorkDays: 0,
    norms: null,
    daily: [],
    noNvTotals: { visitors: 0, sales: 0, revenue: 0 },
    returningTotals: { sales: 0, revenue: 0 },
    rank: null,
    overridesByDate: {},
  }
  if (!plan) return empty

  // ── Личный план: делим план компании поровну между активными МП ──
  const funnel = await computeFunnelPlan({
    target_revenue:   Number(plan.target_revenue),
    avg_check:        Number(plan.avg_check),
    conv_appeal_lead: Number(plan.conv_appeal_lead),
    conv_lead_nv:     Number(plan.conv_lead_nv),
    conv_nv_fv:       Number(plan.conv_nv_fv),
    conv_fv_sale:     Number(plan.conv_fv_sale),
  })

  const { data: mps } = await admin
    .from('employees')
    .select('id')
    .eq('role', 'mp')
    .is('deleted_at', null)
    .order('created_at')  // детерминированный порядок — остаток достаётся одним и тем же

  const mpIds = (mps ?? []).map(r => r.id as string)
  const idx = mpIds.indexOf(employee.id)
  if (idx === -1) return { ...empty, plan: { id: plan.id as string, date_start: plan.date_start as string, date_end: plan.date_end as string }, mpCount: mpIds.length }

  const personal = {
    fv:      distEven(funnel.fv, mpIds.length)[idx],
    sales:   distEven(funnel.sales, mpIds.length)[idx],
    revenue: distEven(funnel.revenue, mpIds.length)[idx],
  }

  // ── Факт по дням: daily_activity (override) → consultations по manager_id ──
  const [{ data: daRows }, { data: consRows }, { data: attRows }] = await Promise.all([
    admin
      .from('daily_activity')
      .select('date, fv_fact, sales_fact, revenue_fact, walk_in_visitors_fact, walk_in_sales_fact, walk_in_revenue_fact')
      .eq('employee_id', employee.id)
      .gte('date', plan.date_start as string)
      .lte('date', plan.date_end as string),
    admin
      .from('consultations')
      .select('date, actual_status, status_after_fv, amount, is_nv, is_returning_customer')
      .eq('manager_id', employee.id)
      .gte('date', plan.date_start as string)
      .lte('date', plan.date_end as string)
      .is('deleted_at', null),
    // attendance: нерабочие дни вычитаются, отработанные вне графика (подмена) — добавляются
    admin
      .from('attendance')
      .select('date, status, covering_for_employee_id')
      .eq('employee_id', employee.id)
      .gte('date', today)
      .lte('date', plan.date_end as string),
  ])

  const da   = daRows ?? []
  const cons = consRows ?? []

  const days: string[] = []
  {
    const cursor = new Date((plan.date_start as string) + 'T00:00:00')
    const end    = new Date((plan.date_end as string) + 'T00:00:00')
    while (cursor <= end && days.length <= 366) {
      days.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`)
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  const daily: MpDailyFactRow[] = days.map(day => {
    const daDay   = da.filter(r => r.date === day)
    const consDay = cons.filter(r => r.date === day)

    const fvOverrides = daDay.filter(r => r.fv_fact !== null)
    const fv = fvOverrides.length > 0
      ? fvOverrides.reduce((s, r) => s + (r.fv_fact ?? 0), 0)
      : consDay.filter(c => c.actual_status === 'Пришла').length

    const soldCons = consDay.filter(c => c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата')
    const salesOverrides = daDay.filter(r => r.sales_fact !== null)
    const sales = salesOverrides.length > 0
      ? salesOverrides.reduce((s, r) => s + (r.sales_fact ?? 0), 0)
      : soldCons.length

    const revenueOverrides = daDay.filter(r => r.revenue_fact !== null)
    const revenue = revenueOverrides.length > 0
      ? revenueOverrides.reduce((s, r) => s + Number(r.revenue_fact ?? 0), 0)
      : soldCons.reduce((s, c) => s + Number(c.amount ?? 0), 0)

    // Посетители без записи: ручная правка (миграция 049) перекрывает авто-подсчёт
    // из консультаций за этот день — иначе значения сложились бы дважды.
    const noNvDay = consDay.filter(c => c.is_nv === false)
    const noNvSold = noNvDay.filter(c => c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата')

    const wiVisitors = daDay.find(r => r.walk_in_visitors_fact !== null)?.walk_in_visitors_fact
    const wiSales    = daDay.find(r => r.walk_in_sales_fact    !== null)?.walk_in_sales_fact
    const wiRevenue  = daDay.find(r => r.walk_in_revenue_fact  !== null)?.walk_in_revenue_fact

    return {
      date: day, fv, sales, revenue,
      no_nv_visitors: wiVisitors ?? noNvDay.length,
      no_nv_sales:    wiSales    ?? noNvSold.length,
      no_nv_revenue:  wiRevenue !== undefined && wiRevenue !== null
        ? Number(wiRevenue)
        : noNvSold.reduce((s, c) => s + Number(c.amount ?? 0), 0),
    }
  })

  // ── Постоянные клиенты (метка is_returning_customer) — только факт ──
  // Считаем из консультаций напрямую: метка живёт на записи, ручной правки для
  // неё нет и не планируется (это статистика, а не показатель плана).
  const returningSold = cons.filter(c =>
    c.is_returning_customer === true &&
    (c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата'))
  const returningTotals = {
    sales:   returningSold.length,
    revenue: returningSold.reduce((s, c) => s + Number(c.amount ?? 0), 0),
  }

  // ── Ручные правки по датам — форма показывает, что уже введено ──
  const overridesByDate: Record<string, MpOverrideRow> = {}
  for (const r of da) {
    overridesByDate[r.date as string] = {
      fv_fact:               (r.fv_fact               as number | null) ?? null,
      sales_fact:            (r.sales_fact            as number | null) ?? null,
      revenue_fact:          r.revenue_fact          === null || r.revenue_fact === undefined ? null : Number(r.revenue_fact),
      walk_in_visitors_fact: (r.walk_in_visitors_fact as number | null) ?? null,
      walk_in_sales_fact:    (r.walk_in_sales_fact    as number | null) ?? null,
      walk_in_revenue_fact:  r.walk_in_revenue_fact  === null || r.walk_in_revenue_fact === undefined ? null : Number(r.walk_in_revenue_fact),
    }
  }

  // Факт с начала периода — только дни до сегодня включительно
  const factToDate = daily
    .filter(d => d.date <= today)
    .reduce(
      (acc, d) => ({ fv: acc.fv + d.fv, sales: acc.sales + d.sales, revenue: acc.revenue + d.revenue }),
      { fv: 0, sales: 0, revenue: 0 },
    )

  // ── Оставшиеся рабочие дни (с сегодня до конца периода) ──
  // absences (sick/day_off/vacation/absent) вычитаются;
  // отработанные вне графика (worked/remote — в т.ч. подмена) добавляются.
  const absences = new Set(
    (attRows ?? [])
      .filter(r => (NON_WORKING_STATUSES as readonly string[]).includes(r.status as string))
      .map(r => r.date as string),
  )
  const extraDays = new Set(
    (attRows ?? [])
      .filter(r => r.status === 'worked' || r.status === 'remote')
      .map(r => r.date as string),
  )
  const fromForNorm = today < (plan.date_start as string) ? (plan.date_start as string) : today
  const remainingWorkDays = today > (plan.date_end as string)
    ? 0
    : countWorkDays(fromForNorm, plan.date_end as string, employee.schedule_type, employee.anchor, absences, extraDays)

  const norms = {
    fv:      { target: personal.fv,      fact: factToDate.fv,      ...dailyNorm(personal.fv, factToDate.fv, remainingWorkDays) },
    sales:   { target: personal.sales,   fact: factToDate.sales,   ...dailyNorm(personal.sales, factToDate.sales, remainingWorkDays) },
    revenue: { target: personal.revenue, fact: factToDate.revenue, ...dailyNorm(personal.revenue, factToDate.revenue, remainingWorkDays) },
  }

  const noNvTotals = daily.reduce(
    (acc, d) => ({
      visitors: acc.visitors + d.no_nv_visitors,
      sales:    acc.sales + d.no_nv_sales,
      revenue:  acc.revenue + d.no_nv_revenue,
    }),
    { visitors: 0, sales: 0, revenue: 0 },
  )

  // ── Место в рейтинге МП по выручке за период ──
  // Мягкая мотивация: показываем «N из M», без имён коллег и их цифр.
  const { data: rivalCons } = await admin
    .from('consultations')
    .select('manager_id, status_after_fv, amount')
    .in('manager_id', mpIds)
    .gte('date', plan.date_start as string)
    .lte('date', plan.date_end as string)
    .is('deleted_at', null)

  const revenueByMp = new Map<string, number>(mpIds.map(id => [id, 0]))
  for (const c of rivalCons ?? []) {
    if (c.status_after_fv !== 'Купила' && c.status_after_fv !== 'Предоплата') continue
    const id = c.manager_id as string
    revenueByMp.set(id, (revenueByMp.get(id) ?? 0) + Number(c.amount ?? 0))
  }
  const myRevenue = revenueByMp.get(employee.id) ?? 0
  const place = [...revenueByMp.values()].filter(v => v > myRevenue).length + 1
  const rank = mpIds.length > 1 ? { place, total: mpIds.length } : null

  return {
    employee:   { id: employee.id, name: employee.name },
    viewerRole,
    plan: { id: plan.id as string, date_start: plan.date_start as string, date_end: plan.date_end as string },
    mpCount: mpIds.length,
    scheduleType: employee.schedule_type,
    remainingWorkDays,
    norms,
    daily,
    noNvTotals,
    returningTotals,
    rank,
    overridesByDate,
  }
}

// ─── Ручная правка факта МП — ТОЛЬКО владелец/руководитель ────────────────────
// По решению владельца: единственный источник факта МП — модуль «Записи».
// Менеджер продаж ничего не вводит и не сохраняет. Эта функция остаётся
// страховкой на случай криво оформленной записи — правку делает владелец
// (или руководитель отдела) на экране сотрудника.
//
// Правит только основной факт: fv_fact/sales_fact/revenue_fact. Колонки
// walk_in_* (миграция 049) сознательно НЕ трогаем — они не в payload, поэтому
// при upsert сохраняются как есть; их UI убран, задел на будущее оставлен.
// Пустое значение (null) = «правки нет», факт считается из консультаций.
//
// Экшен принимает простой JSON и не зависит от UI (задел под программный вызов).

export interface MpFactInput {
  /** Ручная правка авто-факта из записей. null — не трогать (оставить авто). */
  fv:      number | null
  sales:   number | null
  revenue: number | null
}

export async function saveMpDailyFact(
  employeeId: string,
  date: string,
  input: MpFactInput,
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет сессии' }

  // Только владелец/руководитель. МП (даже за себя) сохранять НЕ может — его факт
  // формируется в «Записях», ручной ввод для роли убран. isManager() отсекает и МП,
  // и ЛМ: у ЛМ после 050 есть decomposition.edit (scope='own'), но он не менеджер и
  // сюда не проходит.
  if (!isManager(me)) return { success: false, error: 'Недостаточно прав' }

  // Actor c отделом — нужен для scope-проверки цели (getViewer отдел не отдаёт).
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'decomposition', 'edit')) {
    return { success: false, error: 'Недостаточно прав' }
  }
  const scope = await getScope(actor, 'decomposition')
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  if (!date) return { success: false, error: 'Укажите дату' }

  const fields: [string, number | null][] = [
    ['ФВ',      input.fv],
    ['Продажи', input.sales],
    ['Выручка', input.revenue],
  ]
  for (const [label, v] of fields) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      return { success: false, error: `«${label}»: значение не может быть отрицательным` }
    }
  }

  const admin = createAdminClient()

  // Цель обязана быть активным менеджером продаж (не произвольный UUID, не иная роль)
  // И входить в охват актора. Это pre-check для быстрого отказа; финальная проверка
  // (защищённая от гонок) — внутри RPC save_mp_daily_fact, в той же транзакции, что и запись.
  const { data: target } = await admin
    .from('employees')
    .select('id, department_id')
    .eq('id', employeeId)
    .eq('role', 'mp')
    .is('deleted_at', null)
    .maybeSingle()
  if (!target) {
    return { success: false, error: 'Сотрудник не найден или не является менеджером продаж' }
  }
  if (!inScope(actor, scope, target.id as string, (target.department_id as string | null) ?? null)) {
    return { success: false, error: 'Сотрудник вне вашего охвата' }
  }

  // Денежная операция (revenue_fact → KPI/бонусы) идёт через транзакционную RPC с
  // повторной проверкой охвата в БД. Пишет только fv/sales/revenue; walk_in_* и зона
  // ЛМ (appeals/leads/nv) не трогаются.
  const { error } = await admin.rpc('save_mp_daily_fact', {
    p_employee_id:         employeeId,
    p_date:                date,
    p_fv:                  input.fv,
    p_sales:               input.sales,
    p_revenue:             input.revenue,
    p_actor_employee_id:   actor.employeeId,
    p_actor_scope:         scope,
    p_actor_department_id: actor.departmentId,
  })
  if (error) {
    console.error('[saveMpDailyFact]', error.code, '|', error.message)
    const msg = error.message || ''
    if (msg.includes('scope_violation')) {
      return { success: false, error: 'Сотрудник вне вашего охвата' }
    }
    if (msg.includes('target_not_mp')) {
      return { success: false, error: 'Сотрудник не найден или не является менеджером продаж' }
    }
    return { success: false, error: 'Не удалось сохранить факт' }
  }

  revalidatePath('/dashboard/decomposition')
  return { success: true }
}
