// ─── Темп, прогноз и «сколько нужно сегодня» ──────────────────────────────────
//
// Общий модуль для всех трёх экранов декомпозиции (компания, ЛМ, МП), чтобы
// одна и та же метрика везде считалась одинаково и объяснялась одними словами.
//
// Идея простая: смотрим, сколько сделано за прошедшую часть периода, и в том же
// темпе продлеваем до конца. Это НЕ обещание — это ответ на вопрос
// «если дальше будет как сейчас, чем закончим».

export type PaceStatus = 'ahead' | 'on_track' | 'behind' | 'critical' | 'no_data'

export interface PaceResult {
  /** Прогноз итога к концу периода при текущем темпе */
  projected: number
  /** Прогнозный % выполнения плана (0..∞) */
  projectedPct: number
  /** Текущий % выполнения (факт / план) */
  currentPct: number
  /** Светофор */
  status: PaceStatus
  /** Человеческая формулировка для интерфейса */
  label: string
  /** Цвет светофора (фирменная палитра) */
  color: string
  bg: string
}

/** Цвета светофора. Красный/жёлтый/зелёный держим спокойными — это рабочий
 *  инструмент, а не сигнализация. */
const COLORS = {
  ahead:    { color: '#1b7a4b', bg: '#e6f4ec' },
  on_track: { color: '#1b7a4b', bg: '#e6f4ec' },
  behind:   { color: '#b5732f', bg: '#fdf3e6' },
  critical: { color: '#c0392b', bg: '#fbeceb' },
  no_data:  { color: '#8a9aa6', bg: '#f1f4f6' },
} as const

/**
 * Прогноз выполнения по текущему темпу.
 *
 * @param plan       план на весь период
 * @param fact       факт с начала периода на сегодня
 * @param daysPassed сколько дней периода уже прошло (включая сегодня)
 * @param daysTotal  сколько дней в периоде всего
 *
 * Считаем по КАЛЕНДАРНЫМ дням, а не по рабочим: план компании задаётся на
 * календарный период, и владельцу понятнее «прошло 12 дней из 31».
 */
export function computePace(
  plan: number,
  fact: number,
  daysPassed: number,
  daysTotal: number,
): PaceResult {
  const currentPct = plan > 0 ? (fact / plan) * 100 : 0

  // Нет плана, период ещё не начался или совсем нет истории — прогнозировать не из чего.
  if (plan <= 0 || daysPassed <= 0 || daysTotal <= 0) {
    return {
      projected: 0, projectedPct: 0, currentPct,
      status: 'no_data',
      label: 'Недостаточно данных для прогноза',
      ...COLORS.no_data,
    }
  }

  const perDay      = fact / daysPassed
  const projected   = perDay * daysTotal
  const projectedPct = plan > 0 ? (projected / plan) * 100 : 0

  // Пороги: 100+ — идём с опережением/в графике; 90..100 — небольшое отставание;
  // ниже 90 — сильное. Пороги совпадают с уже принятыми в «План vs Факт».
  let status: PaceStatus
  if (projectedPct >= 105)     status = 'ahead'
  else if (projectedPct >= 95) status = 'on_track'
  else if (projectedPct >= 80) status = 'behind'
  else                         status = 'critical'

  const rounded = Math.round(projectedPct)
  const label =
    status === 'ahead'    ? `Опережаете план — при текущем темпе выполните ~${rounded}%`
  : status === 'on_track' ? `Идёте по плану — при текущем темпе выполните ~${rounded}%`
  : status === 'behind'   ? `Небольшое отставание — при текущем темпе выполните ~${rounded}%`
  :                         `Сильное отставание — при текущем темпе выполните ~${rounded}%`

  return { projected, projectedPct, currentPct, status, label, ...COLORS[status] }
}

/**
 * Сколько нужно делать в день, чтобы догнать план.
 *
 * @param plan              план на период
 * @param fact              сделано на сегодня
 * @param remainingWorkDays оставшиеся РАБОЧИЕ дни (для сотрудника — с учётом графика и отсутствий)
 *
 * Здесь именно рабочие дни: сотруднику нужно понимать нагрузку на смену,
 * а не «в среднем по календарю».
 */
export interface CatchUp {
  remaining: number      // сколько ещё нужно сделать
  perDay: number         // норма на один рабочий день
  done: boolean          // план уже выполнен
  noDaysLeft: boolean    // дни кончились, а план нет
}

export function computeCatchUp(plan: number, fact: number, remainingWorkDays: number): CatchUp {
  const remaining = Math.max(plan - fact, 0)
  if (remaining <= 0) return { remaining: 0, perDay: 0, done: true, noDaysLeft: false }
  if (remainingWorkDays <= 0) return { remaining, perDay: 0, done: false, noDaysLeft: true }
  return { remaining, perDay: remaining / remainingWorkDays, done: false, noDaysLeft: false }
}

/** Сколько календарных дней периода прошло (включая сегодня) и сколько всего. */
export function periodProgress(dateStart: string, dateEnd: string, today?: string): {
  daysPassed: number
  daysTotal: number
} {
  const t = today ?? new Date().toISOString().slice(0, 10)
  const toN = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  const DAY = 86_400_000
  const start = toN(dateStart), end = toN(dateEnd), now = toN(t)

  const daysTotal = Math.round((end - start) / DAY) + 1
  if (now < start) return { daysPassed: 0, daysTotal }
  const passed = Math.round((Math.min(now, end) - start) / DAY) + 1
  return { daysPassed: passed, daysTotal }
}
