import type { DashboardTodayStats } from '@/types'
import { formatNumber, formatMoney } from '@/lib/formatters'
import { CalendarCheck, ShoppingCart } from 'lucide-react'

interface TodayCardsProps {
  stats: DashboardTodayStats
}

interface SmallCardProps {
  label: string
  value: string
  icon: React.ReactNode
  accent: string
}

function SmallCard({ label, value, icon, accent }: SmallCardProps) {
  return (
    <div
      className="rounded-xl p-4 flex items-center gap-3"
      style={{
        backgroundColor: '#ffffff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        border: '1px solid rgba(0,0,0,0.04)',
      }}
    >
      <div
        className="flex items-center justify-center rounded-lg flex-shrink-0"
        style={{ width: 36, height: 36, backgroundColor: accent + '14' }}
      >
        <span style={{ color: accent }}>{icon}</span>
      </div>
      <div className="min-w-0">
        <p
          className="font-bold tabular-nums truncate"
          style={{ fontSize: 20, color: '#0c2136', lineHeight: 1.1 }}
        >
          {value}
        </p>
        <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{label}</p>
      </div>
    </div>
  )
}

export default function TodayCards({ stats }: TodayCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <SmallCard
        label="ФВ сегодня"
        value={formatNumber(stats.fv_today)}
        icon={<CalendarCheck style={{ width: 16, height: 16 }} />}
        accent="#0c4d6c"
      />
      <SmallCard
        label="Продаж сегодня"
        value={formatNumber(stats.sales_today)}
        icon={<ShoppingCart style={{ width: 16, height: 16 }} />}
        accent="#16a34a"
      />
      {stats.revenue_today > 0 && (
        <div
          className="col-span-2 rounded-xl px-4 py-3 flex items-center justify-between"
          style={{
            backgroundColor: '#0c4d6c',
            boxShadow: '0 2px 8px rgba(12,77,108,0.25)',
          }}
        >
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Выручка сегодня</span>
          <span
            className="font-bold tabular-nums"
            style={{ fontSize: 16, color: '#ffffff' }}
          >
            {formatMoney(stats.revenue_today)}
          </span>
        </div>
      )}
    </div>
  )
}
