'use client'

import type { MarketingKpi } from '@/lib/models/marketing'

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M'
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + ' K'
  return n.toLocaleString('ru')
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}

interface KpiCardDef {
  label: string
  value: string
  sub:   string
  color: string
  icon:  string
  badge?: { text: string; good: boolean }
}

function buildCards(kpi: MarketingKpi): KpiCardDef[] {
  return [
    {
      label: 'Расходы на рекламу',
      value: fmtMoney(kpi.totalSpend) + ' KGS',
      sub:   `${fmtNum(kpi.totalClicks)} кликов · CTR ${kpi.avgCtr}%`,
      color: '#0c2136',
      icon:  '📢',
    },
    {
      label: 'CPL (стоимость лида)',
      value: fmtMoney(kpi.avgCpl) + ' KGS',
      sub:   `${fmtNum(kpi.totalLeads)} лидов получено`,
      color: '#0c4d6c',
      icon:  '🎯',
    },
    {
      label: 'ROMI',
      value: kpi.romi.toLocaleString('ru') + '%',
      sub:   'возврат на инвестиции',
      color: kpi.romi >= 500 ? '#10b981' : kpi.romi >= 200 ? '#f59e0b' : '#ef4444',
      icon:  '📈',
      badge: { text: kpi.romi >= 500 ? 'Отлично' : kpi.romi >= 200 ? 'Норма' : 'Ниже нормы', good: kpi.romi >= 200 },
    },
    {
      label: 'ДРР',
      value: kpi.drr.toFixed(1) + '%',
      sub:   'доля рекламных расходов',
      color: kpi.drr <= 10 ? '#10b981' : kpi.drr <= 20 ? '#f59e0b' : '#ef4444',
      icon:  '📊',
      badge: { text: kpi.drr <= 10 ? 'Норма' : 'Высокий', good: kpi.drr <= 10 },
    },
    {
      label: 'Обращения',
      value: fmtNum(kpi.totalAppeals),
      sub:   `в т.ч. ЛМ: ${fmtNum(kpi.totalAppealsLM)}`,
      color: '#0c2136',
      icon:  '💬',
    },
    {
      label: 'Конв. обр.→лид',
      value: kpi.convAppealLead.toFixed(1) + '%',
      sub:   `→ консульт ${kpi.convLeadConsult.toFixed(1)}%`,
      color: '#0c4d6c',
      icon:  '🔄',
    },
    {
      label: 'Продажи',
      value: fmtNum(kpi.totalSales),
      sub:   `конв. консульт→прод ${kpi.convConsultSale.toFixed(1)}%`,
      color: '#10b981',
      icon:  '✅',
    },
    {
      label: 'Выручка',
      value: fmtMoney(kpi.totalRevenue) + ' KGS',
      sub:   `ср. чек ${fmtMoney(kpi.avgCheck)} KGS`,
      color: '#0c2136',
      icon:  '💰',
    },
  ]
}

interface Props {
  kpi: MarketingKpi
}

export default function MarketingKpiCards({ kpi }: Props) {
  const cards = buildCards(kpi)

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(card => (
        <div
          key={card.label}
          className="rounded-2xl px-4 py-4 shadow-sm border"
          style={{ backgroundColor: '#fff', borderColor: '#ebebee' }}
        >
          <div className="flex items-start justify-between mb-2">
            <p className="text-[11px] font-medium leading-tight" style={{ color: '#a2b4c0' }}>
              {card.label}
            </p>
            <span className="text-base leading-none">{card.icon}</span>
          </div>
          <p className="text-xl font-bold leading-none mb-1" style={{ color: card.color }}>
            {card.value}
          </p>
          <div className="flex items-center gap-2">
            <p className="text-[11px]" style={{ color: '#a2b4c0' }}>{card.sub}</p>
            {card.badge && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: card.badge.good ? '#f0fdf4' : '#fef2f2',
                  color: card.badge.good ? '#10b981' : '#ef4444',
                }}
              >
                {card.badge.text}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
