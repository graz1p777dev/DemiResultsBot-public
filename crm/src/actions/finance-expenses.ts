'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }
export type Currency = 'KGS' | 'USD'

export interface ExpenseCategory {
  id: string; name: string; is_system: boolean; is_derived: boolean; source_mode: 'manual' | 'inventory'; sort_order: number
  // Неизменяемый код системной категории ('cogs'|'marketing'|'payroll'|'rent'|'services'|'other').
  // P&L классифицирует ТОЛЬКО по нему: имя владелец волен переименовать в любой момент.
  // null — пользовательская категория (в P&L попадает в прочие операционные).
  code: string | null
}
export interface Expense {
  id: string; category_id: string; name: string
  amount_original: number; currency: Currency; rate: number; amount_som: number
  expense_date: string; is_recurring: boolean; period_month: string
}
export interface ExpenseGroup {
  category: ExpenseCategory
  items: Expense[]
  sumSom: number
  derived: boolean            // Зарплаты/ФОТ — сумма из раздела Зарплата
  sharePct: number | null     // доля в структуре расходов (вертикальный анализ)
}
export interface ExpensesTabData {
  periodMonth: string
  groups: ExpenseGroup[]
  payrollSom: number          // ФОТ из salaries за месяц
  totalSom: number
  canManage: boolean          // owner/бухгалтер — управление категориями
}
export interface ExpenseInput {
  category_id: string; name: string; amount_original: number
  currency: Currency; rate: number; expense_date: string; is_recurring: boolean; period_month: string
}

// ─── Вкладка «Маркетинг» в Финансах: деньги маркетинга за месяц ────────────────
// НЕ дублирует маркетинг-декомпозицию (там ввод/метрики таргета). Здесь — только деньги.
// Fail-closed по finances.view.
//
// ВАЖНО (двойной счёт). Это ДВЕ РАЗНЫЕ сущности, складывать их нельзя:
//   targetBudgetSom — фактический РАСХОД рекламы за период (дневные бюджеты таргета).
//                     Только он является операционным расходом и входит в P&L.
//   topupsSom       — ПОПОЛНЕНИЕ рекламного счёта. Это движение денег между своими
//                     счетами (касса → рекламный кабинет), а не трата. В P&L НЕ входит,
//                     иначе пополнение 100 000 + расход 50 000 дадут 150 000 «расходов».
//                     Место пополнений — реестр маркетинга и ДДС (движение по счёту).
export interface MarketingSpend {
  periodMonth: string
  targetBudgetSom: number   // РАСХОД рекламы за месяц — единственная величина для P&L
  topupsSom: number         // пополнения рекламного счёта (реестр/ДДС, НЕ P&L)
}
// Функция-отбор «сколько маркетинга уходит в P&L» — в src/lib/finance-pnl.ts
// (здесь нельзя: 'use server' допускает только async-экспорты).
export async function getMarketingSpend(periodMonth: string): Promise<MarketingSpend | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonth)) return null
  const start = periodMonth
  const d = new Date(periodMonth + 'T00:00:00')
  const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`

  const admin = createAdminClient()
  const [{ data: md }, { data: tops }] = await Promise.all([
    admin.from('marketing_daily_data').select('budget').gte('date', start).lte('date', end),
    admin.from('marketing_topups').select('amount_som').is('deleted_at', null).gte('date', start).lte('date', end),
  ])
  return {
    periodMonth,
    targetBudgetSom: (md ?? []).reduce((s, r) => s + Number(r.budget ?? 0), 0),
    topupsSom: (tops ?? []).reduce((s, r) => s + Number(r.amount_som ?? 0), 0),
  }
}

// ─── Чтение вкладки «Расходы» за месяц (period_month = 'YYYY-MM-01') ───────────
export async function getExpensesTabData(periodMonth: string): Promise<ExpensesTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonth)) return null

  const year  = Number(periodMonth.slice(0, 4))
  const month = Number(periodMonth.slice(5, 7))
  const admin = createAdminClient()

  const [{ data: cats }, { data: exps }, { data: sal }] = await Promise.all([
    admin.from('expense_categories').select('id, name, is_system, is_derived, source_mode, sort_order, code')
      .is('deleted_at', null).order('sort_order').order('name'),
    admin.from('expenses').select('id, category_id, name, amount_original, currency, rate, amount_som, expense_date, is_recurring, period_month')
      .is('deleted_at', null).eq('period_month', periodMonth),
    admin.from('salaries').select('total_amount').eq('period_year', year).eq('period_month', month),
  ])

  const payrollSom = (sal ?? []).reduce((s, r) => s + Number(r.total_amount ?? 0), 0)
  const categories = (cats ?? []).map(c => ({
    id: c.id as string, name: c.name as string, is_system: !!c.is_system, is_derived: !!c.is_derived,
    source_mode: (c.source_mode as 'manual' | 'inventory'), sort_order: Number(c.sort_order),
    code: (c.code as string | null) ?? null,
  }))
  const byCat = new Map<string, Expense[]>()
  for (const e of exps ?? []) {
    const row: Expense = {
      id: e.id as string, category_id: e.category_id as string, name: e.name as string,
      amount_original: Number(e.amount_original), currency: e.currency as Currency, rate: Number(e.rate),
      amount_som: Number(e.amount_som), expense_date: e.expense_date as string,
      is_recurring: !!e.is_recurring, period_month: e.period_month as string,
    }
    const arr = byCat.get(row.category_id) ?? []
    arr.push(row); byCat.set(row.category_id, arr)
  }

  const groupsRaw = categories.map(cat => {
    const items = byCat.get(cat.id) ?? []
    const sumSom = cat.is_derived ? payrollSom : items.reduce((s, e) => s + e.amount_som, 0)
    return { category: cat, items, sumSom, derived: cat.is_derived }
  })
  const totalSom = groupsRaw.reduce((s, g) => s + g.sumSom, 0)
  const groups: ExpenseGroup[] = groupsRaw.map(g => ({
    ...g, sharePct: totalSom > 0 ? (g.sumSom / totalSom) * 100 : null,
  }))

  return { periodMonth, groups, payrollSom, totalSom, canManage: await isFinancesManager(actor) }
}

// ─── Нормализация валюты/курса + вызов RPC save_expense ────────────────────────
async function persistExpense(id: string | null, input: ExpenseInput, actorEmployeeId: string) {
  const admin = createAdminClient()
  const rate = input.currency === 'KGS' ? 1 : input.rate
  return admin.rpc('save_expense', {
    p_id: id,
    p_data: {
      category_id: input.category_id, name: input.name, amount_original: input.amount_original,
      currency: input.currency, rate, expense_date: input.expense_date,
      is_recurring: input.is_recurring, period_month: input.period_month,
    },
    p_actor: actorEmployeeId,
  })
}

function mapExpenseError(msg: string): string {
  if (msg.includes('category_is_derived')) return 'Зарплаты/ФОТ считаются из раздела Зарплата — вручную не вводятся'
  if (msg.includes('category_not_found')) return 'Категория не найдена'
  if (msg.includes('invalid_currency')) return 'Некорректная валюта'
  if (msg.includes('invalid_rate')) return 'Курс должен быть больше 0'
  if (msg.includes('invalid_amount')) return 'Сумма должна быть больше 0'
  if (msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('expense_not_found')) return 'Расход не найден'
  return 'Не удалось сохранить расход'
}

export async function saveExpense(id: string | null, input: ExpenseInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'finances', 'edit')) return { success: false, error: 'Недостаточно прав' }
  if (!input.name?.trim()) return { success: false, error: 'Укажите название расхода' }
  if (!(input.amount_original > 0)) return { success: false, error: 'Сумма должна быть больше 0' }
  if (input.currency === 'USD' && !(input.rate > 0)) return { success: false, error: 'Для USD укажите курс (> 0)' }
  if (!input.expense_date) return { success: false, error: 'Укажите дату' }

  const { data, error } = await persistExpense(id, input, actor.employeeId)
  if (error) { console.error('[saveExpense]', error.code, '|', error.message); return { success: false, error: mapExpenseError(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'finances', 'edit')) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_expense', { p_id: id, p_actor: actor.employeeId })
  if (error) { console.error('[deleteExpense]', error.code, '|', error.message); return { success: false, error: 'Не удалось удалить расход' } }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

// ─── Скопировать постоянные (ежемесячные) расходы из предыдущего месяца ────────
// Явная кнопка (а не авто-подстановка): предсказуемо, без случайных дублей. Пропускает
// уже существующие в текущем месяце позиции по (category_id, name).
export async function copyRecurringFromPrevMonth(periodMonth: string): Promise<{ success: true; copied: number } | { success: false; error: string }> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'finances', 'edit')) return { success: false, error: 'Недостаточно прав' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonth)) return { success: false, error: 'Некорректный месяц' }

  const d = new Date(periodMonth + 'T00:00:00')
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`
  const prevMonth = iso(prev)

  const admin = createAdminClient()
  const [{ data: prevRec }, { data: curr }] = await Promise.all([
    admin.from('expenses').select('category_id, name, amount_original, currency, rate, expense_date')
      .is('deleted_at', null).eq('period_month', prevMonth).eq('is_recurring', true),
    admin.from('expenses').select('category_id, name').is('deleted_at', null).eq('period_month', periodMonth),
  ])
  const existing = new Set((curr ?? []).map(e => `${e.category_id}|${(e.name as string).toLowerCase()}`))
  const todayInMonth = `${periodMonth.slice(0, 7)}-01`

  let copied = 0
  for (const r of prevRec ?? []) {
    const key = `${r.category_id}|${(r.name as string).toLowerCase()}`
    if (existing.has(key)) continue
    const { error } = await persistExpense(null, {
      category_id: r.category_id as string, name: r.name as string,
      amount_original: Number(r.amount_original), currency: r.currency as Currency, rate: Number(r.rate),
      expense_date: todayInMonth, is_recurring: true, period_month: periodMonth,
    }, actor.employeeId)
    if (!error) copied++
  }
  revalidatePath('/dashboard/finance')
  return { success: true, copied }
}

// ─── Категории расходов (управление — только управляющий финансов) ─────────────
export async function saveExpenseCategory(id: string | null, name: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (!name.trim()) return { success: false, error: 'Укажите название категории' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('save_expense_category', { p_id: id, p_name: name.trim(), p_actor: actor.employeeId })
  if (error) {
    const m = error.message || ''
    if (m.includes('not_finances_manager')) return { success: false, error: 'Недостаточно прав' }
    if (m.includes('duplicate')) return { success: false, error: 'Такая категория уже есть' }
    return { success: false, error: 'Не удалось сохранить категорию' }
  }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

export async function deleteExpenseCategory(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_expense_category', { p_id: id, p_actor: actor.employeeId })
  if (error) {
    const m = error.message || ''
    if (m.includes('not_finances_manager')) return { success: false, error: 'Недостаточно прав' }
    if (m.includes('system_category_protected')) return { success: false, error: 'Базовую категорию нельзя удалить' }
    if (m.includes('category_in_use')) return { success: false, error: 'В категории есть расходы — сначала перенесите/удалите их' }
    return { success: false, error: 'Не удалось удалить категорию' }
  }
  revalidatePath('/dashboard/finance')
  return { success: true }
}
