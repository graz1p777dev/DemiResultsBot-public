'use server'

// Финансы, шаг 6 — распределение прибыли. Система берёт чистую прибыль за месяц (P&L из
// Обзора) и раскладывает по долям, заданным владельцем: инвесторам / погашение долгов /
// реинвест / владельцу / свои статьи. Суммы = чистая прибыль × доля%.
//
// НИЧЕГО не дублируем:
//   чистая прибыль — getFinanceOverview().pnl.netProfit (тот же P&L-каскад, что в Обзоре)
//   начислено инвесторам — getInvestorsTabData().totals.accruedTotal (шаг 4)
//   долги — из того же getFinanceOverview (debtsTotalActiveSom + nearestDebt, шаг 3)
// «owner» — авто-остаток (100 − сумма остальных). Убыток не распределяем (берём max(netProfit,0)).
//
// Задел (шаг 7 ДДС): зафиксированные profit_distributions/_lines станут источником плановых
// выплат в отчёте о движении денег.

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'
import { getFinanceOverview, type NearestDebt } from './finance-overview'
import { getInvestorsTabData } from './finance-investors'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }

export interface DistributionRule {
  id: string; bucket: string; name: string; share_pct: number; sort_order: number; is_system: boolean
}
export interface DistributionLine { bucket: string; name: string; share_pct: number; amount: number }
export interface FixedDistribution {
  id: string; period_month: string; net_profit_som: number; created_at: string; lines: DistributionLine[]
}

export interface ProfitDistributionData {
  periodMonth: string
  netProfit: number                 // чистая прибыль до распределения (из P&L)
  rules: DistributionRule[]          // owner.share_pct нормализован как остаток
  computed: DistributionLine[]       // раскладка: net_profit × доля%
  totalNonOwnerPct: number           // сумма долей без owner (контроль ≤100)
  // Сверка с другими вкладками
  investorsRuleAmount: number        // по правилу «инвесторам»
  investorsAccrued: number           // фактически начислено инвесторам за месяц (шаг 4)
  debtRuleAmount: number             // по правилу «погашение долгов»
  debtsTotalActiveSom: number        // всего активных долгов (шаг 3)
  nearestDebt: NearestDebt | null
  fixed: FixedDistribution | null    // последний зафиксированный снимок за месяц
  canManage: boolean
}

const isPeriod = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

// Нормализация: owner = 100 − сумма остальных; суммы = max(netProfit,0) × доля%.
function computeLines(rules: DistributionRule[], netProfit: number): { rules: DistributionRule[]; lines: DistributionLine[]; nonOwner: number } {
  const nonOwner = rules.filter(r => r.bucket !== 'owner').reduce((s, r) => s + r.share_pct, 0)
  const base = Math.max(netProfit, 0)
  const normRules = rules.map(r => r.bucket === 'owner' ? { ...r, share_pct: Math.max(100 - nonOwner, 0) } : r)
  const lines = normRules.map(r => ({ bucket: r.bucket, name: r.name, share_pct: r.share_pct, amount: base * (r.share_pct / 100) }))
  return { rules: normRules, lines, nonOwner }
}

export async function getProfitDistributionData(periodMonth: string): Promise<ProfitDistributionData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!isPeriod(periodMonth)) return null

  const admin = createAdminClient()
  const [overview, investors, { data: ruleRows }, { data: distRows }] = await Promise.all([
    getFinanceOverview(periodMonth),
    getInvestorsTabData(periodMonth),
    admin.from('profit_distribution_rules').select('id, bucket, name, share_pct, sort_order, is_system')
      .is('deleted_at', null).order('sort_order'),
    admin.from('profit_distributions').select('id, period_month, net_profit_som, created_at, profit_distribution_lines(bucket, name, share_pct, amount_som)')
      .is('deleted_at', null).eq('period_month', periodMonth).order('created_at', { ascending: false }).limit(1),
  ])
  if (!overview) return null

  const netProfit = overview.pnl.netProfit
  const rawRules: DistributionRule[] = (ruleRows ?? []).map(r => ({
    id: r.id as string, bucket: r.bucket as string, name: r.name as string,
    share_pct: Number(r.share_pct), sort_order: Number(r.sort_order), is_system: !!r.is_system,
  }))
  const { rules, lines, nonOwner } = computeLines(rawRules, netProfit)

  const investorsRuleAmount = lines.filter(l => l.bucket === 'investors').reduce((s, l) => s + l.amount, 0)
  const debtRuleAmount = lines.filter(l => l.bucket === 'debt_repayment').reduce((s, l) => s + l.amount, 0)

  const dist = (distRows ?? [])[0]
  const fixed: FixedDistribution | null = dist ? {
    id: dist.id as string, period_month: dist.period_month as string,
    net_profit_som: Number(dist.net_profit_som), created_at: dist.created_at as string,
    lines: ((dist.profit_distribution_lines as unknown as { bucket: string; name: string; share_pct: number; amount_som: number }[]) ?? [])
      .map(l => ({ bucket: l.bucket, name: l.name, share_pct: Number(l.share_pct), amount: Number(l.amount_som) })),
  } : null

  return {
    periodMonth, netProfit, rules, computed: lines, totalNonOwnerPct: nonOwner,
    investorsRuleAmount, investorsAccrued: investors?.totals.accruedTotal ?? 0,
    debtRuleAmount, debtsTotalActiveSom: overview.debtsTotalActiveSom, nearestDebt: overview.nearestDebt,
    fixed, canManage: await isFinancesManager(actor),
  }
}

// ─── Мутации ──────────────────────────────────────────────────────────────────

export interface RuleInput { bucket: string; name: string; share_pct: number; sort_order: number; is_system: boolean }

function mapErr(msg: string): string {
  if (msg.includes('not_finances_manager') || msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('shares_exceed_100')) return 'Сумма долей превышает 100%'
  if (msg.includes('invalid_share')) return 'Доля должна быть 0–100%'
  if (msg.includes('name_required')) return 'Укажите название статьи'
  if (msg.includes('rules_required')) return 'Нужна хотя бы одна статья'
  if (msg.includes('period_required')) return 'Не указан месяц'
  return 'Не удалось сохранить'
}

export async function saveDistributionRules(rules: RuleInput[]): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('save_distribution_rules', { p_rules: rules, p_actor: actor.employeeId })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

// Фиксация снимка: чистая прибыль и строки считаются НА СЕРВЕРЕ (из P&L и правил),
// клиенту не доверяем — переиспользуем getFinanceOverview/правила заново.
export async function fixProfitDistribution(periodMonth: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (!isPeriod(periodMonth)) return { success: false, error: 'Некорректный месяц' }

  const admin = createAdminClient()
  const [overview, { data: ruleRows }] = await Promise.all([
    getFinanceOverview(periodMonth),
    admin.from('profit_distribution_rules').select('id, bucket, name, share_pct, sort_order, is_system')
      .is('deleted_at', null).order('sort_order'),
  ])
  if (!overview) return { success: false, error: 'Нет данных P&L' }

  const rawRules: DistributionRule[] = (ruleRows ?? []).map(r => ({
    id: r.id as string, bucket: r.bucket as string, name: r.name as string,
    share_pct: Number(r.share_pct), sort_order: Number(r.sort_order), is_system: !!r.is_system,
  }))
  const { lines } = computeLines(rawRules, overview.pnl.netProfit)
  const payloadLines = lines.map(l => ({ bucket: l.bucket, name: l.name, share_pct: l.share_pct, amount_som: l.amount }))

  const { data, error } = await admin.rpc('save_profit_distribution', {
    p_period: periodMonth, p_net_profit: overview.pnl.netProfit, p_lines: payloadLines, p_actor: actor.employeeId,
  })
  if (error) return { success: false, error: mapErr(error.message) }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}
