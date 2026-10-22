'use client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, CartesianGrid,
} from 'recharts'
import type { WeekRevenuePoint } from '@/lib/dashboard-queries'
import { formatMoney, formatMoneyShort } from '@/lib/formatters'

interface RevenueWeeksChartProps {
  data: WeekRevenuePoint[]
}

function CustomTooltip({
  active, payload, label,
}: {
  active?: boolean
  payload?: Array<{ value: number }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded-xl px-3 py-2 shadow-lg"
      style={{
        backgroundColor: '#0c2136',
        border: '1px solid rgba(255,255,255,0.08)',
        fontSize: 12,
      }}
    >
      <p style={{ color: '#a2b4c0', marginBottom: 2 }}>Неделя {label}</p>
      <p className="font-semibold tabular-nums" style={{ color: '#ffffff' }}>
        {formatMoney(payload[0].value)}
      </p>
    </div>
  )
}

export default function RevenueWeeksChart({ data }: RevenueWeeksChartProps) {
  const hasData = data.some(d => d.revenue > 0)

  if (!hasData) {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-xl bg-[#f9fafb] text-[#a2b4c0] dark:bg-[#0b2438] dark:text-[#9fb6c7]"
        style={{
          height: 160,
          border: '1px dashed #e5e7eb',
        }}
      >
        <p style={{ fontSize: 13 }}>Нет продаж в этом месяце</p>
      </div>
    )
  }

  return (
    <div style={{ height: 160 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, left: -16, bottom: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid
            vertical={false}
            stroke="#f0f2f4"
            strokeDasharray="0"
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#a2b4c0' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatMoneyShort}
            tick={{ fontSize: 11, fill: '#a2b4c0' }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ fill: 'rgba(12,77,108,0.06)' }}
          />
          <Bar dataKey="revenue" radius={[4, 4, 0, 0]} maxBarSize={40}>
            {data.map((_, i) => (
              <Cell key={i} fill="#0c4d6c" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
