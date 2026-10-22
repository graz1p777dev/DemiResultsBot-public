'use server'

// Финансы, шаг 7 (финал) — движение денег (ДДС / Cash Flow). Реальные деньги по счетам +
// предупреждение о кассовом разрыве. Предстоящие выплаты (долги + возврат тела инвесторам +
// начисления инвесторам за месяц) НЕ дублируются — берутся из getDebtsTabData/getInvestorsTabData.
//
// Остаток по счёту = Σ(in.amount_som) − Σ(out.amount_som) по движениям ДО/НА сегодня.
// Будущие движения (дата > сегодня) в «текущий» остаток НЕ входят — иначе завтрашнее
// поступление закрывало бы сегодняшний разрыв. Они идут отдельной лентой прогноза.
//
// Ликвидность: в общий остаток входят активные счета. Остатки ЗАКРЫТЫХ счетов не теряются
// молча — они выделены в closedBalanceSom и исключены из ликвидности (деньги на закрытом
// счёте недоступны для выплат; если остаток ненулевой — это сигнал перевести их).
//
// Кассовый разрыв: прогоняем текущий общий остаток по датам предстоящих выплат; если перед
// выплатой остаток < суммы → разрыв (дата + нехватка). Выплаты одной даты агрегируются,
// поэтому результат не зависит от порядка строк.

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'
import { getDebtsTabData } from './finance-debts'
import { getInvestorsTabData } from './finance-investors'
import type { Currency } from './finance-expenses'
import { businessToday } from '@/lib/business-date'
import { computeCashGap } from '@/lib/finance-cash-gap'
import type { UpcomingItem, GapDay, CashGapResult } from '@/lib/finance-cash-gap'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }
export type AccountType = 'cash' | 'bank' | 'other'
export type AccountStatus = 'active' | 'closed'
export type Direction = 'in' | 'out'
export type CashCategory = 'revenue' | 'expense' | 'salary' | 'debt_repayment' | 'investor_payout' | 'transfer' | 'other'

export interface CashAccount {
  id: string; name: string; account_type: AccountType; currency: Currency; is_system: boolean
  sort_order: number; status: AccountStatus
  balanceSom: number; balanceOriginal: number   // balanceOriginal — в валюте счёта (для USD)
}
export interface CashMovementRow {
  id: string; account_id: string; account_name: string; direction: Direction
  amount_original: number; currency: Currency; rate: number; amount_som: number
  movement_date: string; category: CashCategory; note: string | null
}
// Расчёт разрыва — в чистом модуле finance-cash-gap.ts (проверяем без БД).
export type UpcomingPayment = GapDay
export type CashGap = CashGapResult

export interface CashFlowData {
  periodMonth: string
  accounts: CashAccount[]
  totalBalanceSom: number           // ликвидность: активные счета, движения по сегодня
  closedBalanceSom: number          // остатки закрытых счетов — вне ликвидности, но видимы
  futureMovementsSom: number        // нетто будущих движений (в остаток не входит)
  movements: CashMovementRow[]      // за выбранный месяц
  inSom: number; outSom: number     // итоги месяца
  gap: CashGap
  canManage: boolean
}

const isPeriod = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
const monthEnd = (periodMonth: string): string => {
  const y = Number(periodMonth.slice(0, 4)), m = Number(periodMonth.slice(5, 7))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

export async function getCashFlowData(periodMonth: string): Promise<CashFlowData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!isPeriod(periodMonth)) return null
  const start = periodMonth, end = monthEnd(periodMonth)

  // «Сегодня» — граница между фактом и прогнозом. Берём дату в поясе компании
  // (Asia/Bishkek): на UTC-сервере до 06:00 по Бишкеку сегодняшние движения
  // считались будущими и выпадали из текущего остатка.
  const today = businessToday()

  const admin = createAdminClient()
  const [{ data: accRows }, { data: allMov }, { data: monthMov }, debts, investors] = await Promise.all([
    admin.from('cash_accounts').select('id, name, account_type, currency, is_system, sort_order, status')
      .is('deleted_at', null).order('sort_order'),
    // все движения (для текущего остатка по счёту — накопительно, не только за месяц)
    admin.from('cash_movements').select('account_id, direction, amount_original, currency, amount_som, movement_date, category, note')
      .is('deleted_at', null),
    // движения за выбранный месяц (для списка)
    admin.from('cash_movements').select('id, account_id, direction, amount_original, currency, rate, amount_som, movement_date, category, note')
      .is('deleted_at', null).gte('movement_date', start).lte('movement_date', end).order('movement_date', { ascending: false }),
    getDebtsTabData(),
    getInvestorsTabData(periodMonth),
  ])

  // ── Остатки по счетам (накопительно) ──
  const balSom = new Map<string, number>()
  const balOrig = new Map<string, number>()
  const accCurrency = new Map<string, string>((accRows ?? []).map(a => [a.id as string, a.currency as string]))
  // Будущие движения — отдельно: в текущий остаток не входят, идут в прогноз.
  const future: { date: string; label: string; amountSom: number }[] = []
  let futureMovementsSom = 0
  for (const m of allMov ?? []) {
    const acc = m.account_id as string
    const sign = m.direction === 'in' ? 1 : -1
    const mDate = m.movement_date as string
    const signed = sign * Number(m.amount_som)
    if (mDate > today) {
      futureMovementsSom += signed
      // Переводы между своими счетами общий баланс не меняют — в прогноз не идут.
      if ((m.category as string) !== 'transfer') {
        future.push({
          date: mDate,
          label: `${sign > 0 ? 'Плановое поступление' : 'Плановое списание'}${m.note ? ': ' + (m.note as string) : ''}`,
          amountSom: signed,
        })
      }
      continue
    }
    balSom.set(acc, (balSom.get(acc) ?? 0) + signed)
    // balanceOriginal считаем только по движениям в валюте счёта
    if ((m.currency as string) === accCurrency.get(acc)) {
      balOrig.set(acc, (balOrig.get(acc) ?? 0) + sign * Number(m.amount_original))
    }
  }
  const accounts: CashAccount[] = (accRows ?? []).map(a => ({
    id: a.id as string, name: a.name as string, account_type: a.account_type as AccountType,
    currency: a.currency as Currency, is_system: !!a.is_system, sort_order: Number(a.sort_order),
    status: a.status as AccountStatus,
    balanceSom: balSom.get(a.id as string) ?? 0, balanceOriginal: balOrig.get(a.id as string) ?? 0,
  }))
  // Ликвидность — только активные счета. Закрытые показываем отдельной суммой:
  // деньги с них недоступны, но и «потерять» их в отчёте нельзя.
  const totalBalanceSom  = accounts.filter(a => a.status === 'active').reduce((s, a) => s + a.balanceSom, 0)
  const closedBalanceSom = accounts.filter(a => a.status === 'closed').reduce((s, a) => s + a.balanceSom, 0)

  const accName = new Map(accounts.map(a => [a.id, a.name]))
  const movements: CashMovementRow[] = (monthMov ?? []).map(m => ({
    id: m.id as string, account_id: m.account_id as string, account_name: accName.get(m.account_id as string) ?? '—',
    direction: m.direction as Direction, amount_original: Number(m.amount_original), currency: m.currency as Currency,
    rate: Number(m.rate), amount_som: Number(m.amount_som), movement_date: m.movement_date as string,
    category: m.category as CashCategory, note: (m.note as string | null) ?? null,
  }))
  const inSom = movements.filter(m => m.direction === 'in').reduce((s, m) => s + m.amount_som, 0)
  const outSom = movements.filter(m => m.direction === 'out').reduce((s, m) => s + m.amount_som, 0)

  // ── Кассовый разрыв: предстоящие выплаты по датам (переиспуем долги/инвесторов) ──
  const upcoming: UpcomingItem[] = []
  // Долги: активные по due_date
  for (const d of debts?.active ?? []) {
    upcoming.push({ date: d.due_date, label: `Возврат долга: ${d.creditor_name}`, amountSom: d.amount_som, source: 'debt' })
  }
  // Возврат тела инвесторам: по principal_due_date
  for (const u of investors?.upcomingPrincipal ?? []) {
    upcoming.push({ date: u.principal_due_date, label: `Возврат тела: ${u.name}`, amountSom: u.principalOutstanding, source: 'investor_principal' })
  }
  // Начисления инвесторам за месяц — обязательство к концу месяца (единой строкой).
  // Б5: платить нужно ОСТАТОК обязательства — начислено минус уже выплаченное.
  // Б2: гасят его ТОЛЬКО выплаты типов начисления за тот же учётный период.
  // Возврат тела (principal_return) сюда не входит — это отдельное обязательство,
  // и оно уже стоит в плане отдельной строкой «Возврат тела» выше (upcomingPrincipal).
  // Раньше возврат тела вычитался из начислений и обнулял их: 200 000 возврата
  // «съедали» 30 000 начислений, и месячное обязательство пропадало из кассового плана.
  const invOutstanding = investors?.totals.accrualOutstandingTotal ?? 0
  if (invOutstanding > 0) {
    upcoming.push({ date: end, label: 'Начисления инвесторам за месяц (остаток к выплате)', amountSom: invOutstanding, source: 'investor_accrual' })
  }
  // Запланированные будущие движения по счетам (в текущий остаток не входят).
  for (const f of future) {
    upcoming.push({ date: f.date, label: f.label, amountSom: -f.amountSom, source: 'planned_movement' })
  }

  // Б5: агрегация по ДАТЕ и прогон running-balance — в computeCashGap. Разрыв не
  // зависит от порядка строк во входном массиве (см. finance-cash-gap.ts).
  const gap = computeCashGap(totalBalanceSom, upcoming)

  return {
    periodMonth, accounts, totalBalanceSom, closedBalanceSom, futureMovementsSom, movements, inSom, outSom,
    gap,
    canManage: await isFinancesManager(actor),
  }
}

// ─── Мутации ──────────────────────────────────────────────────────────────────

export interface AccountInput { name: string; account_type: AccountType; currency: Currency; status: AccountStatus; sort_order: number }
export interface MovementInput {
  account_id: string; direction: Direction; amount_original: number; currency: Currency; rate: number
  movement_date: string; category: CashCategory; note: string
}

function mapErr(msg: string): string {
  if (msg.includes('not_finances_manager') || msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('invalid_currency')) return 'Некорректная валюта'
  if (msg.includes('invalid_rate')) return 'Некорректный курс'
  if (msg.includes('invalid_amount')) return 'Некорректная сумма'
  if (msg.includes('invalid_direction')) return 'Некорректное направление'
  if (msg.includes('invalid_category')) return 'Некорректная категория'
  if (msg.includes('invalid_account_type')) return 'Некорректный тип счёта'
  if (msg.includes('invalid_status')) return 'Некорректный статус'
  if (msg.includes('name_required')) return 'Укажите название счёта'
  if (msg.includes('date_required')) return 'Укажите дату'
  if (msg.includes('account_required') || msg.includes('account_not_found')) return 'Счёт не найден'
  if (msg.includes('system_account_protected')) return 'Системный счёт нельзя удалить'
  if (msg.includes('account_in_use')) return 'На счёте есть движения — удалить нельзя'
  if (msg.includes('account_closed')) return 'Счёт закрыт — движения по нему запрещены'
  if (msg.includes('transfer_requires_pair')) return 'Перевод оформляется парой счетов (откуда → куда)'
  if (msg.includes('same_account')) return 'Счета должны отличаться'
  return 'Не удалось сохранить'
}

export async function saveCashAccount(id: string | null, input: AccountInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_cash_account', {
    p_id: id, p_data: { name: input.name, account_type: input.account_type, currency: input.currency, status: input.status, sort_order: input.sort_order }, p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteCashAccount(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_cash_account', { p_id: id, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

export async function saveCashMovement(id: string | null, input: MovementInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const rate = input.currency === 'KGS' ? 1 : input.rate
  const { data, error } = await admin.rpc('save_cash_movement', {
    p_id: id,
    p_data: {
      account_id: input.account_id, direction: input.direction, amount_original: input.amount_original,
      currency: input.currency, rate, movement_date: input.movement_date, category: input.category, note: input.note,
    },
    p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

// Перевод между своими счетами — атомарной парой out/in (RPC save_cash_transfer).
// Одностороннее движение с category='transfer' RPC теперь отклоняет (transfer_requires_pair):
// половина перевода искажала бы общий баланс — деньги «исчезали» или «появлялись».
export interface TransferInput {
  from_account_id: string; to_account_id: string
  amount_original: number; currency: Currency; rate: number
  movement_date: string; note: string
}
export async function saveCashTransfer(input: TransferInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (input.from_account_id === input.to_account_id) return { success: false, error: 'Счета должны отличаться' }
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_cash_transfer', {
    p_from: input.from_account_id, p_to: input.to_account_id,
    p_amount_original: input.amount_original, p_currency: input.currency,
    p_rate: input.currency === 'KGS' ? 1 : input.rate,
    p_date: input.movement_date, p_note: input.note, p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteCashMovement(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_cash_movement', { p_id: id, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}
