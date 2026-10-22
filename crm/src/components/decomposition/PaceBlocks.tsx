'use client'

// Общие блоки «прогноз + светофор» и «сколько нужно сегодня».
// Используются на всех трёх экранах декомпозиции, чтобы формулировки и цвета
// не разъезжались между экранами компании, ЛМ и МП.

import type { PaceResult, CatchUp } from '@/lib/decomposition/pace'

const MONO = "'IBM Plex Mono', monospace"

export const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

/** Одна метрика в блоке прогноза */
export interface PaceMetric {
  label: string
  pace:  PaceResult
  /** true — деньги, показываем «сом» */
  money?: boolean
  plan:  number
  fact:  number
}

/**
 * Блок «Прогноз выполнения» со светофором.
 * Показывает по каждой метрике: текущий факт/план, прогноз к концу периода
 * и словесную оценку. Светофор — цвет плашки.
 */
export function PaceForecast({ metrics, subtitle }: { metrics: PaceMetric[]; subtitle?: string }) {
  return (
    <section style={cardStyle}>
      <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700, color: '#0c2136' }}>
        Прогноз выполнения
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>
        {subtitle ?? 'Если темп не изменится — таким будет итог периода'}
      </p>

      <div style={{ display: 'grid', gap: '10px' }}>
        {metrics.map(m => (
          <div
            key={m.label}
            style={{
              background: m.pace.bg,
              borderRadius: '12px',
              padding: '14px 16px',
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: '12px',
              alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#0c2136' }}>{m.label}</div>
              <div style={{ fontSize: '12.5px', color: m.pace.color, fontWeight: 600, marginTop: '2px' }}>
                {m.pace.label}
              </div>
              <div style={{ fontSize: '11.5px', color: '#6b7d8a', marginTop: '3px', fontFamily: MONO }}>
                сейчас {fmt(m.fact)} из {fmt(m.plan)}{m.money ? ' сом' : ''}
              </div>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 700, color: m.pace.color, lineHeight: 1 }}>
                {Math.round(m.pace.projectedPct)}%
              </div>
              <div style={{ fontSize: '10.5px', color: '#6b7d8a', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                прогноз
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Одна метрика в блоке «нужно сегодня» */
export interface CatchUpMetric {
  label:   string
  catchUp: CatchUp
  money?:  boolean
}

/**
 * Блок «Сколько нужно сегодня».
 * Отвечает на вопрос «что мне сделать», а не «насколько я отстал»:
 * остаток плана делится на оставшиеся РАБОЧИЕ дни сотрудника.
 */
export function CatchUpBlock({
  metrics,
  remainingWorkDays,
  title = 'Сколько нужно в день, чтобы выполнить план',
}: {
  metrics: CatchUpMetric[]
  remainingWorkDays: number
  title?: string
}) {
  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700, color: '#0c2136' }}>{title}</h2>
        <span style={{ fontSize: '12.5px', color: '#6b7d8a' }}>
          осталось рабочих дней: <b style={{ fontFamily: MONO, color: '#0c2136' }}>{remainingWorkDays}</b>
        </span>
      </div>

      <div style={{ display: 'grid', gap: '8px', marginTop: '14px' }}>
        {metrics.map(m => {
          const { catchUp: c } = m
          const done = c.done
          const stuck = c.noDaysLeft

          return (
            <div
              key={m.label}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '12px',
                alignItems: 'center',
                padding: '12px 14px',
                borderRadius: '12px',
                background: done ? '#e6f4ec' : stuck ? '#fbeceb' : '#f4f7f9',
              }}
            >
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#0c2136' }}>{m.label}</div>
                <div style={{ fontSize: '12px', color: '#6b7d8a', marginTop: '2px' }}>
                  {done
                    ? 'План выполнен'
                    : stuck
                      ? 'Рабочих дней в периоде не осталось'
                      : `осталось ${fmt(c.remaining)}${m.money ? ' сом' : ''}`}
                </div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {done ? (
                  <span style={{ fontSize: '20px' }}>✓</span>
                ) : stuck ? (
                  <span style={{ fontFamily: MONO, fontSize: '16px', fontWeight: 700, color: '#c0392b' }}>—</span>
                ) : (
                  <>
                    <div style={{ fontFamily: MONO, fontSize: '20px', fontWeight: 700, color: '#0c4d6c', lineHeight: 1 }}>
                      {m.money ? fmt(c.perDay) : (Math.ceil(c.perDay * 10) / 10).toLocaleString('ru-RU')}
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#6b7d8a', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                      в день
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
