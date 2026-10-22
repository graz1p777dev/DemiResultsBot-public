'use client'

// Вкладка «Долги» — обязательства бизнеса (поставщикам/бизнеса). Активные + ближайшие
// возвраты (по due_date, просроченные красным) + итого должен + история погашенных.
// Долг ≠ расход: сумма НЕ идёт в P&L (см. миграцию 070). Только кассовое обязательство.

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getDebtsTabData, saveDebt, deleteDebt, markDebtPaid,
  type DebtsTabData, type Debt, type DebtType,
} from '@/actions/finance-debts'
import type { Currency } from '@/actions/finance-expenses'

const INK = '#0c2136', ACCENT = '#0c4d6c', RED = '#c0392b', AMBER = '#b5732f', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const box: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' }
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

function dueLabel(days: number | null): { text: string; color: string } {
  if (days === null) return { text: '—', color: FAINT }
  if (days < 0) return { text: `просрочен на ${Math.abs(days)} дн.`, color: RED }
  if (days === 0) return { text: 'сегодня', color: RED }
  if (days <= 7) return { text: `через ${days} дн.`, color: AMBER }
  return { text: `через ${days} дн.`, color: MUTE }
}
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

type FormState = { id: string | null; debt_type: DebtType; creditor: string; amount: string; currency: Currency; rate: string; purchase: string; due: string; note: string }
const emptyForm = (): FormState => ({ id: null, debt_type: 'supplier', creditor: '', amount: '', currency: 'KGS', rate: '', purchase: '', due: '', note: '' })

export default function DebtsTab() {
  const [data, setData] = useState<DebtsTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [showPaid, setShowPaid] = useState(false)
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getDebtsTabData().then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [reloadKey])

  const save = () => {
    if (!form.creditor.trim()) { toast.error('Укажите кредитора'); return }
    if (!(Number(form.amount) > 0)) { toast.error('Сумма больше 0'); return }
    if (form.currency === 'USD' && !(Number(form.rate) > 0)) { toast.error('Укажите курс для $'); return }
    if (!form.purchase || !form.due) { toast.error('Укажите даты займа и возврата'); return }
    startSaving(async () => {
      const res = await saveDebt(form.id, {
        debt_type: form.debt_type, creditor_name: form.creditor, amount_original: Number(form.amount),
        currency: form.currency, rate: form.currency === 'USD' ? Number(form.rate) : 1,
        purchase_date: form.purchase, due_date: form.due, note: form.note || null,
      })
      if (res.success) { toast.success(form.id ? 'Долг обновлён' : 'Долг добавлен'); setForm(emptyForm()); reload() } else toast.error(res.error)
    })
  }
  const edit = (d: Debt) => setForm({ id: d.id, debt_type: d.debt_type, creditor: d.creditor_name, amount: String(d.amount_original), currency: d.currency, rate: d.currency === 'USD' ? String(d.rate) : '', purchase: d.purchase_date, due: d.due_date, note: d.note ?? '' })
  const pay = (d: Debt) => { if (!confirm(`Отметить долг «${d.creditor_name}» погашенным?`)) return; startSaving(async () => {
    const res = await markDebtPaid(d.id); if (res.success) { toast.success('Погашено'); reload() } else toast.error(res.error)
  }) }
  const remove = (d: Debt) => { if (!confirm('Удалить долг?')) return; startSaving(async () => {
    const res = await deleteDebt(d.id); if (res.success) { toast.success('Удалён'); if (form.id === d.id) setForm(emptyForm()); reload() } else toast.error(res.error)
  }) }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[90, 200, 260].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
    </div>
  )
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
    </div>
  )

  const th: React.CSSProperties = { background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', whiteSpace: 'nowrap' }

  // Сводка «Кому должен»: группируем активные долги по кредитору (без изменения логики расчётов)
  const byCreditor = Array.from(
    data.active.reduce((map, d) => {
      const cur = map.get(d.creditor_name) ?? { sum: 0, count: 0, nearest: d.due_date }
      cur.sum += d.amount_som
      cur.count += 1
      if (d.due_date < cur.nearest) cur.nearest = d.due_date
      map.set(d.creditor_name, cur)
      return map
    }, new Map<string, { sum: number; count: number; nearest: string }>()),
  ).sort((a, b) => b[1].sum - a[1].sum)

  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>

      {/* Итого должен */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Всего должен (активные)</div>
          <div style={{ fontFamily: MONO, fontSize: '30px', fontWeight: 700, color: RED }}>{fmt(data.totalActiveSom)} <span style={{ fontSize: '14px', color: STEEL }}>сом</span></div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: '12.5px', color: MUTE, fontFamily: MONO }}>
          <div>поставщикам: <b style={{ color: INK }}>{fmt(data.supplierSom)}</b></div>
          <div style={{ marginTop: '4px' }}>бизнеса: <b style={{ color: INK }}>{fmt(data.businessSom)}</b></div>
        </div>
      </div>

      {/* Кому должен — сводка по кредиторам (кто и сколько всего) */}
      {byCreditor.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Кому должен</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Сводка по кредиторам: сколько всего должны каждому (сроки — ниже)</p>
          <div style={{ display: 'grid', gap: '6px' }}>
            {byCreditor.map(([name, v]) => (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f8fafb', border: `1px solid ${LINE}` }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>
                  {name}
                  {v.count > 1 && <span style={{ fontSize: '11px', color: FAINT, fontWeight: 500 }}> · {v.count} долга</span>}
                </div>
                <div style={{ fontSize: '11.5px', color: FAINT, fontFamily: MONO, whiteSpace: 'nowrap' }}>ближайший {ru(v.nearest)}</div>
                <div style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: RED, whiteSpace: 'nowrap' }}>{fmt(v.sum)} <span style={{ fontSize: '11px', color: STEEL }}>сом</span></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Форма */}
      {data.canManage && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>{form.id ? 'Редактирование долга' : 'Новый долг'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
            <label><span style={lbl}>Тип</span>
              <select value={form.debt_type} onChange={e => setForm(f => ({ ...f, debt_type: e.target.value as DebtType }))} style={box}>
                <option value="supplier">Поставщику (товар в долг)</option>
                <option value="business">Долг бизнеса</option>
              </select>
            </label>
            <label><span style={lbl}>Кому (кредитор)</span><input value={form.creditor} onChange={e => setForm(f => ({ ...f, creditor: e.target.value }))} placeholder="поставщик / кредитор" style={box} /></label>
            <label><span style={lbl}>Сумма</span><input type="number" min={0} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
            <label><span style={lbl}>Валюта</span>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
                <option value="KGS">сом (KGS)</option><option value="USD">$ (USD)</option>
              </select>
            </label>
            {form.currency === 'USD' && <label><span style={lbl}>Курс (сом за $1)</span><input type="number" min={0} value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="напр. 89" style={{ ...box, fontFamily: MONO }} /></label>}
            <label><span style={lbl}>Дата займа</span><input type="date" value={form.purchase} onChange={e => setForm(f => ({ ...f, purchase: e.target.value }))} style={box} /></label>
            <label><span style={lbl}>Дата возврата</span><input type="date" value={form.due} onChange={e => setForm(f => ({ ...f, due: e.target.value }))} style={box} /></label>
            <label><span style={lbl}>Комментарий</span><input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="необязательно" style={box} /></label>
          </div>
          <div style={{ marginTop: '14px', display: 'flex', gap: '10px' }}>
            <button onClick={save} disabled={saving} style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>{form.id ? 'Сохранить' : '＋ Добавить'}</button>
            {form.id && <button onClick={() => setForm(emptyForm())} style={{ border: `1px solid ${LINE}`, background: '#fff', color: MUTE, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', cursor: 'pointer' }}>Отмена</button>}
          </div>
        </div>
      )}

      {/* Ближайшие возвраты / активные */}
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Ближайшие возвраты</div>
        <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Активные долги по срокам (ближайшие и просроченные — сверху)</p>
        {data.active.length === 0 ? (
          <div style={{ fontSize: '12.5px', color: FAINT }}>Активных долгов нет</div>
        ) : (
          <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '820px', fontSize: '12px', fontFamily: MONO }}>
              <thead><tr>
                {['Кому', 'Тип', 'Сумма', 'Возврат', 'Осталось', ''].map((h, i) => (
                  <th key={h || i} style={{ ...th, textAlign: i >= 2 && i <= 4 ? 'right' : 'left', borderLeft: i === 0 ? undefined : '2px solid #24425c' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {data.active.map(d => {
                  const dl = dueLabel(d.daysLeft)
                  const overdue = (d.daysLeft ?? 0) < 0
                  return (
                    <tr key={d.id} style={{ background: overdue ? '#fdf1f0' : undefined }}>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>{d.creditor_name}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", color: MUTE }}>{d.debt_type === 'supplier' ? 'Поставщик' : 'Бизнес'}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, fontWeight: 700, color: INK }}>{fmt(d.amount_som)}{d.currency === 'USD' && <span style={{ color: FAINT, fontWeight: 400, fontSize: '11px' }}> (${fmt(d.amount_original)}×{fmt1(d.rate)})</span>}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: MUTE, fontFamily: "'Golos Text', sans-serif", whiteSpace: 'nowrap' }}>{ru(d.due_date)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: dl.color, fontWeight: overdue ? 700 : 500, fontFamily: "'Golos Text', sans-serif", whiteSpace: 'nowrap' }}>{dl.text}</td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', textAlign: 'right', fontFamily: "'Golos Text', sans-serif" }}>
                        {data.canManage && <>
                          <button onClick={() => pay(d)} style={{ background: 'transparent', border: 'none', color: '#1b7a4b', fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '8px' }}>Погашено</button>
                          <button onClick={() => edit(d)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '8px' }}>изм.</button>
                          <button onClick={() => remove(d)} style={{ background: 'transparent', border: 'none', color: RED, fontWeight: 600, cursor: 'pointer', fontSize: '12px' }}>уд.</button>
                        </>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* История погашенных */}
      {data.paid.length > 0 && (
        <div style={card}>
          <button onClick={() => setShowPaid(s => !s)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '15px', fontWeight: 700, color: INK, padding: 0 }}>
            Погашенные ({data.paid.length}) {showPaid ? '▲' : '▼'}
          </button>
          {showPaid && (
            <div style={{ marginTop: '12px', display: 'grid', gap: '6px' }}>
              {data.paid.map(d => (
                <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f4f7f9', border: `1px solid ${LINE}`, opacity: 0.8 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{d.creditor_name} <span style={{ color: FAINT, fontWeight: 400, fontSize: '11.5px' }}>· {d.debt_type === 'supplier' ? 'поставщик' : 'бизнес'}</span></div>
                  <div style={{ fontFamily: MONO, fontSize: '13px', color: MUTE }}>{fmt(d.amount_som)} сом</div>
                  <div style={{ fontSize: '11.5px', color: FAINT, fontFamily: MONO }}>погашен {d.paid_date ? ru(d.paid_date) : '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
