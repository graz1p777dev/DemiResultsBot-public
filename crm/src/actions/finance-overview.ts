'use server'

// Финансы, шаг 5 — «Обзор»: реальный управленческий P&L за месяц. Никакого mock.
// Всё считается ПЕРЕИСПОЛЬЗОВАНИЕМ существующих функций (без дублирования логики):
//   getIncomeTabData  — выручка продаж, прочие доходы, кол-во продаж
//   getExpensesTabData — категории расходов (себестоимость / ФОТ(из salaries) / опер.)
//   getMarketingSpend — траты на рекламу из маркетинг-декомпозиции (ТОЛЬКО спенд, без пополнений)
//   getDebtsTabData   — обязательства (для блока «Долги»)
//
// P&L-каскад:
//   Выручка + Прочие доходы = Итого доход
//   − Себестоимость товара                       = Валовая прибыль
//   − Операционные расходы (опер.категории + маркетинг) − ФОТ = Операционная = Чистая прибыль
//   (инвесторов/долги в Обзоре НЕ вычитаем — это будущий Шаг 6 «Распределение»).
//
// ДВОЙНОЙ СЧЁТ МАРКЕТИНГА: «маркетинг» в P&L = категория расходов с кодом 'marketing'
// (ручные маркетинг-траты из expenses) + marketingPnlSpend() — фактический спенд рекламного
// кабинета из декомпозиции. Это РАЗНЫЕ источники (разные таблицы), поэтому суммируются как
// взаимодополняющие, без задвоения. Рекламные траты вводятся ТОЛЬКО в декомпозиции
// (см. вкладку «Маркетинг»), в категорию «Маркетинг» расходов их дублировать не нужно.
// ПОПОЛНЕНИЯ рекламного счёта (marketing_topups) в P&L НЕ входят — это движение денег
// между своими счетами, а не расход (см. комментарий к MarketingSpend).
//
// КЛАССИФИКАЦИЯ — ПО КОДУ, НЕ ПО ИМЕНИ: категорию можно переименовать (save_expense_category),
// поэтому 'Себестоимость товара'/'Маркетинг' как строки-ключи ломали бы P&L. Ключ — code.

import { getActor, can } from '@/lib/authz'
import { getIncomeTabData } from './finance-income'
import { getExpensesTabData, getMarketingSpend } from './finance-expenses'
import { getDebtsTabData } from './finance-debts'
import { isCogs, isMarketing, marketingPnlSpend } from '@/lib/finance-pnl'

// Подписи строк отчёта. Имя категории может быть любым — в структуре расходов
// показываем фактическое имя из БД, а классифицируем по коду.
const COGS_FALLBACK_LABEL = 'Себестоимость товара'


export interface ExpenseStructureLine { name: string; sum: number; sharePct: number | null }

export interface PnlSnapshot {
  revenue: number; otherIncome: number; totalIncome: number
  cogs: number; grossProfit: number
  operatingExpenses: number; marketingTotal: number; payroll: number
  netProfit: number; marginPct: number | null; salesCount: number
}

export interface NearestDebt { creditor: string; amountSom: number; dueDate: string; daysLeft: number | null }

export interface FinanceOverviewData {
  periodMonth: string
  pnl: PnlSnapshot
  grossMarginPct: number | null
  avgCheck: number
  // Структура расходов (вертикальный анализ)
  expenseStructure: ExpenseStructureLine[]
  totalExpenses: number
  // Точка безубыточности
  fixedCosts: number
  contributionMarginPct: number | null   // маржинальность = (выручка − себестоимость) / выручка
  breakevenRevenue: number | null
  breakevenGap: number                    // выручка − безубыточность (>0 перевыполнено, <0 осталось)
  breakevenReached: boolean
  // Сравнение с прошлым месяцем
  prev: { revenue: number; netProfit: number; marginPct: number | null }
  delta: { revenuePct: number | null; netProfitPct: number | null; marginPp: number | null }
  // Долги (обязательства)
  debtsTotalActiveSom: number
  nearestDebt: NearestDebt | null
}

const isPeriod = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

function prevPeriod(periodMonth: string): string {
  const y = Number(periodMonth.slice(0, 4)), m = Number(periodMonth.slice(5, 7))
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}-01`
}

const pctChange = (cur: number, prev: number): number | null =>
  prev === 0 ? (cur === 0 ? 0 : null) : ((cur - prev) / Math.abs(prev)) * 100

// Ядро P&L за месяц — переиспользует доходы/расходы/маркетинг. Возвращает null при отказе прав.
async function computePnl(periodMonth: string): Promise<PnlSnapshot | null> {
  const [income, expenses, marketing] = await Promise.all([
    getIncomeTabData(periodMonth),
    getExpensesTabData(periodMonth),
    getMarketingSpend(periodMonth),
  ])
  if (!income || !expenses || !marketing) return null

  const revenue = income.revenue
  const otherIncome = income.otherSom
  const totalIncome = income.totalIncome
  const salesCount = income.salesCount

  const cogs = expenses.groups.find(g => isCogs(g.category))?.sumSom ?? 0
  const payroll = expenses.payrollSom  // категория с кодом 'payroll' (is_derived) из salaries
  const marketingCat = expenses.groups.find(g => isMarketing(g.category))?.sumSom ?? 0
  const marketingSpend = marketingPnlSpend(marketing)   // только спенд, БЕЗ пополнений
  const marketingTotal = marketingCat + marketingSpend
  // Прочие опер.категории: не себестоимость, не ФОТ(derived), не маркетинг (учтён отдельно)
  const otherOpex = expenses.groups
    .filter(g => !g.derived && !isCogs(g.category) && !isMarketing(g.category))
    .reduce((s, g) => s + g.sumSom, 0)
  const operatingExpenses = otherOpex + marketingTotal

  const grossProfit = totalIncome - cogs
  const netProfit = grossProfit - operatingExpenses - payroll

  return {
    revenue, otherIncome, totalIncome, cogs, grossProfit,
    operatingExpenses, marketingTotal, payroll,
    netProfit, marginPct: revenue > 0 ? (netProfit / revenue) * 100 : null, salesCount,
  }
}

export async function getFinanceOverview(periodMonth: string): Promise<FinanceOverviewData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!isPeriod(periodMonth)) return null

  const [pnl, prevPnl, expenses, marketing, debts] = await Promise.all([
    computePnl(periodMonth),
    computePnl(prevPeriod(periodMonth)),
    getExpensesTabData(periodMonth),
    getMarketingSpend(periodMonth),
    getDebtsTabData(),
  ])
  if (!pnl || !expenses || !marketing || !debts) return null

  // ── Структура расходов (доли от совокупных расходов месяца) ──
  const marketingSpend = marketingPnlSpend(marketing)   // только спенд, БЕЗ пополнений
  const marketingGroup = expenses.groups.find(g => isMarketing(g.category))
  const marketingCat = marketingGroup?.sumSom ?? 0
  const cogsGroup = expenses.groups.find(g => isCogs(g.category))
  const lines: { name: string; sum: number }[] = []
  lines.push({ name: cogsGroup?.category.name ?? COGS_FALLBACK_LABEL, sum: pnl.cogs })
  for (const g of expenses.groups) {
    if (g.derived) continue
    if (isCogs(g.category) || isMarketing(g.category)) continue
    lines.push({ name: g.category.name, sum: g.sumSom })
  }
  lines.push({ name: `${marketingGroup?.category.name ?? 'Маркетинг'} (реклама + ручные)`, sum: marketingCat + marketingSpend })
  lines.push({ name: 'Зарплаты / ФОТ', sum: pnl.payroll })
  const totalExpenses = pnl.cogs + pnl.operatingExpenses + pnl.payroll
  const expenseStructure: ExpenseStructureLine[] = lines
    .map(l => ({ name: l.name, sum: l.sum, sharePct: totalExpenses > 0 ? (l.sum / totalExpenses) * 100 : null }))
    .sort((a, b) => b.sum - a.sum)

  // ── Точка безубыточности ──
  // Переменные ≈ себестоимость (масштабируется с продажами); постоянные = опер.расходы + ФОТ.
  // Маржинальность = (выручка − себестоимость) / выручка. Безубыточность = постоянные / маржинальность.
  // Если себестоимости нет (маржинальность = 1) — безубыточность ≈ постоянные расходы (упрощённо).
  const fixedCosts = pnl.operatingExpenses + pnl.payroll
  const cmr = pnl.revenue > 0 ? (pnl.revenue - pnl.cogs) / pnl.revenue : null
  const breakevenRevenue = cmr && cmr > 0 ? fixedCosts / cmr : null
  const breakevenGap = breakevenRevenue === null ? 0 : pnl.revenue - breakevenRevenue
  const breakevenReached = breakevenRevenue !== null && pnl.revenue >= breakevenRevenue

  // ── Сравнение с прошлым месяцем ──
  const prev = prevPnl ?? { revenue: 0, netProfit: 0, marginPct: null }
  const delta = {
    revenuePct: pctChange(pnl.revenue, prev.revenue),
    netProfitPct: pctChange(pnl.netProfit, prev.netProfit),
    marginPp: pnl.marginPct !== null && prev.marginPct !== null ? pnl.marginPct - prev.marginPct : null,
  }

  // ── Долги: всего активных + ближайший возврат ──
  const nearest = debts.active[0]  // active[] отсортирован по due_date (ближайший/просроченный сверху)
  const nearestDebt: NearestDebt | null = nearest
    ? { creditor: nearest.creditor_name, amountSom: nearest.amount_som, dueDate: nearest.due_date, daysLeft: nearest.daysLeft }
    : null

  return {
    periodMonth,
    pnl,
    grossMarginPct: pnl.totalIncome > 0 ? (pnl.grossProfit / pnl.totalIncome) * 100 : null,
    avgCheck: pnl.salesCount > 0 ? pnl.revenue / pnl.salesCount : 0,
    expenseStructure, totalExpenses,
    fixedCosts, contributionMarginPct: cmr === null ? null : cmr * 100,
    breakevenRevenue, breakevenGap, breakevenReached,
    prev: { revenue: prev.revenue, netProfit: prev.netProfit, marginPct: prev.marginPct },
    delta,
    debtsTotalActiveSom: debts.totalActiveSom,
    nearestDebt,
  }
}
