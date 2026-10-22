'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'
import type { Currency } from './finance-expenses'
import { getUnlinkedInventorySalesDaily, sumInventorySales } from '@/lib/analytics/inventory-sales'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }

// Тот же способ подсчёта выручки, что в декомпозиции (company-plan.isSold): продажа =
// status_after_fv ∈ ('Купила','Предоплата'); выручка = сумма amount по проданным.
const isSold = (s: string | null) => s === 'Купила' || s === 'Предоплата'

export type ChannelKey = 'target' | 'organic' | 'partner' | 'referral' | 'other'
const CHANNELS: ChannelKey[] = ['target', 'organic', 'partner', 'referral', 'other']
// CHANNEL_LABEL вынесен в '@/lib/finance-labels' — 'use server' файл не может
// экспортировать объект (только async-функции).

export interface IncomeChannel { channel: ChannelKey; revenue: number; sharePct: number | null }
export interface OtherIncomeRow {
  id: string; name: string; amount_original: number; currency: Currency; rate: number; amount_som: number; income_date: string
}
export interface IncomeTabData {
  periodMonth:  string
  revenue:      number                       // выручка от продаж (isSold)
  byChannel:    IncomeChannel[]              // разбивка по source (сумма = revenue)
  byType:       { booked: number; walkin: number; bookedPct: number | null; walkinPct: number | null }
  other:        OtherIncomeRow[]
  otherSom:     number
  totalIncome:  number                       // выручка + прочие
  salesCount:   number                       // кол-во проданных консультаций (isSold) за месяц
  canManage:    boolean
}
export interface OtherIncomeInput {
  name: string; amount_original: number; currency: Currency; rate: number; income_date: string; period_month: string
}

function monthEnd(periodMonth: string): string {
  const d = new Date(periodMonth + 'T00:00:00')
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
}

export async function getIncomeTabData(periodMonth: string): Promise<IncomeTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonth)) return null
  const start = periodMonth, end = monthEnd(periodMonth)

  const admin = createAdminClient()
  const [{ data: cons }, { data: other }, inventoryDays] = await Promise.all([
    admin.from('consultations').select('source, is_nv, status_after_fv, amount, delivery_cost')
      .is('deleted_at', null).gte('date', start).lte('date', end),
    admin.from('other_income').select('id, name, amount_original, currency, rate, amount_som, income_date')
      .is('deleted_at', null).eq('period_month', periodMonth).order('income_date'),
    getUnlinkedInventorySalesDaily(admin, start, end),
  ])

  // Выручка от продаж + разбивки (без двойного счёта: каждая проданная консультация учтена
  // ОДИН раз — по своему source и по своему is_nv; каналы/типы — разбиения одного и того же набора).
  let revenue = 0, booked = 0, walkin = 0, salesCount = 0
  const chan = new Map<ChannelKey, number>()
  for (const c of cons ?? []) {
    if (!isSold(c.status_after_fv as string | null)) continue
    const amt = Number(c.amount ?? 0) + Number(c.delivery_cost ?? 0)
    revenue += amt
    salesCount += 1
    const src = (CHANNELS.includes(c.source as ChannelKey) ? c.source : 'other') as ChannelKey
    chan.set(src, (chan.get(src) ?? 0) + amt)
    if (c.is_nv === false) walkin += amt; else booked += amt
  }

  // Чеки без привязки к консультации — обычная розница. Связанные чеки сюда
  // не попадают: их сумма уже записана в consultations.
  const inventory = sumInventorySales(inventoryDays)
  revenue += inventory.revenue
  salesCount += inventory.sales
  walkin += inventory.revenue
  chan.set('other', (chan.get('other') ?? 0) + inventory.revenue)

  const byChannel: IncomeChannel[] = CHANNELS.map(ch => {
    const rev = chan.get(ch) ?? 0
    return { channel: ch, revenue: rev, sharePct: revenue > 0 ? (rev / revenue) * 100 : null }
  })
  const otherRows: OtherIncomeRow[] = (other ?? []).map(o => ({
    id: o.id as string, name: o.name as string, amount_original: Number(o.amount_original),
    currency: o.currency as Currency, rate: Number(o.rate), amount_som: Number(o.amount_som), income_date: o.income_date as string,
  }))
  const otherSom = otherRows.reduce((s, o) => s + o.amount_som, 0)

  return {
    periodMonth, revenue, byChannel,
    byType: {
      booked, walkin,
      bookedPct: revenue > 0 ? (booked / revenue) * 100 : null,
      walkinPct: revenue > 0 ? (walkin / revenue) * 100 : null,
    },
    other: otherRows, otherSom, totalIncome: revenue + otherSom, salesCount,
    canManage: await isFinancesManager(actor),
  }
}

function mapErr(msg: string): string {
  if (msg.includes('not_finances_manager')) return 'Недостаточно прав'
  if (msg.includes('invalid_currency')) return 'Некорректная валюта'
  if (msg.includes('invalid_rate')) return 'Курс должен быть больше 0'
  if (msg.includes('invalid_amount')) return 'Сумма должна быть больше 0'
  if (msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('income_not_found')) return 'Доход не найден'
  return 'Не удалось сохранить'
}

export async function saveOtherIncome(id: string | null, input: OtherIncomeInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (!input.name?.trim()) return { success: false, error: 'Укажите название' }
  if (!(input.amount_original > 0)) return { success: false, error: 'Сумма должна быть больше 0' }
  if (input.currency === 'USD' && !(input.rate > 0)) return { success: false, error: 'Для USD укажите курс (> 0)' }
  if (!input.income_date) return { success: false, error: 'Укажите дату' }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_other_income', {
    p_id: id,
    p_data: {
      name: input.name, amount_original: input.amount_original,
      currency: input.currency, rate: input.currency === 'KGS' ? 1 : input.rate,
      income_date: input.income_date, period_month: input.period_month,
    },
    p_actor: actor.employeeId,
  })
  if (error) { console.error('[saveOtherIncome]', error.code, '|', error.message); return { success: false, error: mapErr(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function deleteOtherIncome(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_other_income', { p_id: id, p_actor: actor.employeeId })
  if (error) { console.error('[deleteOtherIncome]', error.code, '|', error.message); return { success: false, error: mapErr(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true }
}
