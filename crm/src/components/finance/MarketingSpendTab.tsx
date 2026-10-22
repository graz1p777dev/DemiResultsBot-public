'use client'

// Вкладка «Маркетинг» внутри Финансов — ТОЛЬКО траты за месяц (для P&L).
// Не дублирует маркетинг-декомпозицию: ввод/метрики таргета живут там; здесь —
// производные суммы денег (бюджет таргета + пополнения счёта) и ссылка на детали.

import { useState, useEffect } from 'react'
import { getMarketingSpend, type MarketingSpend } from '@/actions/finance-expenses'

const INK = '#0c2136', ACCENT = '#0c4d6c', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '16px 18px', background: '#fff' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: FAINT }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 700, color: INK, marginTop: '6px', lineHeight: 1 }}>{fmt(value)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
      {hint && <div style={{ fontSize: '11px', color: FAINT, marginTop: '6px' }}>{hint}</div>}
    </div>
  )
}

export default function MarketingSpendTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const [data, setData] = useState<MarketingSpend | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getMarketingSpend(periodMonth).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [periodMonth])

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>→</button>
        {data && (
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Траты на маркетинг</div>
            <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 700, color: ACCENT }}>{fmt(data.targetBudgetSom)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className="animate-pulse" style={{ height: 160, background: '#e9ebee', borderRadius: '16px' }} />
      ) : !data ? (
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontSize: '15px', fontWeight: 700 }}>Нет доступа</div>
          <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
        </div>
      ) : (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Фактические траты на маркетинг за месяц</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 16px' }}>Только факт — сколько уже потрачено. План бюджета — в «Декомпозиция → Отдел маркетинга».</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
            <Tile label="Бюджет таргета (потрачено)" value={data.targetBudgetSom} hint="сомовый эквивалент дневных бюджетов" />
            <Tile label="Пополнения рекламного счёта" value={data.topupsSom} hint="реально списано за месяц" />
          </div>
          <div style={{ marginTop: '14px', fontSize: '12px', color: MUTE, background: '#f4f7f9', border: `1px dashed #cdd8df`, borderRadius: '10px', padding: '10px 12px' }}>
            Это витрина трат для финансов (без дублирования логики). Детализация по дням, цена обращения и доля рекламных расходов, сверка кабинет↔ЛМ — в разделе Декомпозиция.
          </div>
        </div>
      )}
    </div>
  )
}
