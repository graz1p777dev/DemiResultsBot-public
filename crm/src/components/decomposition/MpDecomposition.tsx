'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { getMpDecomposition, type MpDecompositionData, type MpMetricNorm } from '@/actions/mp-decomposition'
import { distEven } from '@/lib/decomposition/schedule'
import { KpiSelfChecklist } from './KpiSelfChecklist'
import { MpFactForm } from './MpFactForm'
import { computePace, computeCatchUp, periodProgress } from '@/lib/decomposition/pace'
import { PaceForecast, CatchUpBlock, type PaceMetric, type CatchUpMetric } from './PaceBlocks'

const GREEN = '#1b7a4b'
const AMBER = '#b5732f'
const MONO  = "'IBM Plex Mono', monospace"

const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

const METRICS = [
  { key: 'fv',      label: 'ФВ (встречи)', money: false },
  { key: 'sales',   label: 'Продажи',      money: false },
  { key: 'revenue', label: 'Выручка',      money: true },
] as const

const RED = '#c0392b'

function PlanFactCells({ p, f, diff }: { p: number; f: number; diff: number }) {
  return (
    <>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8a9aa6', borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(p)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: f > 0 ? '#0c2136' : '#c3ced5', fontWeight: f > 0 ? 500 : 400, borderBottom: '1px solid #f2f5f7' }}>{fmt(f)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: diff >= 0 ? GREEN : RED, borderBottom: '1px solid #f2f5f7' }}>{(diff >= 0 ? '+' : '') + fmt(diff)}</td>
    </>
  )
}

function TotalPlanFactCells({ p, f, diff }: { p: number; f: number; diff: number }) {
  return (
    <>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#cfe6f1', padding: '8px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>{fmt(p)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmt(f)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', padding: '8px', textAlign: 'right', fontWeight: 700, color: diff >= 0 ? '#7ed6a5' : '#f0a094' }}>{(diff >= 0 ? '+' : '') + fmt(diff)}</td>
    </>
  )
}

export function MpDecomposition({ targetEmployeeId }: { targetEmployeeId?: string }) {
  const [data, setData]       = useState<MpDecompositionData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const d = await getMpDecomposition(targetEmployeeId)
    setData(d)
    setLoading(false)
  }, [targetEmployeeId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  // Справочный план по дням: личный план, равномерно по календарным дням.
  // Оперативная цифра — динамическая «Норма на сегодня» в блоке выше.
  const dayPlans = useMemo(() => {
    const n = data?.daily.length ?? 0
    if (!data?.norms || n === 0) return null
    return {
      fv:      distEven(data.norms.fv.target, n),
      sales:   distEven(data.norms.sales.target, n),
      revenue: distEven(Math.round(data.norms.revenue.target), n),
    }
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

  const noPlan = !data.plan || !data.norms

  // ── Качество работы (п.9, п.10) ──
  // Конверсия закрытия — главный показатель мастерства МП: доля пришедших,
  // которых довели до покупки. Средний чек — по факту, а не плановый.
  const closeConv = data.norms && data.norms.fv.fact > 0
    ? (data.norms.sales.fact / data.norms.fv.fact) * 100
    : null
  const avgCheck = data.norms && data.norms.sales.fact > 0
    ? data.norms.revenue.fact / data.norms.sales.fact
    : null

  // ── Догон и прогноз (п.11) ──
  const { daysPassed, daysTotal } = data.plan
    ? periodProgress(data.plan.date_start, data.plan.date_end)
    : { daysPassed: 0, daysTotal: 0 }

  const catchUpMetrics: CatchUpMetric[] = data.norms
    ? METRICS.map(m => ({
        label:   m.label,
        money:   m.money,
        catchUp: computeCatchUp(data.norms![m.key].target, data.norms![m.key].fact, data.remainingWorkDays),
      }))
    : []

  const paceMetrics: PaceMetric[] = data.norms
    ? METRICS.map(m => ({
        label: m.label,
        money: m.money,
        plan:  data.norms![m.key].target,
        fact:  data.norms![m.key].fact,
        pace:  computePace(data.norms![m.key].target, data.norms![m.key].fact, daysPassed, daysTotal),
      }))
    : []

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
            <div style={{ fontSize: '11.5px', color: '#a2b4c0', marginTop: '3px' }}>
              График {data.scheduleType} · план на {data.mpCount} МП
            </div>
          </div>
        )}
      </header>

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 40px 0' }}>

        {noPlan && (
          <div style={{ ...cardStyle, marginBottom: '24px', borderLeft: '4px solid #b5732f' }}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Нет активного плана компании</div>
            <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '6px 0 0' }}>План на текущую дату не найден. Владелец может создать его на экране «Декомпозиция».</p>
          </div>
        )}

        {data.norms && (
          <>
            {/* ===== ЛИЧНЫЕ ЦЕЛИ ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '18px' }}>
              {METRICS.map(m => {
                const n = data.norms![m.key]
                return (
                  <section key={m.key} style={{ background: '#0c2136', borderRadius: '16px', padding: '20px 22px', boxShadow: '0 6px 24px rgba(12,33,54,0.18)' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 600, color: '#7fc4e0', marginTop: '6px' }}>
                      {fmt(n.target)}{m.money && <span style={{ fontSize: '14px', color: '#6f8598' }}> сом</span>}
                    </div>
                    <div style={{ fontSize: '11.5px', color: '#6f8598', marginTop: '2px' }}>
                      личный план{data.mpCount > 1 ? ` (1/${data.mpCount} от плана компании)` : ''}
                    </div>
                  </section>
                )
              })}
            </div>

            {/* ===== НОРМА НА СЕГОДНЯ ===== */}
            <section style={{ background: 'linear-gradient(135deg, #0c4d6c, #146a8f)', borderRadius: '16px', padding: '22px 26px', marginTop: '24px', boxShadow: '0 8px 30px rgba(12,77,108,0.28)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#fff' }}>Норма на сегодня</h2>
                  <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#cfe6f1' }}>
                    Остаток плана ÷ оставшиеся рабочие дни — пересчитывается каждый день
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#bcd3de', fontWeight: 600 }}>Рабочих дней осталось</div>
                  <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 600, color: '#fff' }}>{data.remainingWorkDays}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
                {METRICS.map(m => {
                  const n: MpMetricNorm = data.norms![m.key]
                  return (
                    <div key={m.key} style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '12px', padding: '14px 16px' }}>
                      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#cfe6f1', fontWeight: 600 }}>{m.label}</div>
                      {n.done ? (
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#9fe8c0', marginTop: '8px' }}>✓ План выполнен</div>
                      ) : n.noDaysLeft ? (
                        <div style={{ marginTop: '8px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#ffc9be' }}>Период на исходе</div>
                          <div style={{ fontSize: '11.5px', color: '#cfe6f1', marginTop: '2px' }}>недобор {fmt(n.remaining)}{m.money ? ' сом' : ''}</div>
                        </div>
                      ) : (
                        <>
                          <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 700, color: '#fff', marginTop: '6px' }}>
                            {fmt(n.norm)}{m.money && <span style={{ fontSize: '13px', color: '#bcd3de' }}> сом</span>}
                            <span style={{ fontSize: '13px', fontWeight: 400, color: '#bcd3de' }}> / день</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#bcd3de', marginTop: '3px' }}>осталось {fmt(n.remaining)}{m.money ? ' сом' : ''}</div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>

            {/* ===== ПРОГРЕСС ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 700 }}>Прогресс с начала периода</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                {METRICS.map(m => {
                  const n = data.norms![m.key]
                  const pct = n.target > 0 ? (n.fact / n.target) * 100 : 0
                  const ok = pct >= 100
                  return (
                    <div key={m.key} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '16px 18px', background: ok ? '#f4faf6' : '#fff' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>{m.label}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
                        <span style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600 }}>{fmt(n.fact)}</span>
                        <span style={{ fontSize: '13px', color: '#8a9aa6' }}>/ {fmt(n.target)}{m.money ? ' сом' : ''}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                        <span style={{ flex: 1, height: '6px', borderRadius: '4px', background: '#e8edf0', overflow: 'hidden', position: 'relative', display: 'inline-block' }}>
                          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, pct).toFixed(0)}%`, background: ok ? GREEN : (pct >= 90 ? AMBER : '#0c4d6c'), borderRadius: '4px' }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: '13px', fontWeight: 600, color: ok ? GREEN : '#0c2136' }}>{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* ===== МАСТЕРСТВО: КОНВЕРСИЯ ЗАКРЫТИЯ + СРЕДНИЙ ЧЕК + МЕСТО (п.9, 10, 12) ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Качество работы</h2>
              <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>
                Не объём, а мастерство: сколько пришедших доводите до покупки и на какую сумму
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: data.rank ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: '16px' }}>
                {/* Конверсия закрытия — главный KPI менеджера продаж */}
                <div style={{ borderRadius: '12px', padding: '18px 20px', background: '#0c2136' }}>
                  <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>
                    Конверсия закрытия
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: '32px', fontWeight: 600, color: '#7fc4e0', marginTop: '6px', lineHeight: 1 }}>
                    {closeConv === null ? '—' : `${closeConv.toFixed(1)}%`}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6f8598', marginTop: '8px' }}>
                    пришло {fmt(data.norms.fv.fact)} → купило {fmt(data.norms.sales.fact)}
                  </div>
                </div>

                {/* Средний чек по факту */}
                <div style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '18px 20px', background: '#f6f9fa' }}>
                  <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a9aa6', fontWeight: 600 }}>
                    Средний чек
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: '32px', fontWeight: 600, color: '#0c4d6c', marginTop: '6px', lineHeight: 1 }}>
                    {avgCheck === null ? '—' : fmt(avgCheck)}
                    {avgCheck !== null && <span style={{ fontSize: '14px', color: '#a2b4c0' }}> сом</span>}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6b7d8a', marginTop: '8px' }}>
                    выручка ÷ продажи, по факту
                  </div>
                </div>

                {/* Место в рейтинге — мягко, без имён коллег */}
                {data.rank && (
                  <div style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '18px 20px', background: data.rank.place === 1 ? '#f4faf6' : '#fff' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a9aa6', fontWeight: 600 }}>
                      Место по выручке
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: '32px', fontWeight: 600, color: data.rank.place === 1 ? GREEN : '#0c2136', marginTop: '6px', lineHeight: 1 }}>
                      {data.rank.place}
                      <span style={{ fontSize: '16px', color: '#a2b4c0' }}> из {data.rank.total}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#6b7d8a', marginTop: '8px' }}>
                      {data.rank.place === 1 ? 'Лучший результат в отделе' : 'среди менеджеров отдела'}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* ===== НУЖНО В ДЕНЬ + ПРОГНОЗ (п.11) ===== */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '24px', marginTop: '24px', alignItems: 'start' }}>
              <CatchUpBlock metrics={catchUpMetrics} remainingWorkDays={data.remainingWorkDays} />
              <PaceForecast
                metrics={paceMetrics}
                subtitle={`Прошло ${daysPassed} из ${daysTotal} дней периода. Если темп не изменится — таким будет итог.`}
              />
            </div>

            {/* ===== ПОСЕТИТЕЛИ БЕЗ ЗАПИСИ ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '14px' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Посетители без записи</h2>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '3px 9px', borderRadius: '999px' }}>только факт</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
                {[
                  { label: 'Посетители без записи', value: fmt(data.noNvTotals.visitors), money: false },
                  { label: 'Продажи без записи',    value: fmt(data.noNvTotals.sales),    money: false },
                  { label: 'Выручка без записи',    value: fmt(data.noNvTotals.revenue),  money: true },
                ].map(c => (
                  <div key={c.label} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '15px 17px', background: c.money ? '#f6f9fa' : '#fff' }}>
                    <div style={{ fontSize: '12px', color: '#8a9aa6', fontWeight: 600 }}>{c.label}</div>
                    <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600, color: c.money ? '#0c4d6c' : '#0c2136', marginTop: '4px' }}>
                      {c.value}{c.money && <span style={{ fontSize: '13px', color: '#a2b4c0' }}> сом</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ===== ПОСТОЯННЫЕ КЛИЕНТЫ (Часть 4, п.15) ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '6px', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Постоянные клиенты</h2>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '3px 9px', borderRadius: '999px' }}>только факт</span>
              </div>
              <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#6b7d8a' }}>
                Отмечены галочкой «Постоянный клиент» в записи. На план не влияют — это статистика повторных покупок.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
                {[
                  { label: 'Продаж постоянным', value: fmt(data.returningTotals.sales),   money: false },
                  { label: 'Выручка от них',    value: fmt(data.returningTotals.revenue), money: true  },
                  {
                    label: 'Доля в продажах',
                    value: data.norms.sales.fact > 0
                      ? `${Math.round((data.returningTotals.sales / data.norms.sales.fact) * 100)}%`
                      : '—',
                    money: false,
                  },
                ].map(c => (
                  <div key={c.label} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '15px 17px', background: c.money ? '#f6f9fa' : '#fff' }}>
                    <div style={{ fontSize: '12px', color: '#8a9aa6', fontWeight: 600 }}>{c.label}</div>
                    <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600, color: c.money ? '#0c4d6c' : '#0c2136', marginTop: '4px' }}>
                      {c.value}{c.money && <span style={{ fontSize: '13px', color: '#a2b4c0' }}> сом</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ===== РУЧНАЯ ПРАВКА ФАКТА — ТОЛЬКО ВЛАДЕЛЕЦ ===== */}
            {/* МП формы не видит: его факт целиком из «Записей». Владелец на экране
                сотрудника может перекрыть авто-факт (страховка от кривой записи). */}
            {data.plan && data.viewerRole === 'owner' && (
              <MpFactForm
                employeeId={data.employee.id}
                employeeName={data.employee.name}
                planStart={data.plan.date_start}
                planEnd={data.plan.date_end}
                overridesByDate={data.overridesByDate}
                onSaved={load}
              />
            )}

            {/* ===== ПЛАН / ФАКТ ПО ДНЯМ ===== */}
            <section style={{ ...cardStyle, marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>План / Факт по дням</h2>
                  <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#6b7d8a' }}>
                    План — справочное равномерное распределение личного плана по календарным дням; оперативная цель — «Норма на сегодня» выше
                  </p>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '4px 10px', borderRadius: '999px' }}>{data.daily.length} дн.</span>
              </div>
              <div style={{ overflow: 'auto', maxHeight: '520px', border: '1px solid #eef2f4', borderRadius: '12px' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '1060px', fontSize: '11.5px', fontFamily: MONO, tableLayout: 'fixed' }}>
                  {/* Ширины явные: план/факт/разница — рабочие колонки, их читают
                      постоянно, поэтому шире; «без записи» — справочный факт, узкие. */}
                  <colgroup>
                    <col style={{ width: '86px' }} />
                    {(['fv', 'sales', 'revenue'] as const).map(k => (
                      ['plan', 'fact', 'diff'].map(sub => (
                        <col key={`${k}-${sub}`} style={{ width: k === 'revenue' ? '92px' : '70px' }} />
                      ))
                    ))}
                    {(['no_nv_visitors', 'no_nv_sales', 'no_nv_revenue'] as const).map(k => (
                      <col key={k} style={{ width: k === 'no_nv_revenue' ? '64px' : '50px' }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th rowSpan={2} style={{ position: 'sticky', left: 0, top: 0, zIndex: 4, background: '#0c2136', color: '#fff', textAlign: 'left', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', minWidth: '78px' }}>Дата</th>
                      {['ФВ', 'Продажи', 'Выручка'].map(h => (
                        <th key={h} colSpan={3} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', borderLeft: '2px solid #24425c' }}>{h}</th>
                      ))}
                      {['Без записи', 'Продажи без записи', 'Выручка без записи'].map(h => (
                        <th key={h} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#123a52', color: '#cfe6f1', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '10px', borderLeft: '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                    <tr>
                      {(['fv', 'sales', 'revenue'] as const).map(k => (
                        ['План', 'Факт', 'Разн.'].map((sub, j) => (
                          <th key={`${k}-${sub}`} style={{ position: 'sticky', top: '32px', zIndex: 3, background: '#eef2f4', color: '#6b7d8a', fontFamily: "'Golos Text', sans-serif", fontWeight: 600, fontSize: '10px', padding: '5px 8px', textAlign: 'right', borderLeft: j === 0 ? '2px solid #dbe3e8' : undefined }}>{sub}</th>
                        ))
                      ))}
                      {(['no_nv_visitors', 'no_nv_sales', 'no_nv_revenue'] as const).map(k => (
                        <th key={`${k}-fact`} style={{ position: 'sticky', top: '32px', zIndex: 3, background: '#eef2f4', color: '#6b7d8a', fontFamily: "'Golos Text', sans-serif", fontWeight: 600, fontSize: '10px', padding: '5px 8px', textAlign: 'right', borderLeft: '2px solid #dbe3e8' }}>Факт</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((d, i) => {
                      const dt = new Date(d.date + 'T00:00:00')
                      const weekend = dt.getDay() === 0 || dt.getDay() === 6
                      return (
                        <tr key={d.date}>
                          <td style={{ position: 'sticky', left: 0, zIndex: 2, background: weekend ? '#f5f8f9' : '#fff', padding: '5px 10px', borderBottom: '1px solid #f2f5f7', whiteSpace: 'nowrap', fontFamily: "'Golos Text', sans-serif" }}>
                            <span style={{ fontWeight: 600 }}>{String(dt.getDate()).padStart(2, '0')}.{String(dt.getMonth() + 1).padStart(2, '0')}</span>
                            <span style={{ color: weekend ? '#b06a5a' : '#8a9aa6', fontSize: '10px', marginLeft: '5px' }}>{['вс','пн','вт','ср','чт','пт','сб'][dt.getDay()]}</span>
                          </td>
                          {(['fv', 'sales', 'revenue'] as const).map(k => {
                            const p = dayPlans?.[k][i] ?? 0
                            const f = d[k]
                            const diff = f - p
                            return (
                              <PlanFactCells key={k} p={p} f={f} diff={diff} />
                            )
                          })}
                          {([d.no_nv_visitors, d.no_nv_sales, d.no_nv_revenue]).map((v, j) => (
                            <td key={j} style={{ padding: '5px 8px', textAlign: 'right', color: v > 0 ? '#0c2136' : '#c3ced5', fontWeight: v > 0 ? 500 : 400, borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(v)}</td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700, fontSize: '12px' }}>Итого</td>
                      {(['fv', 'sales', 'revenue'] as const).map(k => {
                        const p = dayPlans ? dayPlans[k].reduce((a, b) => a + b, 0) : 0
                        const f = data.daily.reduce((a, d) => a + d[k], 0)
                        const diff = f - p
                        return (
                          <TotalPlanFactCells key={k} p={p} f={f} diff={diff} />
                        )
                      })}
                      {(['no_nv_visitors', 'no_nv_sales', 'no_nv_revenue'] as const).map(k => (
                        <td key={k} style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>
                          {fmt(data.daily.reduce((a, d) => a + d[k], 0))}
                        </td>
                      ))}
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
