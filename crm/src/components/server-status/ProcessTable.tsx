import { ListTree } from 'lucide-react'
import type { ProcessRow } from '@/types/server-status'

const STATUS_LABELS: Record<string, { label: string; fg: string; bg: string }> = {
  running: { label: 'работает', fg: '#15803d', bg: '#dcfce7' },
  sleeping: { label: 'ожидание', fg: '#475569', bg: '#f1f5f9' },
  waiting: { label: 'блокирован', fg: '#b45309', bg: '#fef3c7' },
  zombie: { label: 'zombie', fg: '#b91c1c', bg: '#fee2e2' },
  stopped: { label: 'остановлен', fg: '#475569', bg: '#f1f5f9' },
  unknown: { label: 'н/д', fg: '#94a3b8', bg: '#f1f5f9' },
}

function ProcessStatusPill({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? STATUS_LABELS.unknown
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      {s.label}
    </span>
  )
}

export function ProcessTable({ processes }: { processes: ProcessRow[] }) {
  return (
    <div className="rounded-2xl bg-white overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div
          className="flex items-center justify-center w-8 h-8 rounded-xl"
          style={{ background: 'linear-gradient(135deg,#64748b 0%,#0c2136 100%)' }}
        >
          <ListTree size={15} color="#fff" />
        </div>
        <h2 className="font-semibold text-sm" style={{ color: '#0c2136' }}>
          Топ процессов по CPU
        </h2>
      </div>

      {processes.length === 0 ? (
        <p className="px-5 py-8 text-sm text-center" style={{ color: '#8a97a5' }}>
          Нет данных о процессах
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 480 }}>
            <thead>
              <tr style={{ color: '#8a97a5' }} className="text-xs">
                <th className="text-left font-medium px-5 py-2">PID</th>
                <th className="text-left font-medium px-2 py-2">Процесс</th>
                <th className="text-right font-medium px-2 py-2">CPU</th>
                <th className="text-right font-medium px-2 py-2">RAM</th>
                <th className="text-right font-medium px-5 py-2">Статус</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.pid} className="transition-colors hover:bg-[#f5f6f8]">
                  <td className="px-5 py-2.5 font-mono text-xs" style={{ color: '#8a97a5' }}>
                    {p.pid}
                  </td>
                  <td className="px-2 py-2.5 font-medium truncate max-w-[180px]" style={{ color: '#0c2136' }}>
                    {p.name}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono" style={{ color: '#0c2136' }}>
                    {p.cpu.toFixed(1)}%
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono" style={{ color: '#0c2136' }}>
                    {p.ram.toFixed(1)}%
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <ProcessStatusPill status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function ProcessTableSkeleton() {
  return (
    <div className="rounded-2xl bg-white overflow-hidden animate-pulse">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div className="h-4 w-44 rounded" style={{ backgroundColor: '#f1f2f4' }} />
      </div>
      <div className="p-5 flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-4 w-full rounded" style={{ backgroundColor: '#f1f2f4' }} />
        ))}
      </div>
    </div>
  )
}
