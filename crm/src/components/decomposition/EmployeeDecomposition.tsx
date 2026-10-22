'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import {
  getMyDecomposition,
  saveMyDailyEntry,
  type MyDecompositionData,
} from '@/actions/my-decomposition'
import { KpiSelfChecklist } from './KpiSelfChecklist'
import { computePace, computeCatchUp, periodProgress } from '@/lib/decomposition/pace'
import { PaceForecast, CatchUpBlock, type PaceMetric, type CatchUpMetric } from './PaceBlocks'

const GREEN = '#1b7a4b'
const RED   = '#c0392b'
const AMBER = '#b5732f'
const MONO  = "'IBM Plex Mono', monospace"

const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

/** Равномерное распределение: сумма всегда равна total */
function distEven(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const rem  = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

function listDays(dateStart: string, dateEnd: string): string[] {
  const days: string[] = []
  const cursor = new Date(dateStart + 'T00:00:00')
  const end    = new Date(dateEnd + 'T00:00:00')
  while (cursor <= end && days.length <= 366) {
    days.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`)
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

const METRICS = [
  { key: 'appeals', label: 'Обращения' },
  { key: 'leads',   label: 'Квалифицированные лиды' },
  { key: 'nv',      label: 'Назначенные встречи' },
] as const

type MetricKey = typeof METRICS[number]['key']

export function EmployeeDecomposition({ targetEmployeeId }: { targetEmployeeId?: string }) {
  const [data, setData]       = useState<MyDecompositionData | null>(null)
  const [loading, setLoading] = useState(true)

  // Форма дневного ввода
  const [entryDate, setEntryDate]       = useState('')
  const [entryAppeals, setEntryAppeals] = useState('')
  const [entryLeads, setEntryLeads]     = useState('')
  const [entryNv, setEntryNv]           = useState('')
  const [saving, setSaving]             = useState(false)

  // Подстановка существующих значений за выбранную дату
  const prefillFor = useCallback((d: MyDecompositionData, date: string) => {
    const row = d.daily.find(r => r.date === date)
    setEntryAppeals(row?.appeals !== null && row?.appeals !== undefined ? String(row.appeals) : '')
    setEntryLeads(row?.leads !== null && row?.leads !== undefined ? String(row.leads) : '')
    setEntryNv(row?.nv !== null && row?.nv !== undefined ? String(row.nv) : '')
  }, [])

  const load = useCallback(async (keepDate?: string) => {
    const d = await getMyDecomposition(targetEmployeeId)
    setData(d)
    setLoading(false)
    if (d?.plan) {
      // Дефолтная дата формы — сегодня, зажатая в границы периода
      const today = new Date().toISOString().slice(0, 10)
      const clamped = today < d.plan.date_start ? d.plan.date_start
                    : today > d.plan.date_end   ? d.plan.date_end
                    : today
      const date = keepDate ?? clamped
      setEntryDate(date)
      prefillFor(d, date)
    }
  }, [prefillFor, targetEmployeeId])

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
    const res = await saveMyDailyEntry(
      data.employee.id,
      entryDate,
      Number(entryAppeals) || 0,
      Number(entryLeads) || 0,
      Number(entryNv) || 0,
    )
    setSaving(false)
    if (res.success) {
      toast.success(`Факт за ${entryDate.split('-').reverse().join('.')} сохранён`)
      void load(entryDate)
    } else {
      toast.error(res.error)
    }
  }

  // ── Расчёты ─────────────────────────────────────────────────────────────────
  const calc = useMemo(() => {
    if (!data?.plan || !data.targets) return null
    const days = listDays(data.plan.date_start, data.plan.date_end)
    const n = days.length
    const plans: Record<MetricKey, number[]> = {
      appeals: distEven(data.targets.appeals, n),
      leads:   distEven(data.targets.leads, n),
      nv:      distEven(data.targets.nv, n),
    }
    const factByDate = new Map(data.daily.map(r => [r.date, r]))
    const today = new Date().toISOString().slice(0, 10)
    // Индекс последнего дня <= сегодня (для плана «на сегодня»)
    let todayIdx = -1
    days.forEach((d, i) => { if (d <= today) todayIdx = i })

    const progress = METRICS.map(m => {
      const target = data.targets![m.key]
      const factTotal = data.daily.reduce((s, r) => s + (r[m.key] ?? 0), 0)
      const planToDate = plans[m.key].slice(0, todayIdx + 1).reduce((a, b) => a + b, 0)
      const pct = target > 0 ? (factTotal / target) * 100 : 0
      const diffToDate = factTotal - planToDate
      return { ...m, target, factTotal, planToDate, pct, diffToDate }
    })

    // Реальная конверсия сотрудника vs ориентиры из company_plans
    const factAppeals = progress[0].factTotal
    const factLeads   = progress[1].factTotal
    const factNv      = progress[2].factTotal
    const realConv = data.convTargets ? [
      { name: 'Обращение → Квалифицированный лид', target: data.convTargets.appeal_lead, num: factLeads, den: factAppeals },
      { name: 'Квалифицированный лид → Назначенная встреча', target: data.convTargets.lead_nv, num: factNv, den: factLeads },
    ].map(c => {
      const factConv = c.den > 0 ? (c.num / c.den) * 100 : null
      const dev = factConv !== null ? factConv - c.target : null
      const above = dev !== null && dev >= 0
      return {
        name:      c.name,
        factFmt:   factConv !== null ? factConv.toFixed(1) + '%' : '—',
        targetFmt: c.target + '%',
        devFmt:    dev !== null ? Math.abs(dev).toFixed(1) + ' п.п.' : '',
        devArrow:  dev === null ? '' : (above ? '▲' : '▼'),
        devColor:  above ? GREEN : RED,
        factColor: factConv === null ? '#8a9aa6' : (above ? '#0c2136' : RED),
        tileBg:    factConv === null ? '#fff' : (above ? '#f4faf6' : '#fdf5f4'),
      }
    }) : []

    // «Сколько нужно в день, чтобы догнать» (п.5) — по рабочим дням сотрудника,
    // и прогноз по темпу (п.6) — по календарным дням периода.
    const { daysPassed, daysTotal } = periodProgress(data.plan.date_start, data.plan.date_end)
    const catchUpMetrics: CatchUpMetric[] = progress.map(p => ({
      label:   p.label,
      catchUp: computeCatchUp(p.target, p.factTotal, data.remainingWorkDays),
    }))
    const paceMetrics: PaceMetric[] = progress.map(p => ({
      label: p.label,
      plan:  p.target,
      fact:  p.factTotal,
      pace:  computePace(p.target, p.factTotal, daysPassed, daysTotal),
    }))

    return { days, plans, factByDate, progress, todayIdx, realConv, catchUpMetrics, paceMetrics, daysPassed, daysTotal }
  }, [data])

  // ── Состояния загрузки и пустых данных ─────────────────────────────────────

  if (loading || !data) {
    return (
      <div style={{ minHeight: '100vh', background: '#e6ebee', padding: '20px' }}>
        {[100, 140, 160, 300].map((h, i) => (
          <div key={i} className="animate-pulse" style={{ height: h, background: '#dde4e9', borderRadius: '16px', marginBottom: '16px' }} />
        ))}
      </div>
    )
  }

  const noLm   = data.viewerRole === 'owner' && !data.employee.id
  const noPlan = !data.plan || !data.targets

  return (
    <div style={{ minHeight: '100vh', background: '#e6ebee', paddingBottom: '56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: '#0c2136' }}>

      {/* ===== HEADER ===== */}
      <header style={{ background: '#0c2136', color: '#fff', padding: '20px 40px', display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap', boxShadow: '0 2px 20px rgba(12,33,54,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, minWidth: '240px' }}>
          <div style={{ width: '46px', height: '46px', borderRadius: '12px', background: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#e6ebee" strokeWidth="1.6"/>
              <circle cx="12" cy="12" r="5" stroke="#a2b4c0" strokeWidth="1.6"/>
              <circle cx="12" cy="12" r="1.7" fill="#e6ebee"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Demi Results OS</div>
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
            {data.viewerRole === 'owner' && data.employee.name && (
              <div style={{ fontSize: '11.5px', color: '#a2b4c0', marginTop: '3px' }}>Сотрудник: {data.employee.name}</div>
            )}
          </div>
        )}
      </header>

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 40px 0' }}>

        {noLm && (
          <div style={{ ...cardStyle, marginBottom: '24px', borderLeft: '4px solid #b5732f' }}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Нет сотрудника с ролью «Менеджер по лидогенерации»</div>
            <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '6px 0 0' }}>Создайте сотрудника с ролью ЛМ в разделе «Сотрудники» — его план появится здесь.</p>
          </div>
        )}

        {noPlan && !noLm && (
          <div style={{ ...cardStyle, marginBottom: '24px', borderLeft: '4px solid #b5732f' }}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Нет активного плана компании</div>
            <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '6px 0 0' }}>План на текущую дату не найден. Владелец может создать его на экране «Декомпозиция».</p>
          </div>
        )}

        {calc && !noLm && (
          <>
            {/* ===== ЦЕЛИ ПЕРИОДА ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '18px' }}>
              {calc.progress.map(p => (
                <section key={p.key} style={{ background: '#0c2136', borderRadius: '16px', padding: '20px 22px', boxShadow: '0 6px 24px rgba(12,33,54,0.18)' }}>
                  <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 600, color: '#7fc4e0', marginTop: '6px' }}>{fmt(p.target)}</div>
                  <div style={{ fontSize: '11.5px', color: '#6f8598', marginTop: '2px' }}>цель на период</div>
                </section>
              ))}
            </div>

            {/* ===== РЕАЛЬНАЯ КОНВЕРСИЯ ===== */}
            {calc.realConv.length > 0 && (
              <section style={{ ...cardStyle, marginTop: '24px' }}>
                <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Реальная конверсия</h2>
                <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>Факт сотрудника по переходам воронки рядом с ориентиром компании</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                  {calc.realConv.map(c => (
                    <div key={c.name} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '15px 16px', background: c.tileBg }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#0c2136', marginBottom: '12px' }}>{c.name}</div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600, color: c.factColor, lineHeight: 1 }}>{c.factFmt}</div>
                          <div style={{ fontSize: '11px', color: '#8a9aa6', marginTop: '5px' }}>ориентир {c.targetFmt}</div>
                        </div>
                        {c.devArrow && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 700, color: c.devColor }}>
                            <span style={{ fontSize: '14px' }}>{c.devArrow}</span>{c.devFmt}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ===== НУЖНО В ДЕНЬ + ПРОГНОЗ (п.5, п.6) ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '24px', marginTop: '24px', alignItems: 'start' }}>
              <CatchUpBlock
                metrics={calc.catchUpMetrics}
                remainingWorkDays={data.remainingWorkDays}
              />
              <PaceForecast
                metrics={calc.paceMetrics}
                subtitle={`Прошло ${calc.daysPassed} из ${calc.daysTotal} дней периода. Если темп не изменится — таким будет итог.`}
              />
            </div>

            {/* ===== ПРОГРЕСС ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 700 }}>Прогресс с начала периода</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                {calc.progress.map(p => {
                  const ok   = p.pct >= 100
                  const onTrack = p.diffToDate >= 0
                  return (
                    <div key={p.key} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '16px 18px', background: onTrack ? '#f4faf6' : '#fdf5f4' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>{p.label}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
                        <span style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600 }}>{fmt(p.factTotal)}</span>
                        <span style={{ fontSize: '13px', color: '#8a9aa6' }}>/ {fmt(p.target)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                        <span style={{ flex: 1, height: '6px', borderRadius: '4px', background: '#e8edf0', overflow: 'hidden', position: 'relative', display: 'inline-block' }}>
                          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, p.pct).toFixed(0)}%`, background: ok ? GREEN : (p.pct >= 90 ? AMBER : '#0c4d6c'), borderRadius: '4px' }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: '13px', fontWeight: 600, color: ok ? GREEN : '#0c2136' }}>{p.pct.toFixed(0)}%</span>
                      </div>
                      <div style={{ fontSize: '11.5px', marginTop: '8px', color: onTrack ? GREEN : RED, fontWeight: 600 }}>
                        {onTrack ? '▲' : '▼'} {p.diffToDate >= 0 ? '+' : ''}{fmt(p.diffToDate)} к плану на сегодня ({fmt(p.planToDate)})
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* ===== ФОРМА ДНЕВНОГО ВВОДА ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Ежедневный ввод факта</h2>
              <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>
                Значения пишутся в дневную активность{data.viewerRole === 'owner' ? ` сотрудника «${data.employee.name}»` : ''} — при повторном вводе за тот же день данные перезаписываются
              </p>
              <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>Дата</span>
                  <input
                    type="date"
                    value={entryDate}
                    min={data.plan?.date_start}
                    max={data.plan?.date_end}
                    onChange={e => handleDateChange(e.target.value)}
                    style={{ border: '1px solid #d3dde3', borderRadius: '10px', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit', color: '#0c2136', background: '#fff' }}
                  />
                </label>
                {([
                  ['Обращения', entryAppeals, setEntryAppeals],
                  ['Квалифицированные лиды', entryLeads, setEntryLeads],
                  ['Назначенные встречи', entryNv, setEntryNv],
                ] as const).map(([label, value, set]) => (
                  <label key={label} style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '140px' }}>
                    <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>{label}</span>
                    <input
                      type="number"
                      min={0}
                      value={value}
                      placeholder="0"
                      onChange={e => set(e.target.value)}
                      style={{ border: '1px solid #d3dde3', borderRadius: '10px', padding: '10px 12px', fontSize: '15px', fontFamily: MONO, fontWeight: 500, color: '#0c2136', background: '#fff', width: '100%', boxSizing: 'border-box' }}
                    />
                  </label>
                ))}
                <button
                  onClick={handleSave}
                  disabled={saving || !entryDate}
                  style={{ background: saving ? '#5c6f7c' : '#0c4d6c', color: '#fff', border: 'none', borderRadius: '10px', padding: '12px 22px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            </section>

            {/* ===== ТАБЛИЦА ПО ДНЯМ ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>План / Факт по дням</h2>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '4px 10px', borderRadius: '999px' }}>{calc.days.length} дн.</span>
              </div>
              <div style={{ overflow: 'auto', maxHeight: '520px', border: '1px solid #eef2f4', borderRadius: '12px' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '760px', fontSize: '11.5px', fontFamily: MONO }}>
                  <thead>
                    <tr>
                      <th rowSpan={2} style={{ position: 'sticky', left: 0, top: 0, zIndex: 4, background: '#0c2136', color: '#fff', textAlign: 'left', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', minWidth: '78px' }}>Дата</th>
                      {METRICS.map(m => (
                        <th key={m.key} colSpan={3} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', borderLeft: '2px solid #24425c' }}>{m.label}</th>
                      ))}
                    </tr>
                    <tr>
                      {METRICS.map(m => (
                        ['План', 'Факт', 'Разн.'].map((sub, j) => (
                          <th key={`${m.key}-${sub}`} style={{ position: 'sticky', top: '32px', zIndex: 3, background: '#eef2f4', color: '#6b7d8a', fontFamily: "'Golos Text', sans-serif", fontWeight: 600, fontSize: '10px', padding: '5px 8px', textAlign: 'right', borderLeft: j === 0 ? '2px solid #dbe3e8' : undefined }}>{sub}</th>
                        ))
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {calc.days.map((day, i) => {
                      const dt = new Date(day + 'T00:00:00')
                      const weekend = dt.getDay() === 0 || dt.getDay() === 6
                      const row = calc.factByDate.get(day)
                      const isFuture = i > calc.todayIdx
                      return (
                        <tr key={day}>
                          <td style={{ position: 'sticky', left: 0, zIndex: 2, background: weekend ? '#f5f8f9' : '#fff', padding: '5px 10px', borderBottom: '1px solid #f2f5f7', whiteSpace: 'nowrap', fontFamily: "'Golos Text', sans-serif" }}>
                            <span style={{ fontWeight: 600 }}>{String(dt.getDate()).padStart(2, '0')}.{String(dt.getMonth() + 1).padStart(2, '0')}</span>
                            <span style={{ color: weekend ? '#b06a5a' : '#8a9aa6', fontSize: '10px', marginLeft: '5px' }}>{['вс','пн','вт','ср','чт','пт','сб'][dt.getDay()]}</span>
                          </td>
                          {METRICS.map(m => {
                            const p = calc.plans[m.key][i] ?? 0
                            const f = row?.[m.key] ?? null
                            const diff = (f ?? 0) - p
                            return (
                              <MetricCells key={m.key} p={p} f={f} diff={diff} muted={isFuture && f === null} />
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700, fontSize: '12px' }}>Итого</td>
                      {METRICS.map(m => {
                        const p = calc.plans[m.key].reduce((a, b) => a + b, 0)
                        const f = data.daily.reduce((s, r) => s + (r[m.key] ?? 0), 0)
                        const diff = f - p
                        return (
                          <TotalMetricCells key={m.key} p={p} f={f} diff={diff} />
                        )
                      })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ===== KPI-ЧЕКЛИСТ (общий компонент самоотметки) ===== */}
        {data.employee.id && <KpiSelfChecklist employeeId={data.employee.id} />}
      </div>
    </div>
  )
}

// ─── Ячейки таблицы ───────────────────────────────────────────────────────────

function MetricCells({ p, f, diff, muted }: { p: number; f: number | null; diff: number; muted: boolean }) {
  return (
    <>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8a9aa6', borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(p)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: f === null ? '#c3ced5' : '#0c2136', fontWeight: 500, borderBottom: '1px solid #f2f5f7' }}>{f === null ? '—' : fmt(f)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: muted ? '#c3ced5' : (diff >= 0 ? GREEN : RED), borderBottom: '1px solid #f2f5f7' }}>
        {muted ? '—' : (diff >= 0 ? '+' : '') + fmt(diff)}
      </td>
    </>
  )
}

function TotalMetricCells({ p, f, diff }: { p: number; f: number; diff: number }) {
  return (
    <>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#cfe6f1', padding: '8px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>{fmt(p)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmt(f)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', padding: '8px', textAlign: 'right', fontWeight: 700, color: diff >= 0 ? '#7ed6a5' : '#f0a094' }}>{(diff >= 0 ? '+' : '') + fmt(diff)}</td>
    </>
  )
}
