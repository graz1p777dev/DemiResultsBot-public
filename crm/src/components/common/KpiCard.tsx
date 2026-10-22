import { getKpiColor } from '@/lib/constants'

interface KpiCardProps {
  label: string
  value: string
  plan: string
  pct: number
  delta?: string
  deltaPositive?: boolean
  icon?: React.ReactNode
}

export default function KpiCard({
  label,
  value,
  plan,
  pct,
  delta,
  deltaPositive,
  icon,
}: KpiCardProps) {
  const barColor = getKpiColor(pct)
  const clampedPct = Math.min(pct, 100)

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3 bg-[#e6f3f9] text-[#0c2136] shadow-sm dark:bg-[#102d43] dark:text-[#e6f4fb] dark:shadow-[0_18px_44px_-34px_rgba(0,0,0,0.85)]"
      style={{
        border: '1px solid #f0f2f4',
      }}
    >
      {/* Заголовок */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[#667085] dark:text-[#9fb6c7]" style={{ fontSize: 12, fontWeight: 500 }}>
          {label}
        </span>
        {icon && (
          <span className="text-[#a2b4c0] dark:text-[#7fb7d0]">{icon}</span>
        )}
      </div>

      {/* Значение */}
      <div className="flex items-end justify-between gap-2">
        <span
          className="font-bold tabular-nums text-[#0c2136] dark:text-[#e6f4fb]"
          style={{ fontSize: 22, lineHeight: 1 }}
        >
          {value}
        </span>
        {delta !== undefined && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: deltaPositive ? '#16a34a' : '#dc2626',
            }}
          >
            {deltaPositive ? '↑' : '↓'} {delta}
          </span>
        )}
      </div>

      {/* Прогресс-бар */}
      <div>
        <div
          className="overflow-hidden"
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: 'color-mix(in srgb, currentColor 12%, transparent)',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${clampedPct}%`,
              backgroundColor: barColor,
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[#7f96a8] dark:text-[#9fb6c7]" style={{ fontSize: 11 }}>
            План: {plan}
          </span>
          <span
            className="font-semibold tabular-nums"
            style={{ fontSize: 11, color: barColor }}
          >
            {pct.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  )
}
