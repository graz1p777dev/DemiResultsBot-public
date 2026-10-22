'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getViewer, isManager } from '@/lib/decomposition/viewer'
import { can, getActor, getScope, inScope, isMarketingManager } from '@/lib/authz'
import { getCompanyFactDaily, getCompanyPlan, computeFunnelPlan } from './company-plan'

export type ActionResult = { success: true } | { success: false; error: string }

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface MarketingPlan {
  id:             string
  date_start:     string
  date_end:       string
  target_budget:  number
  target_appeals: number
}

export interface MarketingDailyRow {
  date:             string
  active_campaigns: number
  reach:            number
  clicks:           number
  budget:           number       // сомовый эквивалент (по курсу последнего пополнения)
  budget_usd:       number       // введённый бюджет за день, $
  ad_appeals:       number       // обращения из рекламного кабинета (таргетолог)
  lm_appeals:       number       // обращения, дошедшие до менеджера (ЛМ)
  /** Выручка компании за день — для ДРР (из общей декомпозиции, без дублирования) */
  company_revenue:  number
}

export interface TargetologData {
  employee:   { id: string; name: string }
  viewerRole: 'targetolog' | 'owner'
  isOwner:    boolean
  plan:       MarketingPlan | null
  daily:      MarketingDailyRow[]
}

// ─── Чтение данных экрана ─────────────────────────────────────────────────────

export async function getTargetologDecomposition(targetEmployeeId?: string): Promise<TargetologData | null> {
  const me = await getViewer()
  if (!me) return null
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'marketing', 'view')) return null

  const admin = createAdminClient()

  let employee: { id: string; name: string } | null = null
  if (me.role === 'targetolog') {
    employee = { id: me.id, name: me.name }
  } else if (isManager(me) && targetEmployeeId) {
    // Охват обязателен: department_head не открывает таргетолога чужого отдела.
    const scope = await getScope(actor, 'marketing')
    if (!scope) return null
    const { data } = await admin
      .from('employees')
      .select('id, name, department_id')
      .eq('id', targetEmployeeId)
      .eq('role', 'targetolog')
      .is('deleted_at', null)
      .maybeSingle()
    if (data && inScope(actor, scope, data.id as string, (data.department_id as string | null) ?? null)) {
      employee = { id: data.id as string, name: data.name as string }
    }
  } else {
    return null
  }
  if (!employee) return null

  const viewerRole: 'targetolog' | 'owner' = me.role === 'targetolog' ? 'targetolog' : 'owner'

  // Активный план маркетинга на сегодня
  const today = new Date().toISOString().slice(0, 10)
  const { data: plan } = await admin
    .from('marketing_plans')
    .select('id, date_start, date_end, target_budget, target_appeals')
    .lte('date_start', today)
    .gte('date_end', today)
    .maybeSingle()

  let daily: MarketingDailyRow[] = []
  if (plan) {
    const [{ data: rows }, revenueDaily] = await Promise.all([
      admin
        .from('marketing_daily_data')
        .select('date, active_campaigns, reach, clicks, budget, budget_usd, ad_appeals, lm_appeals')
        .eq('employee_id', employee.id)
        .gte('date', plan.date_start as string)
        .lte('date', plan.date_end as string),
      // ДРР: та же дневная выручка компании, что в общей декомпозиции
      getCompanyFactDaily(plan.date_start as string, plan.date_end as string),
    ])

    const rowByDate = new Map((rows ?? []).map(r => [r.date as string, r]))
    daily = revenueDaily.map(rd => {
      const r = rowByDate.get(rd.date)
      return {
        date:             rd.date,
        active_campaigns: Number(r?.active_campaigns ?? 0),
        reach:            Number(r?.reach ?? 0),
        clicks:           Number(r?.clicks ?? 0),
        budget:           Number(r?.budget ?? 0),
        budget_usd:       Number(r?.budget_usd ?? 0),
        ad_appeals:       Number(r?.ad_appeals ?? 0),
        lm_appeals:       Number(r?.lm_appeals ?? 0),
        company_revenue:  rd.revenue,
      }
    })
  }

  return {
    employee,
    viewerRole,
    isOwner: me.role === 'owner',
    plan: plan ? {
      id:             plan.id as string,
      date_start:     plan.date_start as string,
      date_end:       plan.date_end as string,
      target_budget:  Number(plan.target_budget),
      target_appeals: Number(plan.target_appeals),
    } : null,
    daily,
  }
}

// ─── Сохранение дневных данных ────────────────────────────────────────────────

// Курс сом/$ для даты: последнее пополнение ≤ date; до первого пополнения — самое
// раннее (чтобы ранние дни не считались по нулю); нет пополнений вовсе → null.
async function getRateForDate(
  admin: ReturnType<typeof createAdminClient>,
  employeeId: string,
  date: string,
): Promise<number | null> {
  // Детерминизм при нескольких пополнениях в одну дату — вторичная сортировка по created_at.
  const { data: le } = await admin
    .from('marketing_topups')
    .select('rate')
    .eq('employee_id', employeeId)
    .is('deleted_at', null)
    .lte('date', date)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (le?.rate != null) return Number(le.rate)
  const { data: first } = await admin
    .from('marketing_topups')
    .select('rate')
    .eq('employee_id', employeeId)
    .is('deleted_at', null)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return first?.rate != null ? Number(first.rate) : null
}

export async function saveMarketingDaily(
  employeeId: string,
  date: string,
  values: {
    active_campaigns: number; reach: number; clicks: number; ad_appeals: number
    /** новый ввод: бюджет за день в $ (пересчитывается в сомы по курсу пополнения) */
    budget_usd?: number
    /** обращения, дошедшие до менеджера (ЛМ) */
    lm_appeals?: number
    /** back-compat: прямой сомовый бюджет (старый экран таргетолога) */
    budget?: number
  },
): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет сессии' }

  const allowed = isManager(me) || (me.role === 'targetolog' && me.id === employeeId)
  if (!allowed) return { success: false, error: 'Недостаточно прав' }

  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'marketing', 'edit')) return { success: false, error: 'Недостаточно прав' }
  const scope = await getScope(actor, 'marketing')
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  if (!date) return { success: false, error: 'Укажите дату' }
  const budgetUsd  = values.budget_usd ?? 0
  const lmAppeals  = values.lm_appeals ?? 0
  const nums = [values.active_campaigns, values.reach, values.clicks, values.ad_appeals, budgetUsd, lmAppeals, values.budget ?? 0]
  if (nums.some(v => v < 0)) return { success: false, error: 'Значения не могут быть отрицательными' }

  const admin = createAdminClient()

  // Цель — активный таргетолог в охвате (pre-check; финальная проверка охвата и роли
  // атомарна с записью внутри RPC save_marketing_daily, FOR UPDATE по цели).
  const { data: target } = await admin
    .from('employees')
    .select('id, department_id')
    .eq('id', employeeId)
    .eq('role', 'targetolog')
    .is('deleted_at', null)
    .maybeSingle()
  if (!target) return { success: false, error: 'Сотрудник не найден или не является таргетологом' }
  if (!inScope(actor, scope, target.id as string, (target.department_id as string | null) ?? null)) {
    return { success: false, error: 'Сотрудник вне вашего охвата' }
  }

  // Сомовый эквивалент бюджета: если задан $-ввод — по курсу последнего пополнения;
  // иначе (старый экран) берём переданный сомовый бюджет напрямую.
  let budgetSom = values.budget ?? 0
  if (values.budget_usd !== undefined) {
    const rate = await getRateForDate(admin, employeeId, date)
    // budget_usd>0 без курса (нет пополнений) НЕ пишем молча 0 — иначе CPI/ДРР занижены.
    if (budgetUsd > 0 && rate == null) {
      return { success: false, error: 'Нет курса: сначала добавьте пополнение рекламного счёта (дата и суммы $/сом) — из него берётся курс для пересчёта бюджета в сомы' }
    }
    budgetSom = rate != null ? Math.round(budgetUsd * rate) : 0
  }

  const { error } = await admin.rpc('save_marketing_daily', {
    p_employee_id:         employeeId,
    p_date:                date,
    p_active_campaigns:    values.active_campaigns,
    p_reach:               values.reach,
    p_clicks:              values.clicks,
    p_budget:              budgetSom,
    p_budget_usd:          budgetUsd,
    p_ad_appeals:          values.ad_appeals,
    p_lm_appeals:          lmAppeals,
    p_actor_employee_id:   actor.employeeId,
    p_actor_scope:         scope,
    p_actor_department_id: actor.departmentId,
  })
  if (error) {
    console.error('[saveMarketingDaily]', error.code, '|', error.message)
    const msg = error.message || ''
    if (msg.includes('scope_violation')) return { success: false, error: 'Сотрудник вне вашего охвата' }
    if (msg.includes('target_not_targetolog')) return { success: false, error: 'Сотрудник не найден или не является таргетологом' }
    if (msg.includes('actor_inactive')) return { success: false, error: 'Недостаточно прав' }
    return { success: false, error: 'Не удалось сохранить' }
  }

  revalidatePath('/dashboard/decomposition')
  return { success: true }
}

// ─── План маркетинга (только владелец) ────────────────────────────────────────

export async function upsertMarketingPlan(
  input: { date_start: string; date_end: string; target_budget: number; target_appeals: number },
  planId?: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const me = await getViewer()
  if (!me || me.role !== 'owner') return { success: false, error: 'Недостаточно прав' }

  if (!input.date_start || !input.date_end || input.date_end < input.date_start) {
    return { success: false, error: 'Некорректный период' }
  }
  if (input.target_budget <= 0) return { success: false, error: 'Целевой бюджет должен быть больше 0' }
  if (input.target_appeals <= 0) return { success: false, error: 'Целевые обращения должны быть больше 0' }

  const admin = createAdminClient()

  if (planId) {
    const { error } = await admin.from('marketing_plans').update(input).eq('id', planId)
    if (error) {
      if (error.code === '23P01') return { success: false, error: 'Период пересекается с существующим планом' }
      return { success: false, error: error.message }
    }
    revalidatePath('/dashboard/decomposition')
    return { success: true, id: planId }
  }

  const { data, error } = await admin
    .from('marketing_plans')
    .insert({ ...input, created_by: me.id })
    .select('id')
    .single()
  if (error || !data) {
    if (error?.code === '23P01') return { success: false, error: 'Период пересекается с существующим планом' }
    return { success: false, error: error?.message ?? 'Ошибка создания плана' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true, id: data.id as string }
}

// ─── Карточка «Отдел маркетинга» на обзоре по отделам ─────────────────────────
// Главная метрика — ОБРАЩЕНИЯ (факт / план).
//   • план  — верхний этап воронки продаж за тот же период (computeFunnelPlan.appeals);
//   • факт  — обращения по ВСЕМ каналам без двойного счёта:
//       таргет   = Σ marketing_daily_data.lm_appeals (обращения, ДОШЕДШИЕ до менеджера —
//                  та же единица, что запись в consultations; ad_appeals — это кабинетная
//                  метрика для CPI, шире реального инфлоу, поэтому для «факта» не годится);
//       остальные = count(consultations) по source, ИСКЛЮЧАЯ source='target'
//                  (иначе таргет посчитался бы дважды: и из marketing_daily_data, и из
//                   consultations). organic/partner/other считаются отдельными записями.
export interface MarketingOverviewCard {
  period:      { start: string; end: string }
  appealsPlan: number | null   // null — нет активного плана продаж
  appealsFact: number
  breakdown:   { target: number; organic: number; partner: number; other: number }
}

export async function getMarketingOverviewCard(): Promise<MarketingOverviewCard | null> {
  const actor = await getActor()
  if (!actor) return null
  // fail-closed: без права marketing.view карточка не показывает цифры
  if (!await can(actor, 'marketing', 'view')) return null
  const scope = await getScope(actor, 'marketing')
  if (!scope) return null

  // Период и план обращений — из активного плана продаж (та же воронка, что у отдела продаж).
  // getCompanyPlan внутри требует decomposition.view; нет плана/права → план прочерком.
  const admin = createAdminClient()

  // План и список таргетологов друг от друга не зависят — читаем параллельно.
  // (Раньше это были два последовательных round-trip'а по ~284 мс каждый.)
  const [plan, { data: tgs }] = await Promise.all([
    getCompanyPlan(),
    admin
      .from('employees').select('id, department_id')
      .eq('role', 'targetolog').is('deleted_at', null),
  ])

  const now = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const start = plan?.date_start ?? iso(new Date(now.getFullYear(), now.getMonth(), 1))
  const end   = plan?.date_end   ?? iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  const appealsPlan = plan ? (await computeFunnelPlan(plan)).appeals : null

  // Таргет: обращения ЛМ по таргетологам в охвате
  const scopedIds = (tgs ?? [])
    .filter(e => inScope(actor, scope, e.id as string, (e.department_id as string | null) ?? null))
    .map(e => e.id as string)

  // marketing_daily_data и consultations зависят только от start/end (и scopedIds),
  // но не друг от друга — тоже параллельно.
  const [mdRes, consRes] = await Promise.all([
    scopedIds.length > 0
      ? admin
          .from('marketing_daily_data').select('lm_appeals')
          .in('employee_id', scopedIds).gte('date', start).lte('date', end)
      : Promise.resolve({ data: [] as { lm_appeals: number | null }[] }),
    // Остальные каналы — консультации по источнику, БЕЗ source='target' (анти-двойной-счёт)
    admin
      .from('consultations').select('source')
      .is('deleted_at', null).gte('date', start).lte('date', end).neq('source', 'target'),
  ])

  const target = (mdRes.data ?? []).reduce((s, r) => s + Number(r.lm_appeals ?? 0), 0)
  const cons = consRes.data
  let organic = 0, partner = 0, other = 0
  for (const c of cons ?? []) {
    if (c.source === 'organic') organic++
    else if (c.source === 'partner') partner++
    else other++ // referral + other
  }

  return {
    period: { start, end },
    appealsPlan,
    appealsFact: target + organic + partner + other,
    breakdown: { target, organic, partner, other },
  }
}

// ─── Вкладка «Общая» отдела маркетинга: свод трёх каналов против плана ─────────
// Общий план — верхний этап воронки продаж (computeFunnelPlan.appeals), распределяется
// по каналам долями (marketing_channel_plan). Факт по каналам БЕЗ двойного счёта:
//   target  = Σ marketing_daily_data.lm_appeals; organic/partner = count(consultations по source).
//   sales/revenue = consultations по source (amount>0 / Σamount). ИТОГО — по 3 каналам
//   (referral/other вне маркетинг-плана: их нельзя запланировать как канал).
export type ChannelKey = 'target' | 'organic' | 'partner'

export interface OverviewChannelRow {
  channel:     ChannelKey
  sharePct:    number
  appealsPlan: number | null
  appealsFact: number
  sales:       number
  revenue:     number
  pct:         number | null   // appealsFact / appealsPlan
  conversion:  number | null   // sales / appealsFact
  avgCheck:    number | null   // revenue / sales
}
export interface OverviewDailyRow {
  date: string; planTotal: number | null
  target: number; organic: number; partner: number; factTotal: number
}
export interface MarketingOverview {
  period:          { start: string; end: string }
  totalPlan:       number | null
  hasDistribution: boolean
  canEdit:         boolean
  channels:        OverviewChannelRow[]
  totals:          { appealsPlan: number | null; appealsFact: number; sales: number; revenue: number; pct: number | null }
  daily:           OverviewDailyRow[]
}

function distEven(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n); const rem = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}
function daysBetween(start: string, end: string): string[] {
  const out: string[] = []
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const e = new Date(end + 'T00:00:00')
  for (const d = new Date(start + 'T00:00:00'); d <= e; d.setDate(d.getDate() + 1)) out.push(iso(new Date(d)))
  return out
}

export async function getMarketingOverview(): Promise<MarketingOverview | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'marketing', 'view')) return null   // fail-closed
  const scope = await getScope(actor, 'marketing')
  if (!scope) return null

  const plan = await getCompanyPlan()
  const now = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const start = plan?.date_start ?? iso(new Date(now.getFullYear(), now.getMonth(), 1))
  const end   = plan?.date_end   ?? iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  const totalPlan = plan ? (await computeFunnelPlan(plan)).appeals : null

  const admin = createAdminClient()

  // Независимые запросы — параллельно (было последовательно): таргетологи, consultations
  // (органика/партнёры), consultations (таргет), распределение по каналам.
  const [tgsRes, consRes, tconsRes, distRes] = await Promise.all([
    admin.from('employees').select('id, department_id').eq('role', 'targetolog').is('deleted_at', null),
    admin.from('consultations').select('date, source, amount')
      .is('deleted_at', null).gte('date', start).lte('date', end).in('source', ['organic', 'partner']),
    admin.from('consultations').select('amount')
      .eq('source', 'target').is('deleted_at', null).gte('date', start).lte('date', end),
    admin.from('marketing_channel_plan').select('channel, share_pct').eq('date_start', start).eq('date_end', end),
  ])
  const scopedIds = (tgsRes.data ?? [])
    .filter(e => inScope(actor, scope, e.id as string, (e.department_id as string | null) ?? null))
    .map(e => e.id as string)

  // Таргет-обращения (lm_appeals) по таргетологам в охвате — зависят от scopedIds
  const targetByDate = new Map<string, number>()
  let targetAppeals = 0
  if (scopedIds.length > 0) {
    const { data: md } = await admin.from('marketing_daily_data').select('date, lm_appeals')
      .in('employee_id', scopedIds).gte('date', start).lte('date', end)
    for (const r of md ?? []) {
      const v = Number(r.lm_appeals ?? 0)
      targetAppeals += v
      targetByDate.set(r.date as string, (targetByDate.get(r.date as string) ?? 0) + v)
    }
  }

  const cons = consRes.data
  const tcons = tconsRes.data

  const agg: Record<ChannelKey, { appeals: number; sales: number; revenue: number }> = {
    target:  { appeals: targetAppeals, sales: 0, revenue: 0 },
    organic: { appeals: 0, sales: 0, revenue: 0 },
    partner: { appeals: 0, sales: 0, revenue: 0 },
  }
  for (const c of tcons ?? []) { const a = Number(c.amount ?? 0); if (a > 0) { agg.target.sales++; agg.target.revenue += a } }
  const orgByDate = new Map<string, number>(), partByDate = new Map<string, number>()
  for (const c of cons ?? []) {
    const ch = c.source as 'organic' | 'partner'
    agg[ch].appeals++
    const a = Number(c.amount ?? 0); if (a > 0) { agg[ch].sales++; agg[ch].revenue += a }
    const m = ch === 'organic' ? orgByDate : partByDate
    m.set(c.date as string, (m.get(c.date as string) ?? 0) + 1)
  }

  // Распределение плана по каналам (получено параллельно выше)
  const dist = distRes.data
  const shareByCh = new Map((dist ?? []).map(d => [d.channel as ChannelKey, Number(d.share_pct)]))
  const hasDistribution = (dist ?? []).some(d => Number(d.share_pct) > 0)

  const order: ChannelKey[] = ['target', 'organic', 'partner']
  const channels: OverviewChannelRow[] = order.map(ch => {
    const a = agg[ch]
    const share = shareByCh.get(ch) ?? 0
    const appealsPlan = totalPlan != null && hasDistribution ? Math.round(totalPlan * share / 100) : null
    return {
      channel: ch, sharePct: share, appealsPlan, appealsFact: a.appeals, sales: a.sales, revenue: a.revenue,
      pct:        appealsPlan && appealsPlan > 0 ? (a.appeals / appealsPlan) * 100 : null,
      conversion: a.appeals > 0 ? (a.sales / a.appeals) * 100 : null,
      avgCheck:   a.sales > 0 ? a.revenue / a.sales : null,
    }
  })

  const appealsFact = channels.reduce((s, c) => s + c.appealsFact, 0)
  const salesTotal  = channels.reduce((s, c) => s + c.sales, 0)
  const revenueTotal = channels.reduce((s, c) => s + c.revenue, 0)

  const days = daysBetween(start, end)
  const planPerDay = totalPlan != null ? distEven(totalPlan, days.length) : null
  const daily: OverviewDailyRow[] = days.map((d, i) => {
    const t = targetByDate.get(d) ?? 0, o = orgByDate.get(d) ?? 0, p = partByDate.get(d) ?? 0
    return { date: d, planTotal: planPerDay ? planPerDay[i] : null, target: t, organic: o, partner: p, factTotal: t + o + p }
  })

  return {
    period: { start, end },
    totalPlan,
    hasDistribution,
    canEdit: await can(actor, 'marketing', 'edit'),
    channels,
    totals: {
      appealsPlan: totalPlan,
      appealsFact, sales: salesTotal, revenue: revenueTotal,
      pct: totalPlan && totalPlan > 0 ? (appealsFact / totalPlan) * 100 : null,
    },
    daily,
  }
}

// Сохранение распределения плана по каналам — ТОЛЬКО управляющая роль маркетинга. RPC с аудитом.
export async function saveChannelPlan(
  dateStart: string, dateEnd: string,
  shares: { target: number; organic: number; partner: number },
): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  // company-level мутация: только owner/руководитель (marketing.edit + scope team/all)
  if (!await isMarketingManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (!dateStart || !dateEnd || dateEnd < dateStart) return { success: false, error: 'Некорректный период' }

  const vals = [shares.target, shares.organic, shares.partner]
  if (vals.some(v => v < 0 || v > 100)) return { success: false, error: 'Доля канала — от 0 до 100%' }
  if (Math.abs(vals.reduce((a, b) => a + b, 0) - 100) > 0.5) return { success: false, error: 'Сумма долей по каналам должна быть 100%' }

  const admin = createAdminClient()
  const { error } = await admin.rpc('save_channel_plan', {
    p_date_start: dateStart, p_date_end: dateEnd,
    p_shares: shares, p_actor: actor.employeeId,
  })
  if (error) {
    console.error('[saveChannelPlan]', error.code, '|', error.message)
    const m = error.message || ''
    if (m.includes('not_marketing_manager')) return { success: false, error: 'Недостаточно прав' }
    if (m.includes('invalid_share_sum')) return { success: false, error: 'Сумма долей по каналам должна быть 100%' }
    if (m.includes('invalid_period')) return { success: false, error: 'Некорректный период' }
    return { success: false, error: 'Не удалось сохранить распределение' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true }
}

// ─── Экран «Таргет» отдела маркетинга (owner / руководитель) ──────────────────

export interface TargetologOption { id: string; name: string }

export interface MarketingTopup {
  id:         string
  date:       string
  amount_usd: number
  amount_som: number
  rate:       number
}

export interface TargetTabData {
  employee:      { id: string; name: string }
  daily:         MarketingDailyRow[]
  topups:        MarketingTopup[]
  currentRate:   number | null   // курс последнего пополнения на конец периода
  targetSales:   number          // продажи канала «таргет» из consultations за период
  targetRevenue: number          // выручка канала «таргет» из consultations за период
}

// Список таргетологов в охвате — для селектора внутри вкладки «Таргет».
export async function getMarketingTargetologs(): Promise<TargetologOption[]> {
  const actor = await getActor()
  if (!actor) return []
  if (!await can(actor, 'marketing', 'view')) return []
  const scope = await getScope(actor, 'marketing')
  if (!scope) return []

  const admin = createAdminClient()
  const { data } = await admin
    .from('employees')
    .select('id, name, department_id')
    .eq('role', 'targetolog')
    .is('deleted_at', null)
    .order('name')
  return (data ?? [])
    .filter(e => inScope(actor, scope, e.id as string, (e.department_id as string | null) ?? null))
    .map(e => ({ id: e.id as string, name: e.name as string }))
}

// Данные вкладки «Таргет» за произвольный период (период — как в продажах).
export async function getTargetTabData(
  targetEmployeeId: string,
  dateStart: string,
  dateEnd: string,
): Promise<TargetTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'marketing', 'view')) return null
  const scope = await getScope(actor, 'marketing')
  if (!scope) return null
  if (!dateStart || !dateEnd || dateEnd < dateStart) return null

  const admin = createAdminClient()
  const { data: emp } = await admin
    .from('employees')
    .select('id, name, department_id')
    .eq('id', targetEmployeeId)
    .eq('role', 'targetolog')
    .is('deleted_at', null)
    .maybeSingle()
  if (!emp) return null
  if (!inScope(actor, scope, emp.id as string, (emp.department_id as string | null) ?? null)) return null

  const [{ data: rows }, { data: tops }, revenueDaily, { data: targetCons }] = await Promise.all([
    admin.from('marketing_daily_data')
      .select('date, active_campaigns, reach, clicks, budget, budget_usd, ad_appeals, lm_appeals')
      .eq('employee_id', emp.id).gte('date', dateStart).lte('date', dateEnd),
    admin.from('marketing_topups')
      .select('id, date, amount_usd, amount_som, rate')
      .eq('employee_id', emp.id).is('deleted_at', null).lte('date', dateEnd)
      .order('date', { ascending: false }),
    getCompanyFactDaily(dateStart, dateEnd),
    // Выручка/продажи канала «таргет» за период — из consultations (по факту атрибуции)
    admin.from('consultations')
      .select('amount')
      .eq('source', 'target').is('deleted_at', null)
      .gte('date', dateStart).lte('date', dateEnd),
  ])

  const rowByDate = new Map((rows ?? []).map(r => [r.date as string, r]))
  const daily: MarketingDailyRow[] = revenueDaily.map(rd => {
    const r = rowByDate.get(rd.date)
    return {
      date:             rd.date,
      active_campaigns: Number(r?.active_campaigns ?? 0),
      reach:            Number(r?.reach ?? 0),
      clicks:           Number(r?.clicks ?? 0),
      budget:           Number(r?.budget ?? 0),
      budget_usd:       Number(r?.budget_usd ?? 0),
      ad_appeals:       Number(r?.ad_appeals ?? 0),
      lm_appeals:       Number(r?.lm_appeals ?? 0),
      company_revenue:  rd.revenue,
    }
  })

  const topups: MarketingTopup[] = (tops ?? []).map(t => ({
    id: t.id as string, date: t.date as string,
    amount_usd: Number(t.amount_usd), amount_som: Number(t.amount_som), rate: Number(t.rate),
  }))

  const targetRows = targetCons ?? []
  const targetRevenue = targetRows.reduce((s, c) => s + Number(c.amount ?? 0), 0)
  const targetSales   = targetRows.filter(c => Number(c.amount ?? 0) > 0).length

  return {
    employee: { id: emp.id as string, name: emp.name as string },
    daily,
    topups,
    currentRate: topups[0]?.rate ?? null,
    targetSales,
    targetRevenue,
  }
}

// Пополнение рекламного счёта (реестр) — ТОЛЬКО управляющая роль маркетинга.
// Через аудируемую RPC save_marketing_topup (INSERT + audit_logs атомарно, актор-чек).
// rate (сом/$) считает БД (generated). amount_som — реально списанная сумма с налогами.
export async function createMarketingTopup(
  employeeId: string,
  input: { date: string; amount_usd: number; amount_som: number; note?: string | null },
): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isMarketingManager(actor)) return { success: false, error: 'Недостаточно прав' }

  if (!input.date) return { success: false, error: 'Укажите дату пополнения' }
  if (!(input.amount_usd > 0)) return { success: false, error: 'Сумма в $ должна быть больше 0' }
  if (!(input.amount_som > 0)) return { success: false, error: 'Сумма в сомах должна быть больше 0' }

  const admin = createAdminClient()
  const { error } = await admin.rpc('save_marketing_topup', {
    p_employee_id: employeeId,
    p_date:        input.date,
    p_amount_usd:  input.amount_usd,
    p_amount_som:  input.amount_som,
    p_note:        input.note ?? null,
    p_actor:       actor.employeeId,
  })
  if (error) {
    console.error('[createMarketingTopup]', error.code, '|', error.message)
    const m = error.message || ''
    if (m.includes('not_marketing_manager')) return { success: false, error: 'Недостаточно прав' }
    if (m.includes('target_not_targetolog')) return { success: false, error: 'Сотрудник не найден или не является таргетологом' }
    if (m.includes('actor_inactive')) return { success: false, error: 'Недостаточно прав' }
    return { success: false, error: 'Не удалось сохранить пополнение' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true }
}
