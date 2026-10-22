import type { LucideIcon } from 'lucide-react'

interface MetricCardProps {
  icon: LucideIcon
  iconBg: string
  label: string
  value: string
  sublabel?: string
  progress?: number | null
  progressColor?: string
  extra?: React.ReactNode
}

export function MetricCard({
  icon: Icon,
  iconBg,
  label,
  value,
  sublabel,
  progress,
  progressColor = '#0c4d6c',
  extra,
}: MetricCardProps) {
  return (
    <div
      className="rounded-2xl bg-white p-4 flex flex-col gap-3"
      style={{ boxShadow: '0 1px 2px rgba(12,33,54,0.04), 0 8px 24px -16px rgba(12,33,54,0.12)' }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0"
          style={{ background: iconBg }}
        >
          <Icon size={17} color="#fff" strokeWidth={2.25} />
        </div>
        <span className="text-xs font-medium" style={{ color: '#8a97a5' }}>
          {label}
        </span>
      </div>

      {extra ?? (
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold" style={{ color: '#0c2136' }}>
              {value}
            </span>
            {sublabel && (
              <span className="text-xs" style={{ color: '#b3bcc5' }}>
                {sublabel}
              </span>
            )}
          </div>
          {progress !== null && progress !== undefined && (
            <div className="mt-2.5 h-1.5 w-full rounded-full overflow-hidden" style={{ backgroundColor: '#f1f2f4' }}>
              <div
                className="h-full rounded-full transition-[width] duration-700 ease-out"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%`, backgroundColor: progressColor }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MetricCardSkeleton() {
  return (
    <div className="rounded-2xl bg-white p-4 flex flex-col gap-3 animate-pulse">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl" style={{ backgroundColor: '#f1f2f4' }} />
        <div className="h-3 w-20 rounded" style={{ backgroundColor: '#f1f2f4' }} />
      </div>
      <div className="h-7 w-24 rounded" style={{ backgroundColor: '#f1f2f4' }} />
      <div className="h-1.5 w-full rounded-full" style={{ backgroundColor: '#f1f2f4' }} />
    </div>
  )
}
