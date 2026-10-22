'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, isFinancesManager } from '@/lib/authz'
import type { Currency } from './finance-expenses'
import { daysUntil } from '@/lib/business-date'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }
export type DebtType = 'supplier' | 'business'
// DEBT_TYPE_LABEL вынесен в '@/lib/finance-labels' — 'use server' файл не может
// экспортировать объект (только async-функции).

export interface Debt {
  id: string; debt_type: DebtType; creditor_name: string
  amount_original: number; currency: Currency; rate: number; amount_som: number
  purchase_date: string; due_date: string; status: 'active' | 'paid'; paid_date: string | null; note: string | null
  daysLeft: number | null   // до due_date (активные); отрицательное = просрочено
}
export interface DebtsTabData {
  active:          Debt[]                 // все активные
  paid:            Debt[]                 // история погашенных
  totalActiveSom:  number
  supplierSom:     number
  businessSom:     number
  canManage:       boolean
}
export interface DebtInput {
  debt_type: DebtType; creditor_name: string; amount_original: number; currency: Currency
  rate: number; purchase_date: string; due_date: string; note?: string | null
}

// «Сегодня» — в поясе компании (Asia/Bishkek), см. lib/business-date.ts.
const daysBetweenToday = (due: string): number => daysUntil(due)

export async function getDebtsTabData(): Promise<DebtsTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'finances', 'view')) return null   // fail-closed

  const admin = createAdminClient()
  const { data } = await admin
    .from('debts')
    .select('id, debt_type, creditor_name, amount_original, currency, rate, amount_som, purchase_date, due_date, status, paid_date, note')
    .is('deleted_at', null)
    .order('due_date', { ascending: true })

  const rows: Debt[] = (data ?? []).map(d => ({
    id: d.id as string, debt_type: d.debt_type as DebtType, creditor_name: d.creditor_name as string,
    amount_original: Number(d.amount_original), currency: d.currency as Currency, rate: Number(d.rate),
    amount_som: Number(d.amount_som), purchase_date: d.purchase_date as string, due_date: d.due_date as string,
    status: d.status as 'active' | 'paid', paid_date: (d.paid_date as string | null) ?? null, note: (d.note as string | null) ?? null,
    daysLeft: d.status === 'active' ? daysBetweenToday(d.due_date as string) : null,
  }))

  const active = rows.filter(d => d.status === 'active')   // уже отсортированы по due_date (ближайшие/просроченные сверху)
  const paid = rows.filter(d => d.status === 'paid').sort((a, b) => (b.paid_date ?? '').localeCompare(a.paid_date ?? ''))

  return {
    active, paid,
    totalActiveSom: active.reduce((s, d) => s + d.amount_som, 0),
    supplierSom: active.filter(d => d.debt_type === 'supplier').reduce((s, d) => s + d.amount_som, 0),
    businessSom: active.filter(d => d.debt_type === 'business').reduce((s, d) => s + d.amount_som, 0),
    canManage: await isFinancesManager(actor),
  }
}

function mapErr(msg: string): string {
  if (msg.includes('not_finances_manager') || msg.includes('actor_inactive')) return 'Недостаточно прав'
  if (msg.includes('creditor_required')) return 'Укажите кредитора'
  if (msg.includes('invalid_currency')) return 'Некорректная валюта'
  if (msg.includes('invalid_rate')) return 'Курс должен быть больше 0'
  if (msg.includes('invalid_amount')) return 'Сумма должна быть больше 0'
  if (msg.includes('invalid_debt_type')) return 'Некорректный тип долга'
  if (msg.includes('debt_not_found')) return 'Долг не найден'
  return 'Не удалось сохранить'
}

export async function saveDebt(id: string | null, input: DebtInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  if (!input.creditor_name?.trim()) return { success: false, error: 'Укажите кредитора' }
  if (!(input.amount_original > 0)) return { success: false, error: 'Сумма должна быть больше 0' }
  if (input.currency === 'USD' && !(input.rate > 0)) return { success: false, error: 'Для USD укажите курс (> 0)' }
  if (!input.purchase_date || !input.due_date) return { success: false, error: 'Укажите даты займа и возврата' }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_debt', {
    p_id: id,
    p_data: {
      debt_type: input.debt_type, creditor_name: input.creditor_name,
      amount_original: input.amount_original, currency: input.currency,
      rate: input.currency === 'KGS' ? 1 : input.rate,
      purchase_date: input.purchase_date, due_date: input.due_date, note: input.note ?? null,
    },
    p_actor: actor.employeeId,
  })
  if (error) { console.error('[saveDebt]', error.code, '|', error.message); return { success: false, error: mapErr(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true, id: data as string }
}

export async function markDebtPaid(id: string, paidDate?: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('mark_debt_paid', { p_id: id, p_paid_date: paidDate ?? null, p_actor: actor.employeeId })
  if (error) { console.error('[markDebtPaid]', error.code, '|', error.message); return { success: false, error: mapErr(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true }
}

export async function deleteDebt(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isFinancesManager(actor)) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_debt', { p_id: id, p_actor: actor.employeeId })
  if (error) { console.error('[deleteDebt]', error.code, '|', error.message); return { success: false, error: mapErr(error.message || '') } }
  revalidatePath('/dashboard/finance')
  return { success: true }
}
