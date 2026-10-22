'use client'

// Вкладка «Движение денег» (ДДС / Cash Flow, шаг 7 финал). Реальные деньги по счетам +
// предупреждение о кассовом разрыве. Остаток счёта = Σin−Σout (сом). Предстоящие выплаты
// (долги + возврат тела инвесторам + начисления) — из шагов 3/4, без дублирования.

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getCashFlowData, saveCashMovement, deleteCashMovement, saveCashAccount, deleteCashAccount,
  type CashFlowData, type CashAccount, type Direction, type CashCategory, type AccountType,
} from '@/actions/finance-cashflow'
import type { Currency } from '@/actions/finance-expenses'
import { CASH_CATEGORY_LABEL, ACCOUNT_TYPE_LABEL } from '@/lib/finance-labels'

const INK = '#0c2136', ACCENT = '#0c4d6c', GREEN = '#1b7a4b', RED = '#c0392b', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const box: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' }
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

type MovForm = { id: string | null; account_id: string; direction: Direction; amount: string; currency: Currency; rate: string; date: string; category: CashCategory; note: string }
const emptyMov = (accId: string): MovForm => ({ id: null, account_id: accId, direction: 'in', amount: '', currency: 'KGS', rate: '', date: '', category: 'revenue', note: '' })
type AccForm = { name: string; account_type: AccountType; currency: Currency }
const emptyAcc = (): AccForm => ({ name: '', account_type: 'bank', currency: 'KGS' })

export default function CashFlowTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const [data, setData] = useState<CashFlowData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<MovForm>(emptyMov(''))
  const [accForm, setAccForm] = useState<AccForm>(emptyAcc)
  const [showAccMgr, setShowAccMgr] = useState(false)
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getCashFlowData(periodMonth).then(d => {
      if (cancelled) return
      setData(d); setLoading(false)
      if (d && !form.account_id && d.accounts[0]) setForm(f => ({ ...f, account_id: d.accounts[0].id }))
    })
    return () => { cancelled = true }
  }, [periodMonth, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  const saveMov = () => {
    if (!form.account_id) { toast.error('Выберите счёт'); return }
    if (!(Number(form.amount) > 0)) { toast.error('Сумма больше 0'); return }
    if (form.currency === 'USD' && !(Number(form.rate) > 0)) { toast.error('Укажите курс для $'); return }
    if (!form.date) { toast.error('Укажите дату'); return }
    startSaving(async () => {
      const res = await saveCashMovement(form.id, {
        account_id: form.account_id, direction: form.direction, amount_original: Number(form.amount),
        currency: form.currency, rate: form.currency === 'USD' ? Number(form.rate) : 1,
        movement_date: form.date, category: form.category, note: form.note,
      })
      if (res.success) { toast.success(form.id ? 'Движение обновлено' : 'Движение добавлено'); setForm(emptyMov(form.account_id)); reload() } else toast.error(res.error)
    })
  }
  const removeMov = (id: string) => { if (!confirm('Удалить движение?')) return; startSaving(async () => {
    const res = await deleteCashMovement(id); if (res.success) { toast.success('Удалено'); reload() } else toast.error(res.error)
  }) }
  const addAcc = () => {
    if (!accForm.name.trim()) { toast.error('Название счёта'); return }
    startSaving(async () => {
      const res = await saveCashAccount(null, { name: accForm.name.trim(), account_type: accForm.account_type, currency: accForm.currency, status: 'active', sort_order: 100 })
      if (res.success) { toast.success('Счёт добавлен'); setAccForm(emptyAcc()); reload() } else toast.error(res.error)
    })
  }
  const removeAcc = (a: CashAccount) => { if (!confirm(`Удалить счёт «${a.name}»?`)) return; startSaving(async () => {
    const res = await deleteCashAccount(a.id); if (res.success) { toast.success('Счёт удалён'); reload() } else toast.error(res.error)
  }) }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[80, 120, 140, 260].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
    </div>
  )
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
    </div>
  )

  const g = data.gap
  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>

      {/* Месяц + общий остаток */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Общий остаток (все счета)</div>
          <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 700, color: data.totalBalanceSom >= 0 ? INK : RED }}>{fmt(data.totalBalanceSom)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
        </div>
      </div>

      {/* Счета */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px' }}>
        {data.accounts.filter(a => a.status === 'active').map(a => (
          <div key={a.id} style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '15px 17px', background: '#fff' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: INK }}>{a.name}</div>
            <div style={{ fontSize: '11px', color: FAINT, marginTop: '2px' }}>{ACCOUNT_TYPE_LABEL[a.account_type]} · {a.currency}</div>
            <div style={{ fontFamily: MONO, fontSize: '22px', fontWeight: 700, color: a.balanceSom >= 0 ? INK : RED, marginTop: '8px' }}>{fmt(a.balanceSom)} <span style={{ fontSize: '11px', color: STEEL }}>сом</span></div>
            {a.currency === 'USD' && <div style={{ fontFamily: MONO, fontSize: '12px', color: MUTE, marginTop: '2px' }}>${fmt(a.balanceOriginal)}</div>}
          </div>
        ))}
      </div>

      {/* Предупреждение о кассовом разрыве */}
      <div style={{ ...card, border: `1px solid ${g.hasGap ? '#f0c9c0' : '#bfe0cc'}`, background: g.hasGap ? '#fdf3ef' : '#eef7f1' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: g.hasGap ? RED : GREEN }}>
          {g.hasGap ? `⚠ Кассовый разрыв ${g.firstGapDate ? ru(g.firstGapDate) : ''}: не хватит ${fmt(g.firstShortfall)} сом` : '✓ Разрывов не предвидится'}
        </div>
        <p style={{ fontSize: '12px', color: MUTE, margin: '8px 0 0' }}>Прогноз: текущий остаток {fmt(data.totalBalanceSom)} сом минус предстоящие выплаты (долги, возврат тела инвесторам, начисления).</p>
        {g.timeline.length > 0 && (
          <div style={{ marginTop: '14px', display: 'grid', gap: '6px' }}>
            {g.timeline.map((t, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto auto', gap: '12px', alignItems: 'center', padding: '8px 12px', borderRadius: '9px', background: '#fff', border: `1px solid ${t.shortfall > 0 ? '#f0c9c0' : LINE}` }}>
                <span style={{ fontFamily: MONO, fontSize: '12px', color: FAINT }}>{ru(t.date)}</span>
                <span style={{ fontSize: '12.5px', color: INK }}>{t.label}</span>
                <span style={{ fontFamily: MONO, fontSize: '12.5px', color: RED, fontWeight: 700 }}>−{fmt(t.amountSom)}</span>
                <span style={{ fontFamily: MONO, fontSize: '12px', fontWeight: 700, color: t.balanceAfter < 0 ? RED : MUTE, textAlign: 'right', minWidth: '110px' }}>
                  {t.shortfall > 0 ? `не хватает ${fmt(t.shortfall)}` : `остаток ${fmt(t.balanceAfter)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Форма движения */}
      {data.canManage && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>{form.id ? 'Редактирование движения' : 'Новое движение'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
            <label><span style={lbl}>Счёт</span>
              <select value={form.account_id} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))} style={box}>
                {data.accounts.filter(a => a.status === 'active').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label><span style={lbl}>Направление</span>
              <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value as Direction }))} style={box}>
                <option value="in">Приход (+)</option><option value="out">Расход (−)</option>
              </select>
            </label>
            <label><span style={lbl}>Сумма</span><input type="number" min={0} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
            <label><span style={lbl}>Валюта</span>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
                <option value="KGS">сом (KGS)</option><option value="USD">$ (USD)</option>
              </select>
            </label>
            {form.currency === 'USD' && <label><span style={lbl}>Курс (сом за $1)</span><input type="number" min={0} value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="напр. 89" style={{ ...box, fontFamily: MONO }} /></label>}
            <label><span style={lbl}>Дата</span><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={box} /></label>
            <label><span style={lbl}>Категория</span>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as CashCategory }))} style={box}>
                {(Object.keys(CASH_CATEGORY_LABEL) as CashCategory[]).map(c => <option key={c} value={c}>{CASH_CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <label><span style={lbl}>Комментарий</span><input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="необязательно" style={box} /></label>
          </div>
          <div style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={saveMov} disabled={saving} style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>{form.id ? 'Сохранить' : '＋ Добавить'}</button>
            {form.id && <button onClick={() => setForm(emptyMov(form.account_id))} style={{ border: `1px solid ${LINE}`, background: '#fff', color: MUTE, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', cursor: 'pointer' }}>Отмена</button>}
            <button onClick={() => setShowAccMgr(s => !s)} style={{ marginLeft: 'auto', border: `1px solid ${LINE}`, background: '#fff', color: ACCENT, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Счета {showAccMgr ? '▲' : '▼'}</button>
          </div>

          {showAccMgr && (
            <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: `1px solid ${LINE}`, display: 'grid', gap: '10px' }}>
              {data.accounts.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
                  <span style={{ fontWeight: 600 }}>{a.name}</span>
                  <span style={{ fontSize: '11px', color: FAINT }}>{ACCOUNT_TYPE_LABEL[a.account_type]} · {a.currency}{a.is_system ? ' · системный' : ''}{a.status === 'closed' ? ' · закрыт' : ''}</span>
                  {!a.is_system && <button onClick={() => removeAcc(a)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: RED, cursor: 'pointer', fontSize: '12px' }}>уд.</button>}
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '4px' }}>
                <label style={{ flex: '1 1 160px' }}><span style={lbl}>Новый счёт</span><input value={accForm.name} onChange={e => setAccForm(f => ({ ...f, name: e.target.value }))} placeholder="название" style={box} /></label>
                <label style={{ flex: '0 0 130px' }}><span style={lbl}>Тип</span>
                  <select value={accForm.account_type} onChange={e => setAccForm(f => ({ ...f, account_type: e.target.value as AccountType }))} style={box}>
                    <option value="cash">Наличные</option><option value="bank">Банк</option><option value="other">Прочее</option>
                  </select>
                </label>
                <label style={{ flex: '0 0 120px' }}><span style={lbl}>Валюта</span>
                  <select value={accForm.currency} onChange={e => setAccForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
                    <option value="KGS">сом</option><option value="USD">$</option>
                  </select>
                </label>
                <button onClick={addAcc} disabled={saving} style={{ background: ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '9px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>＋ счёт</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Движения за месяц */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '15px', fontWeight: 700 }}>Движения за {MONTHS[month].toLowerCase()}</div>
          <span style={{ fontSize: '12.5px', color: GREEN, fontFamily: MONO }}>приход {fmt(data.inSom)}</span>
          <span style={{ fontSize: '12.5px', color: RED, fontFamily: MONO }}>расход {fmt(data.outSom)}</span>
          <span style={{ fontSize: '12.5px', color: INK, fontFamily: MONO, fontWeight: 700 }}>нетто {fmt(data.inSom - data.outSom)}</span>
        </div>
        {data.movements.length === 0 ? (
          <div style={{ fontSize: '12.5px', color: FAINT }}>Движений за месяц нет</div>
        ) : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {data.movements.map(m => (
              <div key={m.id} style={{ display: 'grid', gridTemplateColumns: '85px 1fr auto auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f8fafb', border: `1px solid ${LINE}` }}>
                <span style={{ fontFamily: MONO, fontSize: '12px', color: FAINT }}>{ru(m.movement_date)}</span>
                <span style={{ fontSize: '13px', color: INK }}>{m.account_name} <span style={{ color: FAINT, fontSize: '11.5px' }}>· {CASH_CATEGORY_LABEL[m.category]}{m.note ? ` · ${m.note}` : ''}</span></span>
                <span style={{ fontFamily: MONO, fontSize: '13.5px', fontWeight: 700, color: m.direction === 'in' ? GREEN : RED }}>{m.direction === 'in' ? '+' : '−'}{fmt(m.amount_som)}</span>
                <span style={{ fontFamily: MONO, fontSize: '11px', color: FAINT }}>{m.currency === 'USD' ? `$${fmt(m.amount_original)}×${fmt1(m.rate)}` : ''}</span>
                {data.canManage ? <button onClick={() => removeMov(m.id)} style={{ background: 'transparent', border: 'none', color: RED, cursor: 'pointer', fontSize: '11px' }}>уд.</button> : <span />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
