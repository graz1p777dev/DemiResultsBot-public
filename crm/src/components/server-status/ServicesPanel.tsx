import { Server as ServerIcon } from 'lucide-react'
import type { ServiceStatusItem } from '@/types/server-status'
import { StatusBadge } from './StatusBadge'

export function ServicesPanel({ services }: { services: ServiceStatusItem[] }) {
  return (
    <div className="rounded-2xl bg-white overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div
          className="flex items-center justify-center w-8 h-8 rounded-xl"
          style={{ background: 'linear-gradient(135deg,#0ea5e9 0%,#1e293b 100%)' }}
        >
          <ServerIcon size={15} color="#fff" />
        </div>
        <h2 className="font-semibold text-sm" style={{ color: '#0c2136' }}>
          Состояние сервисов
        </h2>
      </div>

      <ul className="p-2.5 flex flex-col gap-1">
        {services.map((s) => (
          <li
            key={s.name}
            className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-[#f5f6f8]"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: '#0c2136' }}>
                {s.name}
              </p>
              <p className="text-xs truncate" style={{ color: '#8a97a5' }}>
                {s.description}
              </p>
            </div>
            <StatusBadge status={s.status} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ServicesPanelSkeleton() {
  return (
    <div className="rounded-2xl bg-white overflow-hidden animate-pulse">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div className="h-4 w-40 rounded" style={{ backgroundColor: '#f1f2f4' }} />
      </div>
      <div className="p-2.5 flex flex-col gap-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="h-3 w-32 rounded" style={{ backgroundColor: '#f1f2f4' }} />
            <div className="h-5 w-20 rounded-full" style={{ backgroundColor: '#f1f2f4' }} />
          </div>
        ))}
      </div>
    </div>
  )
}
