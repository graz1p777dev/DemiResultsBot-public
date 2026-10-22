'use client'

// Экран «Планирование бюджета» отдела маркетинга — МАКЕТ-ЗАГЛУШКА (логики нет).
// Смысл на будущее: планировать, сколько потратить на маркетинг в месяц — так же, как
// в отделе продаж планируем оборот, только здесь план ЗАТРАТ. Факт трат уже есть в
// Финансы → Маркетинг; сюда придёт план и сравнение план/факт по каналам.

import { SectionCard } from './skeleton-ui'

const INK = '#0c2136', ACCENT = '#0c4d6c', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"

// Будущие строки плана — показаны как макет (прочерки вместо цифр).
const PLAN_ROWS = [
  { channel: 'Таргет',    hint: 'бюджет рекламного кабинета' },
  { channel: 'Контент',   hint: 'производство, съёмки, продвижение' },
  { channel: 'Партнёры',  hint: 'вознаграждения партнёрам' },
  { channel: 'Прочее',    hint: 'сервисы, инструменты' },
]

export default function BudgetPlanScreen() {
  return (
    <div style={{ display: 'grid', gap: '18px' }}>
      <SectionCard
        title="Планирование бюджета маркетинга"
        subtitle="Сколько планируем потратить на маркетинг в месяц — план затрат по каналам, как план оборота в отделе продаж."
        chip="скоро"
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', marginBottom: '18px',
          background: '#f4f7f9', border: '1px dashed #cdd8df', borderRadius: '12px',
        }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, color: ACCENT, background: '#e2eef4',
            borderRadius: '999px', padding: '4px 11px', whiteSpace: 'nowrap',
          }}>в разработке</span>
          <span style={{ fontSize: '12.5px', color: MUTE }}>
            Это макет будущего экрана — цифры не вводятся и не считаются.
            Фактические траты уже доступны в разделе <b style={{ color: INK }}>Финансы → Маркетинг</b>.
          </span>
        </div>

        {/* Макет таблицы плана */}
        <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '620px', fontSize: '13px' }}>
            <thead>
              <tr>
                {['Канал', 'План на месяц', 'Факт', 'Отклонение'].map((h, i) => (
                  <th key={h} style={{
                    background: INK, color: '#fff', padding: '9px 14px', fontSize: '11px',
                    fontWeight: 600, textAlign: i === 0 ? 'left' : 'right', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLAN_ROWS.map(r => (
                <tr key={r.channel}>
                  <td style={{ padding: '11px 14px', borderBottom: `1px solid ${LINE}` }}>
                    <div style={{ fontWeight: 600, color: INK }}>{r.channel}</div>
                    <div style={{ fontSize: '11px', color: FAINT, marginTop: '2px' }}>{r.hint}</div>
                  </td>
                  {[0, 1, 2].map(i => (
                    <td key={i} style={{ padding: '11px 14px', borderBottom: `1px solid ${LINE}`, textAlign: 'right', fontFamily: MONO, color: STEEL }}>—</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td style={{ padding: '12px 14px', fontWeight: 700, color: INK, background: '#f8fafb' }}>Итого</td>
                {[0, 1, 2].map(i => (
                  <td key={i} style={{ padding: '12px 14px', textAlign: 'right', fontFamily: MONO, fontWeight: 700, color: STEEL, background: '#f8fafb' }}>—</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: '11.5px', color: FAINT, margin: '14px 0 0' }}>
          Задел: план бюджета → сравнение с фактом трат → предупреждение о перерасходе.
        </p>
      </SectionCard>
    </div>
  )
}
