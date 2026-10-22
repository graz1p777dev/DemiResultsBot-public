// ─── employees-utils.ts ───────────────────────────────────────────────────────

export const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  'Владелец':  { bg: '#0c2136', text: '#ffffff' },
  'РОП':       { bg: '#0c4d6c', text: '#ffffff' },
  'МП':        { bg: '#a2b4c0', text: '#0c2136' },
  'ЛМАИ':      { bg: '#ebebee', text: '#0c2136' },
  'Бухгалтер': { bg: '#ebebee', text: '#0c2136' },
}

export const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  active:    { bg: '#dcfce7', text: '#166534', label: 'Активен' },
  probation: { bg: '#fef9c3', text: '#854d0e', label: 'Испытательный' },
  archived:  { bg: '#f3f4f6', text: '#6b7280', label: 'Архив' },
}

export function kpiColor(pct: number): string {
  if (pct >= 100) return '#166534'
  if (pct >= 80)  return '#854d0e'
  return '#991b1b'
}

export function kpiBg(pct: number): string {
  if (pct >= 100) return '#dcfce7'
  if (pct >= 80)  return '#fef9c3'
  return '#fee2e2'
}

export function fmtMoney(v: number): string {
  if (v === 0) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'KGS', maximumFractionDigits: 0 }).format(v)
}

export function fmtDate(s: string | null): string {
  if (!s) return '—'
  const [y, m, d] = s.split('-')
  return `${d}.${m}.${y}`
}

export const MONTHS = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
]
