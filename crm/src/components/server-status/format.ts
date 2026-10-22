export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatBytesPerSec(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  return `${formatBytes(bytes)}/с`
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 0) {
    // Событие в будущем (например, «следующий бэкап»).
    const ahead = -diffSec
    if (ahead < 3600) return `через ${Math.round(ahead / 60)} мин`
    if (ahead < 86400) return `через ${Math.round(ahead / 3600)} ч`
    return `через ${Math.round(ahead / 86400)} д`
  }
  if (diffSec < 60) return 'только что'
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} мин назад`
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} ч назад`
  return `${Math.round(diffSec / 86400)} д назад`
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d} д`)
  if (h > 0 || d > 0) parts.push(`${h} ч`)
  parts.push(`${m} мин`)
  return parts.join(' ')
}
