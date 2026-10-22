'use server'

// Финансы, шаг 4 — инвесторы. Учёт вложений, условий сделки, начислений за месяц и выплат.
// Начисление считается из УСЛОВИЙ (какие pct-поля заполнены), а не из названия типа —
// это устойчиво к пользовательским типам сделок и к «Смешанному» (несколько условий сразу).
//
// Чистая прибыль и выручка НЕ дублируются: переиспользуем getIncomeTabData /
// getExpensesTabData / getMarketingSpend. Формула чистой прибыли за месяц:
//   netProfit = totalIncome − expensesTotalSom − marketingSpendSom
//   где totalIncome  = выручка проданных консультаций + прочие доходы   (getIncomeTabData)
//       expensesTotalSom = все категории расходов, включая производный ФОТ (getExpensesTabData)
//       marketingSpendSom = ТОЛЬКО фактический спенд рекламы (пополнения счёта — не расход)
// Начисления/тело инвестора в expenses НЕ пишутся (обязательство, не операционный расход).

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'
import { getIncomeTabData } from './finance-income'
import { getExpensesTabData, getMarketingSpend, type Currency } from './finance-expenses'
import { marketingPnlSpend } from '@/lib/finance-pnl'
import { isMonthInDealWindow } from '@/lib/finance-investor-term'
import { daysUntil } from '@/lib/business-date'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }
export type InvestorStatus = 'active' | 'closed'
export type PayoutType = 'profit_share' | 'interest' | 'principal_return' | 'other'
export type RatePeriod = 'monthly' | 'annual' | 'term'

export interface DealType { id: string; name: string; is_system: boolean; sort_order: number }

export interface InvestorPayoutRow {
  id: string; investor_id: string; amount_som: number; payout_date: string
  period_month: string | null; payout_type: PayoutType; note: string | null
}

export interface InvestorCard {
  id: string; name: string; contact: string | null; status: InvestorStatus
  amount_original: number; currency: Currency; rate: number; amount_som: number
  deal_type_id: string; deal_type_name: string
  profit_share_pct: number | null; fixed_rate_pct: number | null; royalty_pct: number | null
  rate_period: RatePeriod | null; start_date: string | null; term_months: number | null
  principal_due_date: string | null; note: string | null
  accruedThisMonth: number        // начислено за выбранный месяц (по условиям)
  paidThisMonth: number           // выплачено за месяц, все типы (витрина в карточке)
  accrualPaidForPeriod: number    // Б2: погашение НАЧИСЛЕНИЙ за этот учётный период
  accrualOutstanding: number      // Б2: остаток начислений = начислено − погашено (≥ 0)
  principalReturnedThisMonth: number  // Б2: возврат тела за месяц — отдельное обязательство
  paidTotal: number               // выплачено всего
  principalReturned: number       // возвращено тела всего (payout_type='principal_return')
  principalOutstanding: number    // тело к возврату (осталось)
  daysToPrincipal: number | null  // дней до возврата тела (может быть отрицательным = просрочено)
  payouts: InvestorPayoutRow[]    // история выплат (по убыванию даты)
}

export interface UpcomingPrincipal {
  investor_id: string; name: string; principalOutstanding: number
  principal_due_date: string; daysToPrincipal: number
}

// График выплат: регулярное обязательство по инвестору (сколько в месяц и до какой даты).
export interface PayoutScheduleRow {
  investor_id: string; name: string; deal_type_name: string
  monthlyAmount: number       // сколько начислять/выплачивать в месяц
  isFixed: boolean            // true — фиксированный регулярный платёж; false — плавающий (от прибыли/выручки)
  basis: string               // из чего считается (для подписи)
  untilDate: string | null    // до какой даты платим (возврат тела / конец срока)
}

export interface InvestorsTabData {
  periodMonth: string
  netProfit: number         // чистая прибыль за месяц (для доли прибыли)
  revenue: number           // выручка за месяц (для роялти)
  dealTypes: DealType[]
  investors: InvestorCard[]
  totals: {
    investedTotal: number; accruedTotal: number; paidTotal: number
    accrualPaidTotal: number; accrualOutstandingTotal: number
    principalReturnedThisMonthTotal: number
    principalOutstandingTotal: number
  }
  upcomingPrincipal: UpcomingPrincipal[]
  payoutSchedule: PayoutScheduleRow[]     // регулярные обязательства: кому сколько в месяц
  canManage: boolean
}

const isPeriod = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

// «Сегодня» — в поясе компании (Asia/Bishkek), см. lib/business-date.ts.
const daysBetweenToday = (due: string): number => daysUntil(due)

const inMonth = (dateStr: string, periodMonth: string): boolean =>
  dateStr.slice(0, 7) === periodMonth.slice(0, 7)

// ─── Б2: чем гасятся начисления, а чем — тело ─────────────────────────────────
// Начисление (доля прибыли / фикс % / роялти) и возврат тела — РАЗНЫЕ обязательства.
// Раньше paidThisMonth суммировал выплаты всех типов, и разовый возврат тела на 200 000
// «погашал» месячные начисления, обнуляя их в кассовом разрыве: деньги, которые всё
// равно предстоит заплатить, исчезали из плана.
//
// Правило: начисления гасят только выплаты типов начисления и только за ТОТ ЖЕ учётный
// период. principal_return не гасит начисления никогда — он идёт отдельной строкой
// оттока (upcomingPrincipal по principal_due_date).
const ACCRUAL_PAYOUT_TYPES: readonly PayoutType[] = ['profit_share', 'interest', 'other']

// Учётный период выплаты: явный period_month, иначе — месяц фактической выплаты.
const payoutPeriod = (p: InvestorPayoutRow): string => (p.period_month ?? p.payout_date).slice(0, 7)

// Начисление за месяц по условиям сделки (суммируем компоненты — покрывает «Смешанный»).
// Вне срока сделки — строго 0.
function accrual(inv: {
  amount_som: number; profit_share_pct: number | null; fixed_rate_pct: number | null
  royalty_pct: number | null; rate_period: RatePeriod | null; term_months: number | null
  start_date: string | null; principal_due_date: string | null
}, netProfit: number, revenue: number, periodMonth: string): number {
  if (!isMonthInDealWindow(inv, periodMonth)) return 0
  let sum = 0
  if (inv.profit_share_pct != null) sum += Math.max(netProfit, 0) * (inv.profit_share_pct / 100)
  if (inv.fixed_rate_pct != null) {
    const base = inv.amount_som * (inv.fixed_rate_pct / 100)
    if (inv.rate_period === 'annual') sum += base / 12
    else if (inv.rate_period === 'term') {
      // 'term' = ставка за весь срок. Без term_months величина месячного начисления
      // не определена — раньше применялась полная ставка ЕЖЕМЕСЯЧНО (кратная переплата).
      // Срок теперь обязателен на уровне БД (CHECK investors_term_requires_months);
      // если он всё же пуст — начисляем 0, а не полную ставку.
      sum += inv.term_months && inv.term_months > 0 ? base / inv.term_months : 0
    }
    else sum += base // monthly (или не указан) — помесячно
  }
  if (inv.royalty_pct != null) sum += Math.max(revenue, 0) * (inv.royalty_pct / 100)
  return sum
}

// Фиксированная часть ежемесячного платежа (от тела по ставке) — регулярное обязательство,
// не зависящее от прибыли/выручки. Та же математика, что в accrual(), только fixed-компонент.
function fixedMonthly(amountSom: number, fixedPct: number | null, period: RatePeriod | null, termMonths: number | null): number {
  if (fixedPct == null) return 0
  const base = amountSom * (fixedPct / 100)
  if (period === 'annual') return base / 12
  if (period === 'term') return termMonths && termMonths > 0 ? base / termMonths : 0
  return base
}

// Дата окончания регулярных выплат: возврат тела, иначе начало + срок.
function scheduleUntil(principalDue: string | null, startDate: string | null, termMonths: number | null): string | null {
  if (principalDue) return principalDue
  if (startDate && termMonths && termMonths > 0) {
    const y = Number(startDate.slice(0, 4)), m = Number(startDate.slice(5, 7)), d = Number(startDate.slice(8, 10))
    const end = new Date(Date.UTC(y, m - 1 + termMonths, d))
    return end.toISOString().slice(0, 10)
  }
  return null
}

export async function getInvestorsTabData(periodMonth: string): Promise<InvestorsTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!isPeriod(periodMonth)) return null

  const admin = createAdminClient()

  // Прибыль/выручка — переиспользуем существующие расчёты (без дублирования логики).
  const [income, expenses, marketing] = await Promise.all([
    getIncomeTabData(periodMonth),
    getExpensesTabData(periodMonth),
    getMarketingSpend(periodMonth),
  ])
  const totalIncome = income?.totalIncome ?? 0
  const revenue = income?.revenue ?? 0
  const expensesTotalSom = expenses?.totalSom ?? 0
  const marketingSpendSom = marketing ? marketingPnlSpend(marketing) : 0   // без пополнений
  const netProfit = totalIncome - expensesTotalSom - marketingSpendSom

  const [{ data: types }, { data: invs }, { data: pays }] = await Promise.all([
    admin.from('investor_deal_types').select('id, name, is_system, sort_order')
      .is('deleted_at', null).order('sort_order').order('name'),
    admin.from('investors').select('id, name, contact, status, amount_original, currency, rate, amount_som, deal_type_id, profit_share_pct, fixed_rate_pct, royalty_pct, rate_period, start_date, term_months, principal_due_date, note, investor_deal_types(name)')
      .is('deleted_at', null).order('created_at'),
    admin.from('investor_payouts').select('id, investor_id, amount_som, payout_date, period_month, payout_type, note')
      .is('deleted_at', null).order('payout_date', { ascending: false }),
  ])

  const dealTypes: DealType[] = (types ?? []).map(t => ({
    id: t.id as string, name: t.name as string, is_system: !!t.is_system, sort_order: Number(t.sort_order),
  }))

  const payByInvestor = new Map<string, InvestorPayoutRow[]>()
  for (const p of pays ?? []) {
    const row: InvestorPayoutRow = {
      id: p.id as string, investor_id: p.investor_id as string, amount_som: Number(p.amount_som),
      payout_date: p.payout_date as string, period_month: (p.period_month as string | null) ?? null,
      payout_type: p.payout_type as PayoutType, note: (p.note as string | null) ?? null,
    }
    const arr = payByInvestor.get(row.investor_id) ?? []
    arr.push(row); payByInvestor.set(row.investor_id, arr)
  }

  const investors: InvestorCard[] = (invs ?? []).map(i => {
    const amount_som = Number(i.amount_som)
    const rate_period = (i.rate_period as RatePeriod | null) ?? null
    const term_months = (i.term_months as number | null) ?? null
    const profit_share_pct = i.profit_share_pct == null ? null : Number(i.profit_share_pct)
    const fixed_rate_pct = i.fixed_rate_pct == null ? null : Number(i.fixed_rate_pct)
    const royalty_pct = i.royalty_pct == null ? null : Number(i.royalty_pct)
    const myPays = payByInvestor.get(i.id as string) ?? []
    const paidTotal = myPays.reduce((s, p) => s + p.amount_som, 0)
    const paidThisMonth = myPays.filter(p => inMonth(p.payout_date, periodMonth)).reduce((s, p) => s + p.amount_som, 0)
    // Б2: погашение начислений — только типы начисления и только за этот учётный период.
    const accrualPaidForPeriod = myPays
      .filter(p => ACCRUAL_PAYOUT_TYPES.includes(p.payout_type) && payoutPeriod(p) === periodMonth.slice(0, 7))
      .reduce((s, p) => s + p.amount_som, 0)
    const principalReturnedThisMonth = myPays
      .filter(p => p.payout_type === 'principal_return' && inMonth(p.payout_date, periodMonth))
      .reduce((s, p) => s + p.amount_som, 0)
    const principalReturned = myPays.filter(p => p.payout_type === 'principal_return').reduce((s, p) => s + p.amount_som, 0)
    const principalOutstanding = Math.max(amount_som - principalReturned, 0)
    const due = (i.principal_due_date as string | null) ?? null
    const status = i.status as InvestorStatus
    const start_date = (i.start_date as string | null) ?? null
    const accruedThisMonth = status === 'active'
      ? accrual({ amount_som, profit_share_pct, fixed_rate_pct, royalty_pct, rate_period, term_months,
                  start_date, principal_due_date: due }, netProfit, revenue, periodMonth)
      : 0
    const joined = i.investor_deal_types as unknown as { name: string } | null
    return {
      id: i.id as string, name: i.name as string, contact: (i.contact as string | null) ?? null, status,
      amount_original: Number(i.amount_original), currency: i.currency as Currency, rate: Number(i.rate), amount_som,
      deal_type_id: i.deal_type_id as string, deal_type_name: joined?.name ?? '—',
      profit_share_pct, fixed_rate_pct, royalty_pct, rate_period,
      start_date, term_months,
      principal_due_date: due, note: (i.note as string | null) ?? null,
      accruedThisMonth, paidThisMonth,
      accrualPaidForPeriod,
      accrualOutstanding: Math.max(accruedThisMonth - accrualPaidForPeriod, 0),
      principalReturnedThisMonth,
      paidTotal, principalReturned, principalOutstanding,
      daysToPrincipal: due && principalOutstanding > 0 ? daysBetweenToday(due) : null,
      payouts: myPays,
    }
  })

  const totals = {
    investedTotal: investors.reduce((s, i) => s + i.amount_som, 0),
    accruedTotal: investors.reduce((s, i) => s + i.accruedThisMonth, 0),
    paidTotal: investors.reduce((s, i) => s + i.paidThisMonth, 0),
    // Б2: погашение начислений и возврат тела — раздельно.
    accrualPaidTotal: investors.reduce((s, i) => s + i.accrualPaidForPeriod, 0),
    // Остаток считаем ПОИНВЕСТОРНО и только потом суммируем: переплата одному
    // инвестору не должна закрывать недоплату другому.
    accrualOutstandingTotal: investors.reduce((s, i) => s + i.accrualOutstanding, 0),
    principalReturnedThisMonthTotal: investors.reduce((s, i) => s + i.principalReturnedThisMonth, 0),
    principalOutstandingTotal: investors.filter(i => i.status === 'active').reduce((s, i) => s + i.principalOutstanding, 0),
  }

  const upcomingPrincipal: UpcomingPrincipal[] = investors
    .filter(i => i.status === 'active' && i.principalOutstanding > 0 && i.principal_due_date)
    .map(i => ({
      investor_id: i.id, name: i.name, principalOutstanding: i.principalOutstanding,
      principal_due_date: i.principal_due_date as string, daysToPrincipal: i.daysToPrincipal ?? 0,
    }))
    .sort((a, b) => a.principal_due_date.localeCompare(b.principal_due_date))

  // График выплат: регулярные обязательства по активным инвесторам.
  // Фикс % — стабильная сумма в месяц; доля прибыли/роялти — плавающая (за текущий месяц).
  const payoutSchedule: PayoutScheduleRow[] = investors
    .filter(i => i.status === 'active')
    .map(i => {
      const fixed = fixedMonthly(i.amount_som, i.fixed_rate_pct, i.rate_period, i.term_months)
      const floating = i.accruedThisMonth - fixed
      const parts: string[] = []
      if (i.fixed_rate_pct != null) parts.push(`фикс ${i.fixed_rate_pct}%`)
      if (i.profit_share_pct != null) parts.push(`${i.profit_share_pct}% прибыли`)
      if (i.royalty_pct != null) parts.push(`роялти ${i.royalty_pct}% выручки`)
      return {
        investor_id: i.id, name: i.name, deal_type_name: i.deal_type_name,
        monthlyAmount: i.accruedThisMonth,
        isFixed: fixed > 0 && floating <= 0.01,
        basis: parts.join(' + ') || '—',
        untilDate: scheduleUntil(i.principal_due_date, i.start_date, i.term_months),
      }
    })
    .filter(r => r.monthlyAmount > 0)
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)

  return {
    periodMonth, netProfit, revenue, dealTypes, investors, totals, upcomingPrincipal, payoutSchedule,
    canManage: await isFinancesManager(actor),
  }
}

// ─── Мутации ──────────────────────────────────────────────────────────────────

export interface InvestorInput {
  name: string; contact: string; status: InvestorStatus
  amount_original: number; currency: Currency; rate: number; deal_type_id: string
  profit_share_pct: number | null; fixed_rate_pct: number | null; royalty_pct: number | null
  rate_period: RatePeriod | null; start_date: string; term_months: number | null
  principal_due_date: string; note: string
}

export interface PayoutInput {
  investor_id: string; amount_som: number; payout_date: string
  period_month: string | null; payout_type: PayoutType; note: string
}

function mapErr(msg: string): string {
  if (msg.includes('not_finances_manager') || msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('invalid_currency')) return 'Некорректная валюта'
  if (msg.includes('invalid_rate')) return 'Некорректный курс'
  if (msg.includes('invalid_amount')) return 'Некорректная сумма'
  if (msg.includes('name_required')) return 'Укажите имя инвестора'
  if (msg.includes('deal_type_required') || msg.includes('deal_type_not_found')) return 'Выберите тип сделки'
  if (msg.includes('invalid_status')) return 'Некорректный статус'
  if (msg.includes('invalid_rate_period')) return 'Некорректный период ставки'
  if (msg.includes('invalid_payout_type')) return 'Некорректный тип выплаты'
  if (msg.includes('payout_date_required')) return 'Укажите дату выплаты'
  if (msg.includes('investor_required') || msg.includes('investor_not_found')) return 'Инвестор не найден'
  if (msg.includes('system_deal_type_protected')) return 'Системный тип нельзя изменить/удалить'
  if (msg.includes('deal_type_in_use')) return 'Тип используется инвесторами'
  if (msg.includes('empty_name')) return 'Пустое название'
  return 'Не удалось сохранить'
}

export async function saveInvestor(id: string | null, input: InvestorInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const rate = input.currency === 'KGS' ? 1 : input.rate
  const { data, error } = await admin.rpc('save_investor', {
    p_id: id,
    p_data: {
      name: input.name, contact: input.contact, status: input.status,
      amount_original: input.amount_original, currency: input.currency, rate,
      deal_type_id: input.deal_type_id,
      profit_share_pct: input.profit_share_pct, fixed_rate_pct: input.fixed_rate_pct, royalty_pct: input.royalty_pct,
      rate_period: input.rate_period, start_date: input.start_date || null,
      term_months: input.term_months, principal_due_date: input.principal_due_date || null, note: input.note,
    },
    p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteInvestor(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_investor', { p_id: id, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

export async function saveInvestorPayout(id: string | null, input: PayoutInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_investor_payout', {
    p_id: id,
    p_data: {
      investor_id: input.investor_id, amount_som: input.amount_som, payout_date: input.payout_date,
      period_month: input.period_month, payout_type: input.payout_type, note: input.note,
    },
    p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteInvestorPayout(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_investor_payout', { p_id: id, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

export async function saveInvestorDealType(id: string | null, name: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_investor_deal_type', { p_id: id, p_name: name, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteInvestorDealType(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_investor_deal_type', { p_id: id, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}
