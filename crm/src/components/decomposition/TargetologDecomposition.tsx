'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  getTargetologDecomposition,
  saveMarketingDaily,
  upsertMarketingPlan,
  type TargetologData,
} from '@/actions/marketing-decomposition'
import { KpiSelfChecklist } from './KpiSelfChecklist'

const GREEN = '#1b7a4b'
const AMBER = '#b5732f'
const RED   = '#c0392b'
const MONO  = "'IBM Plex Mono', monospace"

const fmt  = (n: number): string => Math.round(n).toLocaleString('ru-RU')
const fmt2 = (n: number): string => (Math.round(n * 100) / 100).toLocaleString('ru-RU')

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #d3dde3', borderRadius: '10px', padding: '10px 12px',
  fontSize: '15px', fontFamily: MONO, fontWeight: 500, color: '#0c2136',
  background: '#fff', width: '100%', boxSizing: 'border-box',
}

const ENTRY_FIELDS = [
  { key: 'active_campaigns', label: 'Работающих кампаний' },
  { key: 'reach',            label: 'Охваты' },
  { key: 'clicks',           label: 'Клики' },
  { key: 'budget',           label: 'Бюджет за день (без НДС)' },
  { key: 'ad_appeals',       label: 'Обращения от рекламы' },
] as const

type EntryKey = typeof ENTRY_FIELDS[number]['key']

export function TargetologDecomposition({ targetEmployeeId }: { targetEmployeeId?: string }) {
  const [data, setData]       = useState<TargetologData | null>(null)
  const [loading, setLoading] = useState(true)

  // Форма дневного ввода
  const [entryDate, setEntryDate] = useState('')
  const [entry, setEntry] = useState<Record<EntryKey, string>>({ active_campaigns: '', reach: '', clicks: '', budget: '', ad_appeals: '' })
  const [saving, setSaving] = useState(false)

  // Форма плана (владелец)
  const [planBudget, setPlanBudget]   = useState('')
  const [planAppeals, setPlanAppeals] = useState('')
  const [planSaving, setPlanSaving]   = useState(false)

  const prefillFor = useCallback((d: TargetologData, date: string) => {
    const row = d.daily.find(r => r.date === date)
    const hasData = row && (row.active_campaigns || row.reach || row.clicks || row.budget || row.ad_appeals)
    setEntry({
      active_campaigns: hasData ? String(row.active_campaigns) : '',
      reach:            hasData ? String(row.reach) : '',
      clicks:           hasData ? String(row.clicks) : '',
      budget:           hasData ? String(row.budget) : '',
      ad_appeals:       hasData ? String(row.ad_appeals) : '',
    })
  }, [])

  const load = useCallback(async (keepDate?: string) => {
    const d = await getTargetologDecomposition(targetEmployeeId)
    setData(d)
    setLoading(false)
    if (d?.plan) {
      const today = new Date().toISOString().slice(0, 10)
      const clamped = today < d.plan.date_start ? d.plan.date_start
                    : today > d.plan.date_end   ? d.plan.date_end
                    : today
      const date = keepDate ?? clamped
      setEntryDate(date)
      prefillFor(d, date)
    }
  }, [targetEmployeeId, prefillFor])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const handleDateChange = (date: string) => {
    setEntryDate(date)
    if (data) prefillFor(data, date)
  }

  const handleSave = async () => {
    if (!data?.employee.id || !entryDate) return
    setSaving(true)
    const res = await saveMarketingDaily(data.employee.id, entryDate, {
      active_campaigns: Number(entry.active_campaigns) || 0,
      reach:            Number(entry.reach) || 0,
      clicks:           Number(entry.clicks) || 0,
      budget:           Number(entry.budget) || 0,
      ad_appeals:       Number(entry.ad_appeals) || 0,
    })
    setSaving(false)
    if (res.success) {
      toast.success(`Данные за ${entryDate.split('-').reverse().join('.')} сохранены`)
      void load(entryDate)
    } else {
      toast.error(res.error)
    }
  }

  const handleCreatePlan = async () => {
    const now = new Date()
    const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const lastD = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const last  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastD.getDate()).padStart(2, '0')}`
    setPlanSaving(true)
    const res = await upsertMarketingPlan({
      date_start:     first,
      date_end:       last,
      target_budget:  Number(planBudget) || 0,
      target_appeals: Number(planAppeals) || 0,
    })
    setPlanSaving(false)
    if (res.success) { toast.success('План маркетинга создан'); void load() }
    else toast.error(res.error)
  }

  // ── Расчёты ─────────────────────────────────────────────────────────────────
  const calc = useMemo(() => {
    if (!data?.plan) return null
    const today = new Date().toISOString().slice(0, 10)
    const spent   = data.daily.reduce((s, r) => s + r.budget, 0)
    const appeals = data.daily.reduce((s, r) => s + r.ad_appeals, 0)
    const revenue = data.daily.filter(r => r.date <= today).reduce((s, r) => s + r.company_revenue, 0)
    const cpi = appeals > 0 ? spent / appeals : null
    const drr = revenue > 0 ? (spent / revenue) * 100 : null
    const budgetPct  = data.plan.target_budget > 0 ? (spent / data.plan.target_budget) * 100 : 0
    const appealsPct = data.plan.target_appeals > 0 ? (appeals / data.plan.target_appeals) * 100 : 0
    return { spent, appeals, revenue, cpi, drr, budgetPct, appealsPct }
  }, [data])

  if (loading || !data) {
    return (
      <div style={{ minHeight: '100vh', background: '#e6ebee', padding: '20px' }}>
        {[100, 160, 160, 300].map((h, i) => (
          <div key={i} className="animate-pulse" style={{ height: h, background: '#dde4e9', borderRadius: '16px', marginBottom: '16px' }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#e6ebee', paddingBottom: '56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: '#0c2136' }}>

      {/* ===== HEADER ===== */}
      <header style={{ background: '#0c2136', color: '#fff', padding: '20px 40px', display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap', boxShadow: '0 2px 20px rgba(12,33,54,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, minWidth: '240px' }}>
          <div style={{ width: '46px', height: '46px', borderRadius: '12px', background: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 11l14-5v12L3 13v-2zM17 8.5c1.7 0 3 1.6 3 3.5s-1.3 3.5-3 3.5M7 13v5a2 2 0 0 0 4 0v-4" stroke="#e6ebee" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Demi Results OS · Маркетинг</div>
            <div style={{ fontSize: '21px', fontWeight: 700, letterSpacing: '-0.01em', marginTop: '2px' }}>
              {data.employee.name ? `Декомпозиция — ${data.employee.name}` : 'Моя декомпозиция'}
            </div>
          </div>
        </div>
        {data.plan && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Период плана</div>
            <div style={{ fontFamily: MONO, fontSize: '16px', fontWeight: 600, marginTop: '2px' }}>
              {data.plan.date_start.split('-').reverse().join('.')} — {data.plan.date_end.split('-').reverse().join('.')}
            </div>
          </div>
        )}
      </header>

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 40px 0' }}>

        {/* ── Нет плана ── */}
        {!data.plan && (
          <div style={{ ...cardStyle, marginBottom: '24px', borderLeft: '4px solid #b5732f' }}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Нет активного плана маркетинга</div>
            {data.isOwner ? (
              <div style={{ marginTop: '14px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: '180px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '5px' }}>Целевой бюджет на рекламу, сом</span>
                  <input type="number" value={planBudget} onChange={e => setPlanBudget(e.target.value)} placeholder="например 150000" style={inputStyle} />
                </label>
                <label style={{ flex: 1, minWidth: '180px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '5px' }}>Целевые обращения от рекламы</span>
                  <input type="number" value={planAppeals} onChange={e => setPlanAppeals(e.target.value)} placeholder="например 500" style={inputStyle} />
                </label>
                <button
                  onClick={() => void handleCreatePlan()}
                  disabled={planSaving}
                  style={{ background: planSaving ? '#5c6f7c' : '#0c4d6c', color: '#fff', border: 'none', borderRadius: '10px', padding: '12px 20px', fontSize: '14px', fontWeight: 600, cursor: planSaving ? 'default' : 'pointer', fontFamily: 'inherit' }}
                >
                  {planSaving ? 'Создание…' : 'Создать план на текущий месяц'}
                </button>
              </div>
            ) : (
              <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '6px 0 0' }}>Владелец задаст целевой бюджет и обращения — план появится здесь.</p>
            )}
          </div>
        )}

        {data.plan && calc && (
          <>
            {/* ===== ЦЕЛИ И ПРОГРЕСС ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px' }}>
              {[
                { label: 'Бюджет на рекламу', target: data.plan.target_budget, fact: calc.spent, pct: calc.budgetPct, money: true,
                  hint: 'потрачено / цель · перерасход подсвечивается' },
                { label: 'Обращения от рекламы', target: data.plan.target_appeals, fact: calc.appeals, pct: calc.appealsPct, money: false,
                  hint: 'получено / цель периода' },
              ].map(c => {
                // Для бюджета перевыполнение = плохо (перерасход), для обращений = хорошо
                const barColor = c.money
                  ? (c.pct > 100 ? RED : '#4fd1a5')
                  : (c.pct >= 100 ? GREEN : c.pct >= 80 ? AMBER : '#0c4d6c')
                return (
                  <section key={c.label} style={{ background: '#0c2136', borderRadius: '16px', padding: '22px 24px', boxShadow: '0 6px 24px rgba(12,33,54,0.18)', color: '#fff' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>{c.label}</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '8px' }}>
                      <span style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 600, color: '#7fc4e0' }}>{fmt(c.fact)}</span>
                      <span style={{ fontFamily: MONO, fontSize: '15px', color: '#6f8598' }}>/ {fmt(c.target)}{c.money ? ' сом' : ''}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' }}>
                      <span style={{ flex: 1, height: '7px', borderRadius: '4px', background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative', display: 'inline-block' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, c.pct).toFixed(0)}%`, background: barColor, borderRadius: '4px' }} />
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700 }}>{c.pct.toFixed(0)}%</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#6f8598', marginTop: '7px' }}>{c.hint}</div>
                  </section>
                )
              })}
            </div>

            {/* ===== CPI / ДРР ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px', marginTop: '24px' }}>
              <section style={cardStyle}>
                <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600 }}>CPI · цена обращения</div>
                <div style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 600, marginTop: '8px' }}>
                  {calc.cpi !== null ? <>{fmt2(calc.cpi)} <span style={{ fontSize: '14px', color: '#a2b4c0' }}>сом</span></> : '—'}
                </div>
                <div style={{ fontSize: '12px', color: '#7b8a95', marginTop: '6px' }}>бюджет периода ÷ обращения от рекламы</div>
              </section>
              <section style={cardStyle}>
                <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600 }}>ДРР · доля рекламных расходов</div>
                <div style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 600, marginTop: '8px', color: calc.drr !== null && calc.drr > 20 ? RED : '#0c2136' }}>
                  {calc.drr !== null ? `${fmt2(calc.drr)}%` : '—'}
                </div>
                <div style={{ fontSize: '12px', color: '#7b8a95', marginTop: '6px' }}>бюджет ÷ выручка компании за период × 100%</div>
              </section>
            </div>

            {/* ===== ФОРМА ДНЕВНОГО ВВОДА ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Ежедневный ввод</h2>
              <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>
                Данные за день{data.viewerRole === 'owner' ? ` сотрудника «${data.employee.name}»` : ''} — при повторном вводе перезаписываются
              </p>
              <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>Дата</span>
                  <input
                    type="date"
                    value={entryDate}
                    min={data.plan.date_start}
                    max={data.plan.date_end}
                    onChange={e => handleDateChange(e.target.value)}
                    style={{ border: '1px solid #d3dde3', borderRadius: '10px', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit', color: '#0c2136', background: '#fff' }}
                  />
                </label>
                {ENTRY_FIELDS.map(f => (
                  <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '130px' }}>
                    <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>{f.label}</span>
                    <input
                      type="number"
                      min={0}
                      value={entry[f.key]}
                      placeholder="0"
                      onChange={e => setEntry(prev => ({ ...prev, [f.key]: e.target.value }))}
                      style={inputStyle}
                    />
                  </label>
                ))}
                <button
                  onClick={() => void handleSave()}
                  disabled={saving || !entryDate}
                  style={{ background: saving ? '#5c6f7c' : '#0c4d6c', color: '#fff', border: 'none', borderRadius: '10px', padding: '12px 22px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer', fontFamily: 'inherit' }}
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            </section>

            {/* ===== ТАБЛИЦА ПО ДНЯМ ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Данные по дням</h2>
                  <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#6b7d8a' }}>CPI и ДРР считаются автоматически; ДРР — от дневной выручки компании</p>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '4px 10px', borderRadius: '999px' }}>{data.daily.length} дн.</span>
              </div>
              <div style={{ overflow: 'auto', maxHeight: '520px', border: '1px solid #eef2f4', borderRadius: '12px' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '860px', fontSize: '11.5px', fontFamily: MONO }}>
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 4, background: '#0c2136', color: '#fff', textAlign: 'left', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', minWidth: '78px' }}>Дата</th>
                      {['Кампании', 'Охваты', 'Клики', 'Бюджет', 'Обращения', 'CPI', 'ДРР'].map(h => (
                        <th key={h} style={{ position: 'sticky', top: 0, zIndex: 3, background: h === 'CPI' || h === 'ДРР' ? '#0c4d6c' : '#0c2136', color: '#fff', padding: '7px 10px', fontFamily: "'Golos Text', sans-serif", fontSize: '10.5px', textAlign: 'right', borderLeft: '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map(d => {
                      const dt = new Date(d.date + 'T00:00:00')
                      const weekend = dt.getDay() === 0 || dt.getDay() === 6
                      const cpi = d.ad_appeals > 0 ? d.budget / d.ad_appeals : null
                      const drr = d.company_revenue > 0 && d.budget > 0 ? (d.budget / d.company_revenue) * 100 : null
                      const empty = !d.budget && !d.ad_appeals && !d.reach && !d.clicks && !d.active_campaigns
                      return (
                        <tr key={d.date}>
                          <td style={{ position: 'sticky', left: 0, zIndex: 2, background: weekend ? '#f5f8f9' : '#fff', padding: '5px 10px', borderBottom: '1px solid #f2f5f7', whiteSpace: 'nowrap', fontFamily: "'Golos Text', sans-serif" }}>
                            <span style={{ fontWeight: 600 }}>{String(dt.getDate()).padStart(2, '0')}.{String(dt.getMonth() + 1).padStart(2, '0')}</span>
                            <span style={{ color: weekend ? '#b06a5a' : '#8a9aa6', fontSize: '10px', marginLeft: '5px' }}>{['вс','пн','вт','ср','чт','пт','сб'][dt.getDay()]}</span>
                          </td>
                          {[d.active_campaigns, d.reach, d.clicks, d.budget, d.ad_appeals].map((v, i) => (
                            <td key={i} style={{ padding: '5px 10px', textAlign: 'right', color: empty ? '#c3ced5' : '#0c2136', fontWeight: v > 0 ? 500 : 400, borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(v)}</td>
                          ))}
                          <td style={{ padding: '5px 10px', textAlign: 'right', color: cpi !== null ? '#0c4d6c' : '#c3ced5', fontWeight: 600, borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{cpi !== null ? fmt2(cpi) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', color: drr !== null ? (drr > 20 ? RED : '#0c4d6c') : '#c3ced5', fontWeight: 600, borderBottom: '1px solid #f2f5f7' }}>{drr !== null ? fmt2(drr) + '%' : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700, fontSize: '12px' }}>Итого</td>
                      {(['active_campaigns', 'reach', 'clicks', 'budget', 'ad_appeals'] as const).map(k => (
                        <td key={k} style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px 10px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>
                          {k === 'active_campaigns' ? '—' : fmt(data.daily.reduce((a, d) => a + d[k], 0))}
                        </td>
                      ))}
                      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#cfe6f1', padding: '8px 10px', textAlign: 'right', fontWeight: 700, borderLeft: '2px solid #24425c' }}>{calc.cpi !== null ? fmt2(calc.cpi) : '—'}</td>
                      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#cfe6f1', padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{calc.drr !== null ? fmt2(calc.drr) + '%' : '—'}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ===== KPI-ЧЕКЛИСТ (общий компонент) ===== */}
        {data.employee.id && <KpiSelfChecklist employeeId={data.employee.id} />}
      </div>
    </div>
  )
}
