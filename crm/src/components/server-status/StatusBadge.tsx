import type { ServiceStatus } from '@/types/server-status'

const STATUS_MAP: Record<ServiceStatus, { label: string; fg: string; bg: string; dot: string }> = {
  online: { label: 'Работает', fg: '#15803d', bg: '#dcfce7', dot: '#22c55e' },
  warning: { label: 'Внимание', fg: '#b45309', bg: '#fef3c7', dot: '#f59e0b' },
  offline: { label: 'Недоступно', fg: '#b91c1c', bg: '#fee2e2', dot: '#ef4444' },
  unknown: { label: 'Нет данных', fg: '#475569', bg: '#f1f5f9', dot: '#94a3b8' },
}

export function StatusBadge({ status }: { status: ServiceStatus }) {
  const s = STATUS_MAP[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          backgroundColor: s.dot,
          boxShadow: status === 'online' ? `0 0 0 3px ${s.bg}, 0 0 6px ${s.dot}` : 'none',
        }}
      />
      {s.label}
    </span>
  )
}

export function statusDotColor(status: ServiceStatus): string {
  return STATUS_MAP[status].dot
}
