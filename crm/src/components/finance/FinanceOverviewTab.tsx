'use client'

// Вкладка «Обзор» финансов — реальный управленческий P&L за месяц (Шаг 5).
// Никакого mock: всё из реальных данных (Доходы/Расходы/Зарплаты/Маркетинг/Долги)
// через getFinanceOverview. При пустом месяце — честные нули, без выдуманных чисел.

import { useState, useEffect } from 'react'
import { getFinanceOverview, type FinanceOverviewData } from '@/actions/finance-overview'

const INK = '#0c2136', ACCENT = '#0c4d6c', GREEN = '#1b7a4b', RED = '#c0392b', AMBER = '#b5732f', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number | null) => n === null ? '—' : (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

function Delta({ pct, suffix = '%' }: { pct: number | null; suffix?: string }) {
  if (pct === null) return <span style={{ color: FAINT, fontSize: '11px' }}>—</span>
  const up = pct >= 0
  return <span style={{ color: up ? GREEN : RED, fontSize: '11.5px', fontWeight: 700 }}>{up ? '▲' : '▼'} {fmt1(Math.abs(pct))}{suffix}</span>
}

function Metric({ label, value, unit, color, delta }: { label: string; value: string; unit?: string; color?: string; delta?: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '15px 17px', background: '#fff' }}>
      <div style={{ fontSize: '11.5px', fontWeight: 600, color: FAINT }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: '25px', fontWeight: 700, color: color ?? INK, marginTop: '5px', lineHeight: 1 }}>{value}{unit && <span style={{ fontSize: '12px', color: STEEL }}> {unit}</span>}</div>
      {delta && <div style={{ marginTop: '6px' }}>{delta}</div>}
    </div>
  )
}

// ── Каскад «Отчёт о прибылях и убытках» ──────────────────────────────────────
// Строка-слагаемое: плюс (доход) или минус (вычет). Слева знак, справа сумма.
function Line({ label, value, sign, hint }: { label: string; value: number; sign: '+' | '−'; hint?: string }) {
  const minus = sign === '−'
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', padding: '10px 18px' }}>
      <span style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: minus ? RED : GREEN, width: '14px', flexShrink: 0 }}>{sign}</span>
      <div style={{ fontSize: '13.5px', color: MUTE, minWidth: 0 }}>
        {label}
        {hint && <div style={{ fontSize: '11.5px', color: FAINT, marginTop: '2px' }}>{hint}</div>}
      </div>
      <div style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '15px', fontWeight: 600, color: minus ? RED : INK, whiteSpace: 'nowrap' }}>{fmt(value)}</div>
    </div>
  )
}

// Строка-результат уровня: «= Валовая прибыль». Итог месяца — тёмный.
function Result({ label, value, hint, final }: { label: string; value: number; hint?: string; final?: boolean }) {
  const neg = value < 0
  return (
    <div className={`finance-result-row${final ? ' finance-result-row--final' : ''}`} style={{
      display: 'flex', alignItems: 'center', gap: '12px', padding: final ? '16px 18px' : '13px 18px',
      background: final ? INK : '#eef3f6', borderRadius: '12px', marginTop: '6px',
    }}>
      <span style={{ fontFamily: MONO, fontSize: '16px', fontWeight: 700, color: final ? '#7d97ab' : STEEL, width: '14px', flexShrink: 0 }}>=</span>
      <div>
        <div style={{ fontSize: final ? '15px' : '14px', fontWeight: 700, color: final ? '#fff' : INK }}>{label}</div>
        {hint && <div style={{ fontSize: '11.5px', color: final ? '#9fb4c6' : FAINT, marginTop: '2px' }}>{hint}</div>}
      </div>
      <div style={{
        marginLeft: 'auto', fontFamily: MONO, fontSize: final ? '24px' : '18px', fontWeight: 700,
        color: final ? (neg ? '#ff8f7a' : '#7ee0a8') : (neg ? RED : INK), whiteSpace: 'nowrap',
      }}>{fmt(value)} <span style={{ fontSize: '12px', opacity: 0.65 }}>сом</span></div>
    </div>
  )
}

// Заголовок ступени каскада («Шаг 1 · Доходы»)
function Step({ n, title }: { n: number; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px', margin: '18px 0 2px', padding: '0 18px' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px',
        borderRadius: '6px', background: '#e2eaef', color: ACCENT, fontSize: '11px', fontWeight: 700, flexShrink: 0,
      }}>{n}</span>
      <span style={{ fontSize: '11.5px', fontWeight: 700, color: FAINT, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</span>
      <span style={{ flex: 1, height: '1px', background: LINE }} />
    </div>
  )
}

export default function FinanceOverviewTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const [data, setData] = useState<FinanceOverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getFinanceOverview(periodMonth).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [periodMonth])

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[80, 120, 300, 220].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
    </div>
  )
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
    </div>
  )

  const p = data.pnl
  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>

      {/* Выбор месяца */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', fontSize: '12px', color: FAINT }}>Управленческий учёт · данные реальные</div>
      </div>

      {/* Ключевые метрики */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <Metric label="Выручка" value={fmt(p.revenue)} unit="сом" color={ACCENT} delta={<Delta pct={data.delta.revenuePct} />} />
        <Metric label="Чистая прибыль" value={fmt(p.netProfit)} unit="сом" color={p.netProfit >= 0 ? GREEN : RED} delta={<Delta pct={data.delta.netProfitPct} />} />
        <Metric label="Маржа" value={fmt1(p.marginPct)} unit="%" color={INK} delta={<Delta pct={data.delta.marginPp} suffix=" п.п." />} />
        <Metric label="Валовая прибыль" value={fmt(p.grossProfit)} unit="сом" color={INK} />
        <Metric label="Продаж за месяц" value={fmt(p.salesCount)} color={INK} />
        <Metric label="Средний чек" value={fmt(data.avgCheck)} unit="сом" color={INK} />
      </div>

      {/* Каскад «Отчёт о прибылях и убытках» */}
      <div style={{ ...card, padding: '20px 4px' }}>
        <div style={{ padding: '0 18px' }}>
          <div style={{ fontSize: '16px', fontWeight: 700 }}>Отчёт о прибылях и убытках</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '4px 0 0' }}>
            {MONTHS[month].toLowerCase()} {year} · читается сверху вниз: из дохода шаг за шагом вычитаем расходы
          </p>
        </div>

        <Step n={1} title="Доходы" />
        <Line sign="+" label="Выручка от продаж" value={p.revenue} hint={`${fmt(p.salesCount)} продаж · средний чек ${fmt(data.avgCheck)} сом`} />
        <Line sign="+" label="Прочие доходы" value={p.otherIncome} />
        <Result label="Итого доход" value={p.totalIncome} />

        <Step n={2} title="Себестоимость" />
        <Line sign="−" label="Себестоимость товара" value={p.cogs} hint="сколько стоил сам проданный товар · вводится вручную" />
        <Result label="Валовая прибыль" value={p.grossProfit} hint={`остаётся с продаж до остальных расходов · ${fmt1(data.grossMarginPct)}% от дохода`} />

        <Step n={3} title="Расходы на работу бизнеса" />
        <Line sign="−" label="Операционные расходы" value={p.operatingExpenses} hint={`аренда, сервисы, прочее · включая маркетинг ${fmt(p.marketingTotal)} сом`} />
        <Line sign="−" label="Зарплаты (фонд оплаты труда)" value={p.payroll} hint="считается автоматически из раздела «Зарплата»" />

        <Step n={4} title="Результат месяца" />
        <Result final label="Чистая прибыль" value={p.netProfit} hint={`до распределения · маржа ${fmt1(p.marginPct)}% от выручки`} />

        <p style={{ fontSize: '11.5px', color: FAINT, margin: '14px 0 0', padding: '0 18px' }}>
          Выплаты инвесторам и возврат долгов здесь не вычитаются — это уже распределение прибыли (вкладка «Распределение»).
        </p>
      </div>

      {/* Структура расходов + Безубыточность */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '18px' }}>
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Структура расходов</div>
          <p style={{ fontSize: '12px', color: MUTE, margin: '0 0 14px' }}>Вертикальный анализ · доля от совокупных расходов ({fmt(data.totalExpenses)} сом)</p>
          {data.totalExpenses === 0 ? <div style={{ fontSize: '12.5px', color: FAINT }}>Расходов за месяц нет</div> : (
            <div style={{ display: 'grid', gap: '9px' }}>
              {data.expenseStructure.filter(l => l.sum > 0).map(l => (
                <div key={l.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', marginBottom: '3px' }}>
                    <span style={{ color: MUTE }}>{l.name}</span>
                    <span style={{ fontFamily: MONO, color: INK }}><b>{fmt(l.sum)}</b> · {fmt1(l.sharePct)}%</span>
                  </div>
                  <div style={{ height: '7px', background: '#eef2f4', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(l.sharePct ?? 0, 100)}%`, height: '100%', background: ACCENT, borderRadius: '4px' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Точка безубыточности</div>
          <p style={{ fontSize: '12px', color: MUTE, margin: '0 0 14px' }}>Постоянные расходы (опер. + ФОТ) ÷ маржинальность</p>
          <div style={{ display: 'grid', gap: '10px', fontSize: '13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>Постоянные расходы</span><span style={{ fontFamily: MONO, fontWeight: 700 }}>{fmt(data.fixedCosts)} сом</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>Маржинальность</span><span style={{ fontFamily: MONO, fontWeight: 700 }}>{fmt1(data.contributionMarginPct)}%</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${LINE}`, paddingTop: '10px' }}><span style={{ color: INK, fontWeight: 700 }}>Выручка для безубыточности</span><span style={{ fontFamily: MONO, fontWeight: 700, color: ACCENT }}>{data.breakevenRevenue === null ? '—' : `${fmt(data.breakevenRevenue)} сом`}</span></div>
            {data.breakevenRevenue !== null && (
              <div style={{ padding: '10px 12px', borderRadius: '10px', background: data.breakevenReached ? '#eef7f1' : '#fdf3ef', border: `1px solid ${data.breakevenReached ? '#bfe0cc' : '#f0d3c6'}` }}>
                <span style={{ fontSize: '12.5px', fontWeight: 700, color: data.breakevenReached ? GREEN : AMBER }}>
                  {data.breakevenReached ? `Перевыполнено на ${fmt(data.breakevenGap)} сом` : `До безубыточности осталось ${fmt(-data.breakevenGap)} сом`}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Сравнение с прошлым месяцем + Долги */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '18px' }}>
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>Динамика к прошлому месяцу</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px 16px', fontSize: '13px', alignItems: 'baseline' }}>
            <span style={{ color: FAINT, fontSize: '11px' }} /><span style={{ color: FAINT, fontSize: '11px', textAlign: 'right' }}>текущий</span><span style={{ color: FAINT, fontSize: '11px', textAlign: 'right' }}>прошлый</span>
            <span style={{ color: MUTE }}>Выручка</span><span style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700 }}>{fmt(p.revenue)}</span><span style={{ fontFamily: MONO, textAlign: 'right', color: MUTE }}>{fmt(data.prev.revenue)}</span>
            <span style={{ color: MUTE }}>Чистая прибыль</span><span style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700, color: p.netProfit >= 0 ? GREEN : RED }}>{fmt(p.netProfit)}</span><span style={{ fontFamily: MONO, textAlign: 'right', color: MUTE }}>{fmt(data.prev.netProfit)}</span>
            <span style={{ color: MUTE }}>Маржа</span><span style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700 }}>{fmt1(p.marginPct)}%</span><span style={{ fontFamily: MONO, textAlign: 'right', color: MUTE }}>{fmt1(data.prev.marginPct)}%</span>
          </div>
          <div style={{ display: 'flex', gap: '18px', marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${LINE}`, fontSize: '12px' }}>
            <span>выручка: <Delta pct={data.delta.revenuePct} /></span>
            <span>прибыль: <Delta pct={data.delta.netProfitPct} /></span>
            <span>маржа: <Delta pct={data.delta.marginPp} suffix=" п.п." /></span>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>Обязательства (долги)</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
            <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Всего должен</div>
            <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 700, color: data.debtsTotalActiveSom > 0 ? RED : GREEN }}>{fmt(data.debtsTotalActiveSom)} <span style={{ fontSize: '12px', color: STEEL }}>сом</span></div>
          </div>
          {data.nearestDebt ? (
            <div style={{ marginTop: '12px', fontSize: '13px', color: MUTE }}>
              Ближайший возврат: <b style={{ color: INK }}>{data.nearestDebt.creditor}</b> — <span style={{ fontFamily: MONO }}>{fmt(data.nearestDebt.amountSom)} сом</span>
              <span style={{ color: (data.nearestDebt.daysLeft ?? 0) < 0 ? RED : FAINT }}> · {ru(data.nearestDebt.dueDate)}{data.nearestDebt.daysLeft !== null && ` (${data.nearestDebt.daysLeft < 0 ? `просрочен на ${-data.nearestDebt.daysLeft}` : `через ${data.nearestDebt.daysLeft}`} дн.)`}</span>
            </div>
          ) : <div style={{ marginTop: '12px', fontSize: '12.5px', color: FAINT }}>Активных долгов нет</div>}
        </div>
      </div>
    </div>
  )
}
