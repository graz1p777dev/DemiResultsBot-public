'use client'

import type { SummaryRow } from '@/lib/decomposition/types'

function fmtNum(n: number, isMoney: boolean) {
  if (isMoney) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M KGS'
    return (n / 1_000).toFixed(0) + ' K KGS'
  }
  return n.toLocaleString('ru')
}

function pctColor(pct: number) {
  if (pct >= 100) return { text: '#10b981', bg: '#f0fdf4' }
  if (pct >= 70)  return { text: '#0c4d6c', bg: '#e8f4f8' }
  if (pct >= 40)  return { text: '#f59e0b', bg: '#fffbeb' }
  return { text: '#ef4444', bg: '#fef2f2' }
}

interface Props {
  rows: SummaryRow[]
  monthLabel: string
}

export default function TeamSummaryTable({ rows, monthLabel }: Props) {
  return (
    <div className="rounded-2xl shadow-sm border overflow-hidden" style={{ backgroundColor: '#fff', borderColor: '#ebebee' }}>
      <div className="px-5 py-4 border-b" style={{ borderColor: '#ebebee' }}>
        <p className="text-sm font-semibold" style={{ color: '#0c2136' }}>Итоги команды</p>
        <p className="text-[11px] mt-0.5" style={{ color: '#a2b4c0' }}>{monthLabel}</p>
      </div>
      <table className="w-full">
        <thead>
          <tr style={{ backgroundColor: '#f5f6f8' }}>
            {['Метрика','План','Факт','%','Прогресс'].map((h, i) => (
              <th
                key={h}
                className={`py-3 text-[11px] font-semibold uppercase tracking-wider ${i === 0 ? 'px-5 text-left' : i === 4 ? 'px-4 text-left w-36' : 'px-4 text-right'}`}
                style={{ color: '#a2b4c0' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const clr = pctColor(row.pct)
            return (
              <tr
                key={row.label}
                className="border-t transition-colors"
                style={{ borderColor: i === 0 ? 'transparent' : '#f0f0f0' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <td className="px-5 py-3 text-sm font-medium" style={{ color: '#0c2136' }}>{row.label}</td>
                <td className="px-4 py-3 text-sm text-right font-mono" style={{ color: row.hasTarget ? '#a2b4c0' : '#d1d5db' }}>
                  {row.hasTarget ? fmtNum(row.plan, row.isMoney) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-sm font-bold" style={{ color: '#0c2136' }}>{fmtNum(row.fact, row.isMoney)}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  {row.hasTarget
                    ? <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{ color: clr.text, backgroundColor: clr.bg }}>{row.pct}%</span>
                    : <span className="text-xs" style={{ color: '#d1d5db' }}>—</span>}
                </td>
                <td className="px-4 py-3 w-36">
                  {row.hasTarget
                    ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#f5f6f8' }}>
                          <div className="h-full rounded-full" style={{ width: `${row.pct}%`, backgroundColor: clr.text }} />
                        </div>
                      </div>
                    )
                    : <span className="text-[11px]" style={{ color: '#d1d5db' }}>аналитика</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
