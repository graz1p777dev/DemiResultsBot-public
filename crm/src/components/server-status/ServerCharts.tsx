'use client'

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import type { HistoryPoint, NetworkHistoryPoint } from '@/types/server-status'
import { formatBytesPerSec } from './format'
import { CHART_COLORS, CHART_TOOLTIP_STYLE, CHART_GRID_STROKE, CHART_TICK } from '@/components/charts/chart-theme'

const TIP = CHART_TOOLTIP_STYLE
const TICK = CHART_TICK
const MARGIN = { top: 4, right: 4, left: -16, bottom: 0 }
const H = 180

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl glass p-5">
      <h3 className="font-semibold text-sm mb-3 text-foreground">
        {title}
      </h3>
      {children}
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center text-muted-foreground" style={{ height: H, fontSize: 12 }}>
      Пока недостаточно данных — соберём за несколько измерений
    </div>
  )
}

export function CpuHistoryChart({ data }: { data: HistoryPoint[] }) {
  return (
    <ChartCard title="CPU за последние измерения">
      {data.length < 2 ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={H}>
          <AreaChart data={data} margin={MARGIN}>
            <defs>
              <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.cyan} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.cyan} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} vertical={false} />
            <XAxis dataKey="time" tick={TICK} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} domain={[0, 100]} width={30} />
            <Tooltip contentStyle={TIP} formatter={(v) => [`${v}%`, 'CPU']} />
            <Area type="monotone" dataKey="value" stroke={CHART_COLORS.cyan} strokeWidth={2} fill="url(#cpuFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

export function RamHistoryChart({ data }: { data: HistoryPoint[] }) {
  return (
    <ChartCard title="RAM за последние измерения">
      {data.length < 2 ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={H}>
          <AreaChart data={data} margin={MARGIN}>
            <defs>
              <linearGradient id="ramFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.violet} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.violet} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} vertical={false} />
            <XAxis dataKey="time" tick={TICK} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} domain={[0, 100]} width={30} />
            <Tooltip contentStyle={TIP} formatter={(v) => [`${v}%`, 'RAM']} />
            <Area type="monotone" dataKey="value" stroke={CHART_COLORS.violet} strokeWidth={2} fill="url(#ramFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

export function NetworkHistoryChart({ data }: { data: NetworkHistoryPoint[] }) {
  return (
    <ChartCard title="Сеть: входящий / исходящий трафик">
      {data.length < 2 ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={H}>
          <ComposedChart data={data} margin={MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} vertical={false} />
            <XAxis dataKey="time" tick={TICK} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => formatBytesPerSec(v)} />
            <Tooltip
              contentStyle={TIP}
              formatter={(v, key) => [formatBytesPerSec(Number(v)), key === 'in' ? 'Входящий' : 'Исходящий']}
            />
            <Line type="monotone" dataKey="in" stroke={CHART_COLORS.emerald} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="out" stroke={CHART_COLORS.amber} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

export function ChartCardSkeleton() {
  return (
    <div className="rounded-2xl glass p-5 animate-pulse">
      <div className="h-4 w-48 rounded mb-4 bg-foreground/10" />
      <div className="rounded-xl bg-foreground/5" style={{ height: H }} />
    </div>
  )
}
