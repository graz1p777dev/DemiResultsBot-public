import type { CSSProperties } from 'react'

// Единая яркая палитра для всех графиков (recharts не умеет резолвить CSS-переменные
// в градиентных stop-color на всех рендерерах, поэтому держим литералы, синхронизированные
// с --chart-1..5 в globals.css).
export const CHART_COLORS = {
  violet: '#7c3aed',
  cyan: '#06b6d4',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
} as const

export const CHART_PALETTE = [
  CHART_COLORS.violet,
  CHART_COLORS.cyan,
  CHART_COLORS.emerald,
  CHART_COLORS.amber,
  CHART_COLORS.rose,
]

export const CHART_TICK = { fontSize: 11, fill: '#8b8fa3' }
export const CHART_MARGIN = { top: 4, right: 4, left: -16, bottom: 0 }

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  background: 'rgba(20,16,41,0.85)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12,
  fontSize: 12,
  color: '#f1f5f9',
  boxShadow: '0 12px 32px -12px rgba(76,29,149,0.4)',
}

export const CHART_GRID_STROKE = 'rgba(124,58,237,0.1)'
