'use client'

import { AreaChart, BarChart3, LineChart } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ChartKind = 'bar' | 'line' | 'area'

const OPTIONS: { kind: ChartKind; icon: typeof BarChart3; label: string }[] = [
  { kind: 'bar', icon: BarChart3, label: 'Столбцы' },
  { kind: 'line', icon: LineChart, label: 'Линия' },
  { kind: 'area', icon: AreaChart, label: 'Область' },
]

interface ChartTypeToggleProps {
  value: ChartKind
  onChange: (kind: ChartKind) => void
  className?: string
}

export function ChartTypeToggle({ value, onChange, className }: ChartTypeToggleProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 shadow-sm',
        className
      )}
      role="group"
      aria-label="Тип графика"
    >
      {OPTIONS.map(({ kind, icon: Icon, label }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onChange(kind)}
          title={label}
          aria-pressed={value === kind}
          className={cn(
            'flex size-9 items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0c4d6c]',
            value === kind
              ? 'bg-[#0c4d6c] text-white shadow-sm'
              : 'bg-white text-[#0c4d6c] hover:bg-[#e7f3f7]'
          )}
        >
          <Icon className="size-4" strokeWidth={2.25} />
        </button>
      ))}
    </div>
  )
}
