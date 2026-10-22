'use client'

import { useState, useEffect } from 'react'
import {
  getDecompositionOverviewBundle,
  type CompanyPlan,
  type FunnelFact,
} from '@/actions/company-plan'
import type { MarketingOverviewCard } from '@/actions/marketing-decomposition'
import type { DepartmentOption } from '@/actions/my-decomposition'

const MONO = "'IBM Plex Mono', monospace"
const GREEN = '#1b7a4b'
const AMBER = '#b5732f'
const RED   = '#c0392b'

const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

function isSalesDept(name: string): boolean {
  return name.toLowerCase().includes('прода')
}

function isMarketingDept(name: string): boolean {
  return name.toLowerCase().includes('маркет')
}

// ─── Обзорный дашборд хаба: сводка по отделам без таблиц ─────────────────────

export function DecompositionOverview({
  departments,
  onSelectDept,
}: {
  departments: DepartmentOption[]
  onSelectDept: (deptId: string) => void
}) {
  const [plan, setPlan] = useState<CompanyPlan | null>(null)
  const [fact, setFact] = useState<FunnelFact | null>(null)
  const [loading, setLoading] = useState(true)
  const [mkt, setMkt] = useState<MarketingOverviewCard | null>(null)
  const [mktLoading, setMktLoading] = useState(true)

  // План, факт и карточка маркетинга — одним Server Action вместо трёх
  // последовательных POST'ов (Next.js их всё равно сериализует). Условие показа
  // карточки маркетинга прежнее — просто вычисляется до запроса, а не после.
  const hasMarketingDept = departments.some(d => isMarketingDept(d.name))

  useEffect(() => {
    let cancelled = false
    getDecompositionOverviewBundle(hasMarketingDept).then(({ plan: p, fact: f, marketing: m }) => {
      if (cancelled) return
      setPlan(p)
      setFact(f)
      setLoading(false)
      if (hasMarketingDept) { setMkt(m); setMktLoading(false) }
    })
    return () => { cancelled = true }
  }, [hasMarketingDept])

  const revenuePlan = plan ? Number(plan.target_revenue) : 0
  const revenueFact = fact?.revenue ?? 0
  const pct = revenuePlan > 0 ? (revenueFact / revenuePlan) * 100 : 0
  const pctColor = pct >= 100 ? GREEN : pct >= 80 ? AMBER : RED

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 40px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: '#0c2136' }}>

      {/* Заголовок обзора */}
      <div style={{ marginBottom: '22px' }}>
        <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8a9aa6', fontWeight: 600 }}>Demi Results OS</div>
        <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.01em', marginTop: '2px' }}>Декомпозиция — обзор по отделам</div>
        <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#6b7d8a' }}>
          Выберите отдел выше или нажмите на карточку, чтобы открыть детальную декомпозицию
        </p>
      </div>

      {/* Карточки отделов */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
        {departments.map(d => {
          const sales = isSalesDept(d.name)

          if (sales) {
            return (
              <button
                key={d.id}
                onClick={() => onSelectDept(d.id)}
                style={{
                  textAlign: 'left', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: '#0c2136', borderRadius: '18px', padding: '26px 28px',
                  boxShadow: '0 12px 30px -18px rgba(12,33,54,0.5)', color: '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6" stroke="#e6ebee" strokeWidth="1.9" strokeLinecap="round"/></svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 700 }}>{d.name}</div>
                      {plan && (
                        <div style={{ fontSize: '11.5px', color: '#a2b4c0', fontFamily: MONO }}>
                          {plan.date_start.split('-').reverse().join('.')} — {plan.date_end.split('-').reverse().join('.')}
                        </div>
                      )}
                    </div>
                  </div>
                  <span style={{ color: '#7fc4e0', fontSize: '18px' }}>→</span>
                </div>

                {loading ? (
                  <div style={{ height: '96px', display: 'flex', alignItems: 'center', color: '#6f8598', fontSize: '13px' }}>Загрузка…</div>
                ) : !plan ? (
                  <div style={{ height: '96px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '4px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e6ebee' }}>Нет активного плана</div>
                    <div style={{ fontSize: '12px', color: '#6f8598' }}>Создайте план внутри декомпозиции отдела</div>
                  </div>
                ) : (
                  <>
                    {/* Факт / План выручки */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: MONO, fontSize: '38px', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>{fmt(revenueFact)}</span>
                      <span style={{ fontFamily: MONO, fontSize: '16px', color: '#6f8598' }}>/ {fmt(revenuePlan)} сом</span>
                    </div>
                    <div style={{ fontSize: '11.5px', color: '#a2b4c0', marginTop: '5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Выручка · факт / план периода</div>

                    {/* Прогресс */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                      <span style={{ flex: 1, height: '8px', borderRadius: '5px', background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative', display: 'inline-block' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, pct).toFixed(0)}%`, background: pct >= 100 ? '#4fd1a5' : pct >= 80 ? '#e0b46a' : '#e08a7a', borderRadius: '5px' }} />
                      </span>
                      <span style={{
                        fontFamily: MONO, fontSize: '17px', fontWeight: 700,
                        background: 'rgba(255,255,255,0.08)', border: `1px solid ${pctColor}55`,
                        color: pct >= 100 ? '#4fd1a5' : pct >= 80 ? '#e0b46a' : '#e08a7a',
                        borderRadius: '999px', padding: '4px 13px',
                      }}>
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  </>
                )}
              </button>
            )
          }

          // Карточка отдела маркетинга — метрика ОБРАЩЕНИЯ (факт/план), стиль как у продаж.
          // mkt === null (нет права marketing.view) → проваливаемся в заглушку (fail-closed).
          if (isMarketingDept(d.name) && (mkt || mktLoading)) {
            const appealsFact = mkt?.appealsFact ?? 0
            const appealsPlan = mkt?.appealsPlan ?? null
            const mpct = appealsPlan && appealsPlan > 0 ? (appealsFact / appealsPlan) * 100 : 0
            const mpctColor = mpct >= 100 ? GREEN : mpct >= 80 ? AMBER : RED
            const br = mkt?.breakdown
            return (
              <button
                key={d.id}
                onClick={() => onSelectDept(d.id)}
                style={{
                  textAlign: 'left', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: '#0c2136', borderRadius: '18px', padding: '26px 28px',
                  boxShadow: '0 12px 30px -18px rgba(12,33,54,0.5)', color: '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 11l14-5v12L3 13v-2zM17 8.5c1.7 0 3 1.6 3 3.5s-1.3 3.5-3 3.5M7 13v5a2 2 0 0 0 4 0v-4" stroke="#e6ebee" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 700 }}>{d.name}</div>
                      {mkt && (
                        <div style={{ fontSize: '11.5px', color: '#a2b4c0', fontFamily: MONO }}>
                          {mkt.period.start.split('-').reverse().join('.')} — {mkt.period.end.split('-').reverse().join('.')}
                        </div>
                      )}
                    </div>
                  </div>
                  <span style={{ color: '#7fc4e0', fontSize: '18px' }}>→</span>
                </div>

                {mktLoading && !mkt ? (
                  <div style={{ height: '96px', display: 'flex', alignItems: 'center', color: '#6f8598', fontSize: '13px' }}>Загрузка…</div>
                ) : (
                  <>
                    {/* Факт / План обращений */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: MONO, fontSize: '38px', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>{fmt(appealsFact)}</span>
                      <span style={{ fontFamily: MONO, fontSize: '16px', color: '#6f8598' }}>/ {appealsPlan === null ? '—' : fmt(appealsPlan)} обращений</span>
                    </div>
                    <div style={{ fontSize: '11.5px', color: '#a2b4c0', marginTop: '5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Обращения · факт / план периода</div>

                    {/* Прогресс */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                      <span style={{ flex: 1, height: '8px', borderRadius: '5px', background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative', display: 'inline-block' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, mpct).toFixed(0)}%`, background: mpct >= 100 ? '#4fd1a5' : mpct >= 80 ? '#e0b46a' : '#e08a7a', borderRadius: '5px' }} />
                      </span>
                      <span style={{
                        fontFamily: MONO, fontSize: '17px', fontWeight: 700,
                        background: 'rgba(255,255,255,0.08)', border: `1px solid ${mpctColor}55`,
                        color: appealsPlan === null ? '#6f8598' : (mpct >= 100 ? '#4fd1a5' : mpct >= 80 ? '#e0b46a' : '#e08a7a'),
                        borderRadius: '999px', padding: '4px 13px',
                      }}>
                        {appealsPlan === null ? '—' : `${mpct.toFixed(0)}%`}
                      </span>
                    </div>

                    {/* Разбивка факта по каналам */}
                    {br && (
                      <div style={{ fontSize: '11.5px', color: '#8ba0b0', marginTop: '14px', fontFamily: MONO }}>
                        таргет {fmt(br.target)} · органика {fmt(br.organic)} · партнёры {fmt(br.partner)}{br.other > 0 ? ` · прочее ${fmt(br.other)}` : ''}
                      </div>
                    )}
                  </>
                )}
              </button>
            )
          }

          // Отделы без модуля декомпозиции (маркетинг без прав / будущие)
          return (
            <button
              key={d.id}
              onClick={() => onSelectDept(d.id)}
              style={{
                textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                background: '#fff', border: '1.5px dashed #b8c6cf', borderRadius: '18px', padding: '26px 28px',
                boxShadow: '0 2px 14px rgba(12,33,54,0.04)', color: '#0c2136',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: '#eef2f4', border: '1px solid #dbe3e7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 11l14-5v12L3 13v-2zM17 8.5c1.7 0 3 1.6 3 3.5s-1.3 3.5-3 3.5M7 13v5a2 2 0 0 0 4 0v-4" stroke="#8a9aa6" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{d.name}</div>
                </div>
                <span style={{ color: '#a2b4c0', fontSize: '18px' }}>→</span>
              </div>
              <div style={{ height: '96px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '5px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#5c6f7c' }}>Нет данных — модуль в разработке</div>
                <div style={{ fontSize: '12.5px', color: '#8a9aa6' }}>Скоро добавим отслеживание рекламных метрик</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
