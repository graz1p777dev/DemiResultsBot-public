import type { Deal, DealStageClosingRule, DealStageRequiredField } from '@/types'

export type DealSort = 'updated-desc' | 'created-desc' | 'amount-desc' | 'amount-asc' | 'task-asc'

/**
 * Imported amoCRM leads always belong to the Inbox, even where an old import
 * did not manage to attach a local crm_clients row. A local deal without an
 * amoCRM lead remains editable through DealSheet.
 */
export function dealOpenTarget(deal: Pick<Deal, 'amocrm_lead_id'>): string | null {
  return deal.amocrm_lead_id === null
    ? null
    : `/dashboard/dialogs?lead=${encodeURIComponent(String(deal.amocrm_lead_id))}`
}

export function missingStageData(
  deal: Pick<Deal, 'customer_name' | 'customer_phone' | 'amount' | 'note' | 'responsible_employee_id'>,
  requiredFields: DealStageRequiredField[] = [],
  closingRules: DealStageClosingRule[] = [],
  isClosing = false,
  lossReason?: string | null,
): string[] {
  const required = new Set<DealStageRequiredField>(requiredFields)
  if (isClosing) {
    closingRules.forEach(rule => {
      if (rule !== 'loss_reason') required.add(rule)
    })
  }
  const labels: Record<DealStageRequiredField | 'loss_reason', string> = {
    client: 'клиент', phone: 'телефон', amount: 'сумма', note: 'заметка', responsible: 'ответственный', loss_reason: 'причина отказа',
  }
  const values: Record<DealStageRequiredField, boolean> = {
    client: Boolean(deal.customer_name?.trim()), phone: Boolean(deal.customer_phone?.trim()), amount: Number(deal.amount ?? 0) > 0,
    note: Boolean(deal.note?.trim()), responsible: Boolean(deal.responsible_employee_id),
  }
  const missing: Array<DealStageRequiredField | 'loss_reason'> = [...required].filter(field => !values[field])
  if (isClosing && closingRules.includes('loss_reason') && !lossReason?.trim()) missing.push('loss_reason')
  return missing.map(field => labels[field])
}

const time = (value: string | null | undefined, fallback: number) => value ? new Date(value).getTime() : fallback

export function sortDeals(deals: Deal[], sort: DealSort): Deal[] {
  return [...deals].sort((a, b) => {
    if (sort === 'created-desc') return time(b.created_at, 0) - time(a.created_at, 0)
    if (sort === 'amount-desc') return Number(b.amount ?? 0) - Number(a.amount ?? 0)
    if (sort === 'amount-asc') return Number(a.amount ?? 0) - Number(b.amount ?? 0)
    if (sort === 'task-asc') return time(a.next_task_at, Number.MAX_SAFE_INTEGER) - time(b.next_task_at, Number.MAX_SAFE_INTEGER)
    return time(b.updated_at, 0) - time(a.updated_at, 0)
  })
}
