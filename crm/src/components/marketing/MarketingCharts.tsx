'use client'

import {
  ResponsiveContainer, ComposedChart, Bar, AreaChart, Area,
  Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ReferenceLine,
} from 'recharts'
import type { MarketingDailyRow } from '@/lib/models/marketing'
import { MONTHLY_PLAN } from './marketing-plans'

function fmtK(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}

const CARD = { backgroundColor: '#fff', borderColor: '#ebebee' }
const TIP  = { fontSize: 11, borderRadius: 8, border: '1px solid #ebebee' }
const TICK = { fontSize: 10, fill: '#a2b4c0' }
const MARGIN = { top: 4, right: 4, left: -16, bottom: 0 }
const H = 180

interface Props {
  daily: MarketingDailyRow[]
}

export default function MarketingCharts({ daily }: Props) {
  const active = daily.filter(r => !r.isFuture)

  // ── Данные для каждого графика ────────────────────────────────────────────
  const spendRevenueData = active.map(r => ({
    day: String(r.day),
    Расход:  r.spend,
    Выручка: r.revenue,
  }))

  const appealsData = active.map(r => ({
    day: String(r.day),
    Обращения: r.appeals,
    Продажи:   r.sales,
  }))

  const cplData = active.map(r => ({
    day:  String(r.day),
    CPL:  r.cpl,
    план: active.length > 0 ? Math.round(MONTHLY_PLAN.cpl) : 0,
  }))

  const romiData = active.map(r => ({
    day:  String(r.day),
    ROMI: r.romi,
    план: MONTHLY_PLAN.romi,
  }))

  // Накопительный план выручки
  const workDays  = active.filter(r => !r.isWeekend).length || 1
  const dailyPlan = MONTHLY_PLAN.revenue / workDays
  const cumulativeData = active.reduce<{ day: string; Факт: number; План: number }[]>((acc, r) => {
    const prev    = acc[acc.length - 1]
    const cumFact = (prev?.Факт ?? 0) + r.revenue
    const cumPlan = (prev?.План ?? 0) + (r.isWeekend ? 0 : dailyPlan)
    return [...acc, { day: String(r.day), Факт: Math.round(cumFact), План: Math.round(cumPlan) }]
  }, [])

  return (
    <div className="space-y-3">

      {/* Строка 1: Расход vs Выручка | Обращения vs Продажи */}
      <div className="grid grid-cols-2 gap-3">

        {/* 1. Расход vs Выручка */}
        <div className="rounded-2xl p-4 shadow-sm border" style={CARD}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#0c2136' }}>Расход vs Выручка</p>
          <ResponsiveContainer width="100%" height={H}>
            <ComposedChart data={spendRevenueData} margin={MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={TICK} interval={4} />
              <YAxis yAxisId="l" tick={TICK} tickFormatter={fmtK} />
              <YAxis yAxisId="r" orientation="right" tick={TICK} tickFormatter={fmtK} />
              <Tooltip
                contentStyle={TIP}
                formatter={(v, n) => [fmtK(Number(v)) + ' KGS', String(n)]}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar  yAxisId="l" dataKey="Расход"  fill="#0c4d6c" radius={[3,3,0,0]} />
              <Line yAxisId="r" dataKey="Выручка" stroke="#10b981" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 2. Обращения vs Продажи */}
        <div className="rounded-2xl p-4 shadow-sm border" style={CARD}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#0c2136' }}>Обращения vs Продажи</p>
          <ResponsiveContainer width="100%" height={H}>
            <ComposedChart data={appealsData} margin={MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={TICK} interval={4} />
              <YAxis yAxisId="l" tick={TICK} />
              <YAxis yAxisId="r" orientation="right" tick={TICK} />
              <Tooltip contentStyle={TIP} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar  yAxisId="l" dataKey="Обращения" fill="#0c2136" radius={[3,3,0,0]} />
              <Line yAxisId="r" dataKey="Продажи"   stroke="#f59e0b" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Строка 2: CPL | ROMI | Накопительный план */}
      <div className="grid grid-cols-3 gap-3">

        {/* 3. CPL по дням */}
        <div className="rounded-2xl p-4 shadow-sm border" style={CARD}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#0c2136' }}>CPL по дням</p>
          <ResponsiveContainer width="100%" height={H}>
            <ComposedChart data={cplData} margin={MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={TICK} interval={4} />
              <YAxis tick={TICK} tickFormatter={fmtK} />
              <Tooltip
                contentStyle={TIP}
                formatter={(v, n) => [fmtK(Number(v)) + ' KGS', String(n)]}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={MONTHLY_PLAN.cpl} stroke="#ef4444" strokeDasharray="4 4" />
              <Bar  dataKey="CPL"  fill="#0c4d6c" radius={[3,3,0,0]} />
              <Line dataKey="план" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 4. ROMI */}
        <div className="rounded-2xl p-4 shadow-sm border" style={CARD}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#0c2136' }}>ROMI %</p>
          <ResponsiveContainer width="100%" height={H}>
            <ComposedChart data={romiData} margin={MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={TICK} interval={4} />
              <YAxis tick={TICK} tickFormatter={v => v + '%'} />
              <Tooltip
                contentStyle={TIP}
                formatter={(v, n) => [Number(v).toLocaleString('ru') + '%', String(n)]}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={MONTHLY_PLAN.romi} stroke="#10b981" strokeDasharray="4 4" />
              <Bar  dataKey="ROMI" fill="#0c2136" radius={[3,3,0,0]} />
              <Line dataKey="план" stroke="#10b981" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 5. Накопительный план */}
        <div className="rounded-2xl p-4 shadow-sm border" style={CARD}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#0c2136' }}>Выполнение плана накопительно</p>
          <ResponsiveContainer width="100%" height={H}>
            <AreaChart data={cumulativeData} margin={MARGIN}>
              <defs>
                <linearGradient id="gradFact" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#0c4d6c" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#0c4d6c" stopOpacity={0}    />
                </linearGradient>
                <linearGradient id="gradPlan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#a2b4c0" stopOpacity={0.20} />
                  <stop offset="95%" stopColor="#a2b4c0" stopOpacity={0}    />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={TICK} interval={4} />
              <YAxis tick={TICK} tickFormatter={fmtK} />
              <Tooltip
                contentStyle={TIP}
                formatter={(v, n) => [fmtK(Number(v)) + ' KGS', String(n)]}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Area dataKey="План" stroke="#a2b4c0" fill="url(#gradPlan)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
              <Area dataKey="Факт" stroke="#0c4d6c" fill="url(#gradFact)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

      </div>
    </div>
  )
}
