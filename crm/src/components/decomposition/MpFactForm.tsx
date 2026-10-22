'use client'

// ─── Ручная правка факта менеджера продаж — ТОЛЬКО для владельца ───────────────
//
// По решению владельца менеджер продаж ничего не вводит: его факт целиком
// тянется из модуля «Записи» (единственный источник правды). Эта форма —
// страховка на случай криво оформленной записи: владелец (или руководитель)
// на экране сотрудника может перекрыть авто-факт за конкретный день.
//
// Рендерится только при viewerRole === 'owner' (гейт в MpDecomposition) —
// сам МП её не видит. Серверный экшен дополнительно проверяет роль.
//
// Правит только ФВ/Продажи/Выручку. Пустое поле = «правки нет» (NULL): факт
// считается автоматически. Ноль и пусто — разные вещи, поэтому поля не
// преднаполняются нулями.

import { useState } from 'react'
import { toast } from 'sonner'
import { saveMpDailyFact, type MpOverrideRow } from '@/actions/mp-decomposition'

const MONO = "'IBM Plex Mono', monospace"

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #d3dde3',
  borderRadius: '10px',
  padding: '10px 12px',
  fontSize: '15px',
  fontFamily: MONO,
  fontWeight: 500,
  color: '#0c2136',
  background: '#fff',
  width: '100%',
  boxSizing: 'border-box',
}

/** Пустая строка → null (нет правки); иначе число */
function parseField(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const numToStr = (v: number | null | undefined): string =>
  v === null || v === undefined ? '' : String(v)

export function MpFactForm({
  employeeId,
  employeeName,
  planStart,
  planEnd,
  overridesByDate,
  onSaved,
}: {
  employeeId: string
  employeeName: string
  planStart: string
  planEnd: string
  overridesByDate: Record<string, MpOverrideRow>
  onSaved: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const initialDate = today >= planStart && today <= planEnd ? today : planEnd
  const [date, setDate] = useState(initialDate)

  // Поля вынесены в дочерний компонент с key={date}: при смене даты он
  // пересоздаётся и инициализируется уже сохранёнными значениями за эту дату.
  // Синхронизировать через useEffect + setState нельзя — это каскадные рендеры
  // (и запрещено линтом).
  return (
    <MpFactFormInner
      key={date}
      date={date}
      onDateChange={setDate}
      employeeId={employeeId}
      employeeName={employeeName}
      planStart={planStart}
      planEnd={planEnd}
      saved={overridesByDate[date]}
      onSaved={onSaved}
    />
  )
}

function MpFactFormInner({
  date, onDateChange, employeeId, employeeName, planStart, planEnd, saved, onSaved,
}: {
  date: string
  onDateChange: (d: string) => void
  employeeId: string
  employeeName: string
  planStart: string
  planEnd: string
  saved: MpOverrideRow | undefined
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)

  const [fv,      setFv]      = useState(numToStr(saved?.fv_fact))
  const [sales,   setSales]   = useState(numToStr(saved?.sales_fact))
  const [revenue, setRevenue] = useState(numToStr(saved?.revenue_fact))

  const setDate = onDateChange

  const handleSave = async () => {
    setSaving(true)
    const res = await saveMpDailyFact(employeeId, date, {
      fv:      parseField(fv),
      sales:   parseField(sales),
      revenue: parseField(revenue),
    })
    setSaving(false)
    if (res.success) {
      toast.success('Факт сохранён')
      onSaved()
    } else {
      toast.error(res.error)
    }
  }

  const hasOverride = [fv, sales, revenue].some(v => v.trim() !== '')

  return (
    <section style={{ ...cardStyle, marginTop: '24px', borderLeft: '4px solid #0c4d6c' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Ручная правка факта</h2>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '3px 9px', borderRadius: '999px' }}>
          только владелец
        </span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: '12.5px', color: '#6b7d8a' }}>
        Факт менеджера «{employeeName}» считается из «Записей». Заполняйте, только если запись
        оформлена неверно — значение перекроет авто-подсчёт за этот день. Пустое поле — правки нет.
      </p>

      {/* Дата */}
      <label style={{ display: 'inline-flex', flexDirection: 'column', gap: '6px', marginBottom: '18px' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>Дата</span>
        <input
          type="date"
          value={date}
          min={planStart}
          max={planEnd}
          onChange={e => setDate(e.target.value)}
          style={{ ...inputStyle, width: 'auto', fontFamily: 'inherit', fontSize: '14px' }}
        />
      </label>

      <div style={{
        background: hasOverride ? '#fdf3e6' : '#f4f7f9',
        borderRadius: '12px',
        padding: '16px 18px',
        border: hasOverride ? '1px solid #e8c99a' : '1px solid transparent',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
          {([
            ['ФВ (пришли)',  fv,      setFv],
            ['Продажи',      sales,   setSales],
            ['Выручка, сом', revenue, setRevenue],
          ] as const).map(([label, value, set]) => (
            <label key={label} style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>{label}</span>
              <input type="number" min={0} value={value} placeholder="авто"
                onChange={e => set(e.target.value)} style={inputStyle} />
            </label>
          ))}
        </div>
        {hasOverride && (
          <p style={{ margin: '12px 0 0', fontSize: '12px', color: '#8a5a20', fontWeight: 600 }}>
            ⚠ За этот день факт будет взят из формы, а не из записей
          </p>
        )}
      </div>

      <div style={{ marginTop: '18px' }}>
        <button
          onClick={handleSave}
          disabled={saving || !date}
          style={{
            background: saving ? '#5c6f7c' : '#0c4d6c',
            color: '#fff', border: 'none', borderRadius: '10px',
            padding: '12px 24px', fontSize: '14px', fontWeight: 600,
            cursor: saving ? 'default' : 'pointer', fontFamily: 'inherit',
          }}
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </section>
  )
}
