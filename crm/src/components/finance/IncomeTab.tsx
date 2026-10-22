'use client'

// Вкладка «Доходы» — выручка от продаж (из consultations, тот же isSold, что в декомпозиции)
// с разбивкой по каналам и по типу (по записи/без записи), + ручные прочие доходы. Итого доход.

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getIncomeTabData, saveOtherIncome, deleteOtherIncome,
  type IncomeTabData, type OtherIncomeRow,
} from '@/actions/finance-income'
import { CHANNEL_LABEL } from '@/lib/finance-labels'
import type { Currency } from '@/actions/finance-expenses'

const INK = '#0c2136', ACCENT = '#0c4d6c', GREEN = '#1b7a4b', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const pct = (n: number | null) => n === null ? '—' : `${fmt1(n)}%`
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const box: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' }
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

type FormState = { id: string | null; name: string; amount: string; currency: Currency; rate: string; date: string }
const emptyForm = (): FormState => ({ id: null, name: '', amount: '', currency: 'KGS', rate: '', date: '' })

function Bar({ label, value, share }: { label: string; value: number; share: number | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 150px', gap: '12px', alignItems: 'center' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{label}</div>
      <div style={{ height: '10px', borderRadius: '6px', background: '#eef2f4', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, share ?? 0)}%`, background: value > 0 ? GREEN : 'transparent', borderRadius: '6px' }} />
      </div>
      <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: '13px' }}>
        <span style={{ fontWeight: 700, color: INK }}>{pct(share)}</span>
        <span style={{ color: FAINT, marginLeft: '8px' }}>{fmt(value)}</span>
      </div>
    </div>
  )
}

export default function IncomeTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const [data, setData] = useState<IncomeTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getIncomeTabData(periodMonth).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [periodMonth, reloadKey])

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  const save = () => {
    if (!form.name.trim()) { toast.error('Укажите название'); return }
    if (!(Number(form.amount) > 0)) { toast.error('Сумма больше 0'); return }
    if (form.currency === 'USD' && !(Number(form.rate) > 0)) { toast.error('Укажите курс для $'); return }
    startSaving(async () => {
      const res = await saveOtherIncome(form.id, {
        name: form.name, amount_original: Number(form.amount), currency: form.currency,
        rate: form.currency === 'USD' ? Number(form.rate) : 1, income_date: form.date || periodMonth, period_month: periodMonth,
      })
      if (res.success) { toast.success(form.id ? 'Доход обновлён' : 'Доход добавлен'); setForm(emptyForm()); reload() } else toast.error(res.error)
    })
  }
  const edit = (o: OtherIncomeRow) => setForm({ id: o.id, name: o.name, amount: String(o.amount_original), currency: o.currency, rate: o.currency === 'USD' ? String(o.rate) : '', date: o.income_date })
  const remove = (o: OtherIncomeRow) => { if (!confirm('Удалить доход?')) return; startSaving(async () => {
    const res = await deleteOtherIncome(o.id); if (res.success) { toast.success('Удалён'); if (form.id === o.id) setForm(emptyForm()); reload() } else toast.error(res.error)
  }) }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[90, 220, 200].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
    </div>
  )
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
    </div>
  )

  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>
      {/* Месяц + итого доход */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ ...box, width: 'auto', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ ...box, width: 'auto', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Итого доход за месяц</div>
          <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 700, color: GREEN }}>{fmt(data.totalIncome)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
        </div>
      </div>

      {/* Выручка от продаж */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700 }}>Выручка от продаж</div>
            <p style={{ fontSize: '12.5px', color: MUTE, margin: '4px 0 0' }}>Из консультаций (проданные: «Купила»/«Предоплата») — тот же расчёт, что в декомпозиции</p>
          </div>
          <div style={{ fontFamily: MONO, fontSize: '22px', fontWeight: 700, color: INK }}>{fmt(data.revenue)} <span style={{ fontSize: '12px', color: STEEL }}>сом</span></div>
        </div>

        <div style={{ marginTop: '16px', fontSize: '12px', fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: '0.05em' }}>По каналам</div>
        <div style={{ display: 'grid', gap: '9px', marginTop: '10px' }}>
          {data.byChannel.map(c => <Bar key={c.channel} label={CHANNEL_LABEL[c.channel]} value={c.revenue} share={c.sharePct} />)}
        </div>

        <div style={{ marginTop: '18px', fontSize: '12px', fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: '0.05em' }}>По типу</div>
        <div style={{ display: 'grid', gap: '9px', marginTop: '10px' }}>
          <Bar label="По записи" value={data.byType.booked} share={data.byType.bookedPct} />
          <Bar label="Без записи (walk-in)" value={data.byType.walkin} share={data.byType.walkinPct} />
        </div>
      </div>

      {/* Прочие доходы */}
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Прочие доходы</div>
        <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Разовые поступления не от продаж (возвраты, прочее)</p>

        {data.canManage && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', alignItems: 'end' }}>
            <label><span style={lbl}>Название</span><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="источник дохода" style={box} /></label>
            <label><span style={lbl}>Сумма</span><input type="number" min={0} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
            <label><span style={lbl}>Валюта</span>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
                <option value="KGS">сом (KGS)</option><option value="USD">$ (USD)</option>
              </select>
            </label>
            {form.currency === 'USD' && <label><span style={lbl}>Курс (сом за $1)</span><input type="number" min={0} value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="напр. 89" style={{ ...box, fontFamily: MONO }} /></label>}
            <label><span style={lbl}>Дата</span><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={box} /></label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={save} disabled={saving} style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 18px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>{form.id ? 'Сохранить' : '＋ Добавить'}</button>
              {form.id && <button onClick={() => setForm(emptyForm())} style={{ border: `1px solid ${LINE}`, background: '#fff', color: MUTE, borderRadius: '10px', padding: '10px 12px', fontSize: '13px', cursor: 'pointer' }}>✕</button>}
            </div>
          </div>
        )}

        <div style={{ marginTop: '14px', display: 'grid', gap: '6px' }}>
          {data.other.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: FAINT }}>Прочих доходов за месяц нет</div>
          ) : data.other.map(o => (
            <div key={o.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f9fafb', border: `1px solid ${LINE}` }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{o.name}</div>
                <div style={{ fontSize: '11.5px', color: FAINT, fontFamily: MONO }}>{o.income_date.slice(8, 10)}.{o.income_date.slice(5, 7)}{o.currency === 'USD' && ` · $${fmt(o.amount_original)} × ${fmt1(o.rate)}`}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>{fmt(o.amount_som)} <span style={{ fontSize: '11px', color: STEEL }}>сом</span></div>
              <div style={{ whiteSpace: 'nowrap' }}>
                {data.canManage && <>
                  <button onClick={() => edit(o)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '8px' }}>изм.</button>
                  <button onClick={() => remove(o)} style={{ background: 'transparent', border: 'none', color: '#c0392b', fontWeight: 600, cursor: 'pointer', fontSize: '12px' }}>уд.</button>
                </>}
              </div>
            </div>
          ))}
        </div>
        {data.otherSom > 0 && <div style={{ marginTop: '10px', textAlign: 'right', fontFamily: MONO, fontSize: '13px', color: MUTE }}>Прочие итого: <b style={{ color: INK }}>{fmt(data.otherSom)}</b> сом</div>}
      </div>
    </div>
  )
}
