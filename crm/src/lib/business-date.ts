// ─── «Сегодня» в часовом поясе компании ───────────────────────────────────────
// Компания работает в Asia/Bishkek. Сервер (Vercel/контейнер) почти всегда живёт в UTC,
// поэтому `new Date().getFullYear()/getMonth()/getDate()` и `toISOString().slice(0,10)`
// давали UTC-дату: с 00:00 до 05:59 по Бишкеку это ВЧЕРАШНЕЕ число. Последствия —
// сегодняшние движения по счетам уезжали в «будущие» и не входили в текущий остаток,
// а «дней до возврата» считалось на день больше.
//
// Оффсет НЕ хардкодим: Intl с timeZone учитывает правила зоны (в т.ч. если они изменятся),
// в отличие от ручного `+6`. Формат 'en-CA' даёт ровно ISO-вид YYYY-MM-DD.

export const BUSINESS_TIMEZONE = 'Asia/Bishkek'

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Текущая дата в часовом поясе компании, 'YYYY-MM-DD'. */
export function businessToday(now: Date = new Date()): string {
  return dateFormatter.format(now)
}

/** Начало суток (UTC-полночь) для даты 'YYYY-MM-DD' — база для счёта дней. */
export function dayStartUtc(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * Целых дней от «сегодня» (в поясе компании) до даты due.
 * Отрицательное значение — просрочено. Обе даты приводятся к UTC-полуночи, поэтому
 * результат не зависит от времени суток и от пояса сервера.
 */
export function daysUntil(due: string, now: Date = new Date()): number {
  return Math.round((dayStartUtc(due) - dayStartUtc(businessToday(now))) / 86_400_000)
}
