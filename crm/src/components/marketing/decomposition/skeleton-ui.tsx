'use client'

// ─── Общие презентационные примитивы каркаса «Декомпозиция · Маркетинг» ────────
// ЭТАП КАРКАСА: только структура и вёрстка. Ни расчётов, ни данных, ни ввода —
// все значения показываются прочерком. Стиль строго фирменный Demi Results.
// Логику наполним следующей задачей.

import type { CSSProperties, ReactNode } from 'react'

// ─── Палитра / типографика ────────────────────────────────────────────────────

export const UI   = "'Golos Text', system-ui, sans-serif"
export const MONO = "'IBM Plex Mono', monospace"

export const INK    = '#0c2136'  // основной текст, тёмный фон
export const ACCENT = '#0c4d6c'  // акцент
export const STEEL  = '#a2b4c0'  // вторичный текст на тёмном
export const MUTE   = '#6b7d8a'  // подписи на светлом
export const FAINT  = '#8a9aa6'  // самый тихий текст / прочерки
export const LINE   = '#eef2f4'  // разделители
export const FOG    = '#e6ebee'  // фон страницы

export const DASH = '—'

export const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '24px 26px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

// ─── Каркас страницы ──────────────────────────────────────────────────────────

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: FOG, paddingBottom: '56px', fontFamily: UI, color: INK }}>
      {children}
    </div>
  )
}

export function ContentWrap({ children }: { children: ReactNode }) {
  return <div style={{ maxWidth: '1440px', margin: '0 auto', padding: '28px 40px 0' }}>{children}</div>
}

/** Тёмная шапка в стиле экрана продаж (логотип-марка + надзаголовок + заголовок). */
export function MarketingHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header style={{ background: INK, color: '#fff', padding: '20px 40px', display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap', boxShadow: '0 2px 20px rgba(12,33,54,0.25)' }}>
      <div style={{ width: '46px', height: '46px', borderRadius: '12px', background: ACCENT, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3px', flexShrink: 0 }}>
        <span style={{ display: 'block', width: '22px', height: '3px', borderRadius: '2px', background: FOG }} />
        <span style={{ display: 'block', width: '15px', height: '3px', borderRadius: '2px', background: STEEL }} />
        <span style={{ display: 'block', width: '8px', height: '3px', borderRadius: '2px', background: STEEL }} />
      </div>
      <div style={{ flex: 1, minWidth: '240px' }}>
        <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: STEEL, fontWeight: 600 }}>Demi Results OS · Отдел маркетинга</div>
        <div style={{ fontSize: '21px', fontWeight: 700, letterSpacing: '-0.01em', marginTop: '2px' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12.5px', color: STEEL, marginTop: '4px' }}>{subtitle}</div>}
      </div>
      <SkeletonBadge />
    </header>
  )
}

/** Метка-напоминание, что это каркас без данных. */
export function SkeletonBadge() {
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, padding: '5px 11px', borderRadius: '999px', background: 'rgba(162,180,192,0.16)', color: STEEL, border: '1px solid rgba(162,180,192,0.28)', whiteSpace: 'nowrap' }}>
      каркас · данные на этапе логики
    </span>
  )
}

// ─── Табы навигации между экранами отдела ─────────────────────────────────────

export interface TabDef { key: string; label: string }

export function Tabs({ tabs, active, onChange }: { tabs: TabDef[]; active: string; onChange: (key: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '14px 40px 0' }}>
      {tabs.map(t => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              background: on ? '#fff' : 'transparent',
              border: `1px solid ${on ? 'rgba(12,33,54,0.10)' : 'transparent'}`,
              borderBottom: on ? '1px solid #fff' : '1px solid transparent',
              color: on ? INK : MUTE,
              borderRadius: '11px 11px 0 0',
              padding: '10px 18px',
              fontSize: '13.5px',
              fontWeight: on ? 700 : 600,
              cursor: 'pointer',
              fontFamily: UI,
              boxShadow: on ? '0 -2px 10px rgba(12,33,54,0.05)' : 'none',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Секция-карточка ──────────────────────────────────────────────────────────

export function SectionCard({ title, subtitle, chip, children, style }: {
  title: string
  subtitle?: string
  chip?: string
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <section style={{ ...cardStyle, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: INK }}>{title}</h2>
        {chip && <span style={{ fontSize: '11px', fontWeight: 600, color: ACCENT, background: '#e2eef4', padding: '4px 10px', borderRadius: '999px' }}>{chip}</span>}
      </div>
      {subtitle && <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: MUTE }}>{subtitle}</p>}
      <div style={{ marginTop: '18px' }}>{children}</div>
    </section>
  )
}

// ─── Плитка-показатель (значение прочерком) ───────────────────────────────────

export function StatTile({ label, unit, hint, big, value }: { label: string; unit?: string; hint?: string; big?: boolean; value?: string | null }) {
  const has = value !== undefined && value !== null && value !== ''
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '15px 16px', background: '#fff' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: FAINT }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: big ? '28px' : '22px', fontWeight: 600, color: has ? INK : FAINT, marginTop: '6px', lineHeight: 1 }}>
        {has ? value : DASH}{unit && <span style={{ fontSize: '13px', color: STEEL, marginLeft: '6px' }}>{unit}</span>}
      </div>
      {hint && <div style={{ fontSize: '11px', color: FAINT, marginTop: '6px' }}>{hint}</div>}
    </div>
  )
}

export function TileGrid({ min = 180, children }: { min?: number; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '14px' }}>{children}</div>
}

// ─── Светофор «Прогноз выполнения» (нейтральные плашки-заглушки) ───────────────

export function ForecastStub({ metrics }: { metrics: string[] }) {
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      {metrics.map(m => (
        <div key={m} style={{ background: '#f4f7f9', borderRadius: '12px', padding: '14px 16px', display: 'grid', gridTemplateColumns: '14px 1fr auto', gap: '12px', alignItems: 'center' }}>
          <span style={{ width: '14px', height: '14px', borderRadius: '50%', background: '#d3dde3', border: '2px solid #c4d0d8' }} />
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 700, color: INK }}>{m}</div>
            <div style={{ fontSize: '11.5px', color: FAINT, marginTop: '2px', fontFamily: MONO }}>сейчас {DASH} из {DASH}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: MONO, fontSize: '22px', fontWeight: 700, color: FAINT, lineHeight: 1 }}>{DASH}</div>
            <div style={{ fontSize: '10px', color: FAINT, marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>прогноз</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Таблица-каркас (заголовки заданы, тело — прочерки) ────────────────────────

export function SkeletonTable({ columns, rowLabels, rows = 6, firstColLabel }: {
  columns: string[]
  /** подписи первого столбца (каналы/партнёры и т.п.); если заданы — они и есть строки */
  rowLabels?: string[]
  /** число пустых строк, если rowLabels не заданы */
  rows?: number
  firstColLabel: string
}) {
  const body = rowLabels ?? Array.from({ length: rows }, () => '')
  return (
    <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: `${160 + columns.length * 120}px`, fontSize: '12px', fontFamily: MONO }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, zIndex: 2, background: INK, color: '#fff', textAlign: 'left', padding: '9px 12px', fontFamily: UI, fontSize: '11px', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{firstColLabel}</th>
            {columns.map(c => (
              <th key={c} style={{ background: INK, color: '#fff', padding: '9px 12px', fontFamily: UI, fontSize: '11px', textAlign: 'right', borderLeft: '2px solid #24425c', whiteSpace: 'nowrap' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((label, i) => (
            <tr key={i}>
              <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fff', padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: UI, fontWeight: 600, color: label ? INK : FAINT, whiteSpace: 'nowrap' }}>
                {label || DASH}
              </td>
              {columns.map(c => (
                <td key={c} style={{ padding: '9px 12px', textAlign: 'right', color: FAINT, borderBottom: `1px solid ${LINE}` }}>{DASH}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Поля ввода-каркаса (задизейблены: подключим на этапе логики) ──────────────

const fieldWrap: CSSProperties = { display: 'block' }
const fieldLabel: CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const fieldBox: CSSProperties = {
  width: '100%', padding: '10px 13px', border: '1px solid #d3dde3', borderRadius: '10px',
  fontSize: '14px', fontFamily: UI, background: '#f3f6f7', color: MUTE, boxSizing: 'border-box',
}

export function FieldGrid({ min = 200, children }: { min?: number; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '14px' }}>{children}</div>
}

export function InputField({ label, placeholder, type = 'text' }: { label: string; placeholder?: string; type?: string }) {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <input type={type} disabled placeholder={placeholder ?? DASH} style={fieldBox} />
    </label>
  )
}

export function SelectField({ label, options }: { label: string; options: string[] }) {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <select disabled style={{ ...fieldBox, appearance: 'none' }}>
        <option>{options.join(' · ')}</option>
      </select>
    </label>
  )
}

export function CheckboxField({ label }: { label: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', fontWeight: 600, color: MUTE, cursor: 'default' }}>
      <input type="checkbox" disabled style={{ width: '16px', height: '16px' }} />
      {label}
    </label>
  )
}

// ─── Скелет-лоадер (чтобы загрузка не выглядела «зависшей») ────────────────────
export function LoadingBlocks({ heights = [110, 260, 320] }: { heights?: number[] }) {
  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      {heights.map((h, i) => (
        <div key={i} className="animate-pulse" style={{ height: h, background: '#dde4e9', borderRadius: '16px' }} />
      ))}
    </div>
  )
}

// ─── Живые (редактируемые) примитивы формы — для вкладок с логикой ────────────

export const editInputStyle: CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #d3dde3', borderRadius: '10px',
  fontSize: '14px', fontFamily: UI, background: '#fff', color: INK, boxSizing: 'border-box',
}
export const editLabelStyle: CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }

export function EField({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: 'block' }}><span style={editLabelStyle}>{label}</span>{children}</label>
}

export function PrimaryBtn({ children, onClick, disabled, tone = 'accent' }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'accent' | 'ink' }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background: disabled ? '#5c6f7c' : (tone === 'ink' ? INK : ACCENT), color: '#fff', border: 'none', borderRadius: '10px', padding: '11px 20px', fontSize: '14px', fontWeight: 600, cursor: disabled ? 'default' : 'pointer', fontFamily: UI }}>
      {children}
    </button>
  )
}

/** Кнопка-заглушка (без действия). */
export function GhostButton({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', background: '#eef2f4', color: FAINT, border: '1px solid #dbe3e8', borderRadius: '10px', padding: '10px 18px', fontSize: '13.5px', fontWeight: 600, fontFamily: UI, cursor: 'not-allowed' }}>
      {children}
    </span>
  )
}
