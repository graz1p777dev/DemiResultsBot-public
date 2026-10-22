// Срок действия инвесторской сделки. Вынесено из 'use server'-модуля: там разрешены
// только async-экспорты, а эти функции чистые и должны быть переиспользуемы/проверяемы.

// ─── Окно действия сделки ─────────────────────────────────────────────────────
// Б4: начисление идёт ТОЛЬКО за месяцы внутри срока сделки. Без этого инвестору
// капало каждый месяц бесконечно — и до начала сделки, и после её окончания.
//
// Границы: начало = месяц start_date (нет start_date → сделка не начата, начислений нет);
// конец = РАНЬШАЯ из двух дат — последний месяц срока (start_date + term_months − 1) и
// месяц principal_due_date. Раньше при заданном term_months дата возврата тела просто
// игнорировалась, и если тело вернули досрочно, начисления продолжали капать до конца
// срока. Обязательство заканчивается на первой из границ, а не на удобной.
// Нет ни term_months, ни principal_due_date → бессрочная сделка, верхней границы нет.
const monthKey = (d: string): string => d.slice(0, 7)

const addMonths = (periodMonth: string, n: number): string => {
  const y = Number(periodMonth.slice(0, 4)), m = Number(periodMonth.slice(5, 7))
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}

export function isMonthInDealWindow(inv: {
  start_date: string | null; term_months: number | null; principal_due_date: string | null
}, periodMonth: string): boolean {
  if (!inv.start_date) return false                       // сделка не начата — 0
  const month = monthKey(periodMonth)
  if (month < monthKey(inv.start_date)) return false      // месяц до начала — 0

  // Верхняя граница — минимум из заданных. Обе могут быть заданы одновременно:
  // тогда окно закрывается по той, что наступает раньше.
  const bounds: string[] = []
  if (inv.term_months && inv.term_months > 0) {
    // Последний оплачиваемый месяц: start + (term − 1). Срок 6 мес. с 2026-07 → по 2026-12.
    bounds.push(addMonths(inv.start_date.slice(0, 7) + '-01', inv.term_months - 1))
  }
  if (inv.principal_due_date) bounds.push(monthKey(inv.principal_due_date))

  if (bounds.length === 0) return true                    // бессрочная активная сделка
  const lastMonth = bounds.reduce((a, b) => (a < b ? a : b))   // min: строки 'YYYY-MM' сравнимы лексикографически
  return month <= lastMonth
}
