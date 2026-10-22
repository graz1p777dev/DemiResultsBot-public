const PALETTE = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#c2410c', '#0f766e', '#0891b2', '#4f46e5']

export const BOT_COLOR = '#6d28d9'

export function employeeColor(identity?: string | null) {
  const value = (identity || 'employee').trim().toLocaleLowerCase('ru-RU')
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function colorAlpha(hex: string, alpha: number) {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function initials(name?: string | null) {
  return (name || 'С').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
}
