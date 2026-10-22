'use client'

// Вкладка «Партнёры» в декомпозиции — ТОЛЬКО аналитика (заведение партнёров
// переехало в раздел «Управление → Партнёры»). Показатели за период из consultations
// по partner_id: прислал → дошло → купило → выручка → конверсия. Рейтинг по выручке.

import { useState, useEffect, useMemo } from 'react'
import { getPartnersWithAggregates, type PartnerAgg } from '@/actions/partners'
import {
  SectionCard, cardStyle, EField, editInputStyle, LoadingBlocks,
  MONO, INK, ACCENT, MUTE, FAINT, LINE, STEEL, DASH,
} from './skeleton-ui'

const fmt  = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const pct  = (n: number | null) => n === null ? DASH : `${fmt1(n)}%`
const monthBounds = () => {
  const now = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) }
}

export default function PartnersScreen() {
  const [period, setPeriod] = useState(monthBounds)
  const [rows, setRows] = useState<PartnerAgg[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getPartnersWithAggregates(period.start, period.end).then(d => { if (!cancelled) { setRows(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [period.start, period.end])

  const active   = useMemo(() => (rows ?? []).filter(p => p.status === 'active'), [rows])
  const inactive = useMemo(() => (rows ?? []).filter(p => p.status !== 'active'), [rows])
  const ranking  = useMemo(() => [...active].filter(p => p.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 5), [active])

  if (loading && !rows) return <LoadingBlocks />
  if (!rows) return <SectionCard title="Нет доступа" subtitle="Недостаточно прав для просмотра партнёров." />

  const cell: React.CSSProperties = { padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}` }
  const th: React.CSSProperties = { background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', whiteSpace: 'nowrap' }

  const renderTable = (list: PartnerAgg[], dim: boolean) => (
    <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px', opacity: dim ? 0.62 : 1 }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '820px', fontSize: '12px', fontFamily: MONO }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Партнёр</th>
            <th style={{ ...th, textAlign: 'left', borderLeft: '2px solid #24425c' }}>Тип</th>
            {['Прислал', 'Дошло', 'Купило', 'Выручка', 'Конверсия'].map(h => <th key={h} style={{ ...th, textAlign: 'right', borderLeft: '2px solid #24425c' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 ? (
            <tr><td colSpan={7} style={{ padding: '18px', textAlign: 'center', color: FAINT, fontFamily: "'Golos Text', sans-serif" }}>Пусто</td></tr>
          ) : list.map(p => (
            <tr key={p.id}>
              <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>{p.name}</td>
              <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", color: MUTE }}>{p.type}</td>
              <td style={{ ...cell, color: p.sent ? INK : FAINT }}>{p.sent ? fmt(p.sent) : DASH}</td>
              <td style={{ ...cell, color: p.reached ? INK : FAINT }}>{p.reached ? fmt(p.reached) : DASH}</td>
              <td style={{ ...cell, color: p.bought ? INK : FAINT }}>{p.bought ? fmt(p.bought) : DASH}</td>
              <td style={{ ...cell, fontWeight: 700, color: p.revenue ? INK : FAINT }}>{p.revenue ? fmt(p.revenue) : DASH}</td>
              <td style={{ ...cell, color: p.conversion === null ? FAINT : ACCENT, fontWeight: 600 }}>{pct(p.conversion)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div style={{ display: 'grid', gap: '24px' }}>

      {/* Период */}
      <section style={{ ...cardStyle, display: 'flex', gap: '18px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <EField label="Начало периода"><input type="date" value={period.start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} style={editInputStyle} /></EField>
        <EField label="Конец периода"><input type="date" value={period.end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} style={editInputStyle} /></EField>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: FAINT }}>Показатели партнёров за выбранный период</span>
      </section>

      {rows.length === 0 && (
        <SectionCard title="Партнёров пока нет" subtitle="Заведите партнёров в разделе «Управление → Партнёры» — здесь появится их аналитика." />
      )}

      {/* Рейтинг */}
      {ranking.length > 0 && (
        <SectionCard title="Рейтинг по выручке" subtitle="Кто приносит больше — за выбранный период">
          <div style={{ display: 'grid', gap: '8px' }}>
            {ranking.map((p, i) => (
              <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '26px 1fr auto', gap: '12px', alignItems: 'center', padding: '11px 14px', borderRadius: '12px', background: i === 0 ? '#e6f4ec' : '#f4f7f9', border: `1px solid ${i === 0 ? '#bfe3cd' : LINE}` }}>
                <span style={{ fontFamily: MONO, fontWeight: 700, color: i === 0 ? '#1b7a4b' : FAINT, textAlign: 'center' }}>{i + 1}</span>
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{p.name} <span style={{ color: STEEL, fontWeight: 400, fontSize: '12px' }}>· {p.type}</span></div>
                  <div style={{ fontSize: '11.5px', color: FAINT, fontFamily: MONO, marginTop: '2px' }}>{fmt(p.bought)} продаж · конверсия {pct(p.conversion)}</div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: i === 0 ? '#1b7a4b' : INK }}>{fmt(p.revenue)} <span style={{ color: STEEL, fontWeight: 400, fontSize: '12px' }}>сом</span></div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Активные */}
      {active.length > 0 && (
        <SectionCard title="Партнёры" subtitle="Выхлоп: прислал → дошло → купило → выручка → конверсия" chip={`${active.length} активных`}>
          {renderTable(active, false)}
        </SectionCard>
      )}

      {/* Неактивные — приглушённо */}
      {inactive.length > 0 && (
        <SectionCard title="Неактивные" subtitle="Партнёры на паузе / завершённые">
          {renderTable(inactive, true)}
        </SectionCard>
      )}

    </div>
  )
}
