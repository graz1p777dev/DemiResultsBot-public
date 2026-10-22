// Кассовый разрыв — чистый расчёт. Вынесено из 'use server'-модуля: там разрешены
// только async-экспорты, а этот расчёт синхронный и должен быть проверяемым отдельно
// от БД (см. finance-pnl.ts / finance-investor-term.ts — тот же приём).
//
// Б5. Разрыв — свойство ДНЯ, а не порядка строк во входном массиве. Долги, возвраты
// тела, начисления и плановые движения приходят из разных источников и складываются
// в произвольном порядке; если гонять running-balance по строкам как есть, три выплаты
// одной датой дадут разный firstShortfall при разной сортировке. Поэтому: сначала
// схлопываем всё в одну точку на дату, потом идём по датам по возрастанию.

export type GapSource = 'debt' | 'investor_principal' | 'investor_accrual' | 'planned_movement' | 'mixed'

// amountSom > 0 — отток (выплата), < 0 — приток (плановое поступление).
// Приток и отток одной даты неттуются: в пределах дня деньги успевают сработать.
export interface UpcomingItem {
  date: string
  label: string
  amountSom: number
  source: GapSource
}

export interface GapDay {
  date: string
  label: string
  amountSom: number
  source: GapSource
  balanceAfter: number
  shortfall: number   // > 0 — не хватает на этот день
}

export interface CashGapResult {
  hasGap: boolean
  firstGapDate: string | null
  firstShortfall: number
  timeline: GapDay[]
}

const SOURCE_ORDER: GapSource[] = ['debt', 'investor_principal', 'investor_accrual', 'planned_movement', 'mixed']

export function computeCashGap(openingBalanceSom: number, upcoming: UpcomingItem[]): CashGapResult {
  // ── Схлопывание по дате ──
  const byDate = new Map<string, { amountSom: number; labels: string[]; sources: Set<GapSource> }>()
  for (const u of upcoming) {
    const cur = byDate.get(u.date) ?? { amountSom: 0, labels: [], sources: new Set<GapSource>() }
    cur.amountSom += u.amountSom
    cur.labels.push(u.label)
    cur.sources.add(u.source)
    byDate.set(u.date, cur)
  }

  const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  let running = openingBalanceSom
  let firstGapDate: string | null = null
  let firstShortfall = 0

  const timeline: GapDay[] = days.map(([date, d]) => {
    const shortfall = running < d.amountSom ? d.amountSom - running : 0
    if (shortfall > 0 && firstGapDate === null) {
      firstGapDate = date
      firstShortfall = shortfall
    }
    running -= d.amountSom

    // Ярлыки и источник тоже приводим к каноническому виду: иначе текст строки
    // (и source при смешении) зависел бы от порядка входа — тот же баг, но в UI.
    const labels = [...d.labels].sort((a, b) => a.localeCompare(b, 'ru'))
    const sources = SOURCE_ORDER.filter(s => d.sources.has(s))
    const source: GapSource = sources.length === 1 ? sources[0] : 'mixed'

    return {
      date,
      label: labels.length === 1 ? labels[0] : `${labels.length} операции: ${labels.join('; ')}`,
      amountSom: d.amountSom,
      source,
      balanceAfter: running,
      shortfall,
    }
  })

  return { hasGap: firstGapDate !== null, firstGapDate, firstShortfall, timeline }
}
