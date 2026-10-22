'use client'

// Вкладка «Инвесторы» — вложения, условия сделки, начисление за месяц, выплаты, возврат тела.
// Начисление считается на сервере из условий сделки (доля прибыли / фикс % / роялти); прибыль
// и выручка переиспользуются из Доходов/Расходов/Маркетинга (см. finance-investors.ts).
// Тело инвестиции — обязательство к возврату (как долг), уменьшается выплатами 'principal_return'.
// Задел: реальные выплаты → ДДС и «Распределение прибыли» (будущие шаги).

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getInvestorsTabData, saveInvestor, deleteInvestor, saveInvestorPayout, deleteInvestorPayout, saveInvestorDealType,
  type InvestorsTabData, type InvestorCard, type InvestorStatus, type PayoutType, type RatePeriod,
} from '@/actions/finance-investors'
import type { Currency } from '@/actions/finance-expenses'
import { PAYOUT_TYPE_LABEL, RATE_PERIOD_LABEL, DEAL_FIELDS_BY_NAME } from '@/lib/finance-labels'

const INK = '#0c2136', ACCENT = '#0c4d6c', GREEN = '#1b7a4b', RED = '#c0392b', AMBER = '#b5732f', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const box: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' }
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

function dueLabel(days: number | null): { text: string; color: string } {
  if (days === null) return { text: '—', color: FAINT }
  if (days < 0) return { text: `просрочен на ${Math.abs(days)} дн.`, color: RED }
  if (days === 0) return { text: 'сегодня', color: RED }
  if (days <= 14) return { text: `через ${days} дн.`, color: AMBER }
  return { text: `через ${days} дн.`, color: MUTE }
}

type FormState = {
  id: string | null; name: string; contact: string; status: InvestorStatus
  amount: string; currency: Currency; rate: string; deal_type_id: string
  profit: string; fixed: string; royalty: string; rate_period: RatePeriod
  start: string; term: string; principal_due: string; note: string
}
const emptyForm = (): FormState => ({
  id: null, name: '', contact: '', status: 'active', amount: '', currency: 'KGS', rate: '', deal_type_id: '',
  profit: '', fixed: '', royalty: '', rate_period: 'monthly', start: '', term: '', principal_due: '', note: '',
})

type PayoutForm = { amount: string; date: string; type: PayoutType; note: string }
const emptyPayout = (): PayoutForm => ({ amount: '', date: '', type: 'profit_share', note: '' })

function Tile({ label, value, color, hint }: { label: string; value: number; color?: string; hint?: string }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '14px 16px', background: '#fff' }}>
      <div style={{ fontSize: '11.5px', fontWeight: 600, color: FAINT }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: '23px', fontWeight: 700, color: color ?? INK, marginTop: '5px', lineHeight: 1 }}>{fmt(value)} <span style={{ fontSize: '12px', color: STEEL }}>сом</span></div>
      {hint && <div style={{ fontSize: '11px', color: FAINT, marginTop: '5px' }}>{hint}</div>}
    </div>
  )
}

export default function InvestorsTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`

  const [data, setData] = useState<InvestorsTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [newType, setNewType] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [payoutForm, setPayoutForm] = useState<PayoutForm>(emptyPayout)
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getInvestorsTabData(periodMonth).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [periodMonth, reloadKey])

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  const selType = data?.dealTypes.find(t => t.id === form.deal_type_id)
  const fields = selType ? (DEAL_FIELDS_BY_NAME[selType.name] ?? { profit: true, fixed: true, royalty: true }) : { profit: true, fixed: true, royalty: true }

  const save = () => {
    if (!form.name.trim()) { toast.error('Укажите имя инвестора'); return }
    if (!(Number(form.amount) > 0)) { toast.error('Сумма больше 0'); return }
    if (form.currency === 'USD' && !(Number(form.rate) > 0)) { toast.error('Укажите курс для $'); return }
    if (!form.deal_type_id) { toast.error('Выберите тип сделки'); return }
    startSaving(async () => {
      const res = await saveInvestor(form.id, {
        name: form.name, contact: form.contact, status: form.status,
        amount_original: Number(form.amount), currency: form.currency, rate: form.currency === 'USD' ? Number(form.rate) : 1,
        deal_type_id: form.deal_type_id,
        profit_share_pct: fields.profit && form.profit !== '' ? Number(form.profit) : null,
        fixed_rate_pct: fields.fixed && form.fixed !== '' ? Number(form.fixed) : null,
        royalty_pct: fields.royalty && form.royalty !== '' ? Number(form.royalty) : null,
        rate_period: fields.fixed ? form.rate_period : null,
        start_date: form.start, term_months: form.term !== '' ? Number(form.term) : null,
        principal_due_date: form.principal_due, note: form.note,
      })
      if (res.success) { toast.success(form.id ? 'Инвестор обновлён' : 'Инвестор добавлен'); setForm(emptyForm()); reload() } else toast.error(res.error)
    })
  }
  const edit = (i: InvestorCard) => setForm({
    id: i.id, name: i.name, contact: i.contact ?? '', status: i.status,
    amount: String(i.amount_original), currency: i.currency, rate: i.currency === 'USD' ? String(i.rate) : '',
    deal_type_id: i.deal_type_id, profit: i.profit_share_pct != null ? String(i.profit_share_pct) : '',
    fixed: i.fixed_rate_pct != null ? String(i.fixed_rate_pct) : '', royalty: i.royalty_pct != null ? String(i.royalty_pct) : '',
    rate_period: i.rate_period ?? 'monthly', start: i.start_date ?? '', term: i.term_months != null ? String(i.term_months) : '',
    principal_due: i.principal_due_date ?? '', note: i.note ?? '',
  })
  const remove = (i: InvestorCard) => { if (!confirm(`Удалить инвестора «${i.name}» и его выплаты?`)) return; startSaving(async () => {
    const res = await deleteInvestor(i.id); if (res.success) { toast.success('Удалён'); if (form.id === i.id) setForm(emptyForm()); reload() } else toast.error(res.error)
  }) }
  const addType = () => { if (!newType.trim()) return; startSaving(async () => {
    const res = await saveInvestorDealType(null, newType.trim()); if (res.success) { toast.success('Тип добавлен'); setNewType(''); reload() } else toast.error(res.error)
  }) }
  const addPayout = (i: InvestorCard) => {
    if (!(Number(payoutForm.amount) > 0)) { toast.error('Сумма выплаты больше 0'); return }
    if (!payoutForm.date) { toast.error('Укажите дату выплаты'); return }
    startSaving(async () => {
      const res = await saveInvestorPayout(null, {
        investor_id: i.id, amount_som: Number(payoutForm.amount), payout_date: payoutForm.date,
        period_month: payoutForm.type === 'principal_return' ? null : periodMonth,
        payout_type: payoutForm.type, note: payoutForm.note,
      })
      if (res.success) { toast.success('Выплата добавлена'); setPayoutForm(emptyPayout()); reload() } else toast.error(res.error)
    })
  }
  const removePayout = (id: string) => { if (!confirm('Удалить выплату?')) return; startSaving(async () => {
    const res = await deleteInvestorPayout(id); if (res.success) { toast.success('Удалена'); reload() } else toast.error(res.error)
  }) }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[90, 150, 260].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
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

      {/* Выбор месяца */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: '12px', color: MUTE, fontFamily: MONO }}>
          <div>чистая прибыль: <b style={{ color: data.netProfit >= 0 ? GREEN : RED }}>{fmt(data.netProfit)}</b> сом</div>
          <div style={{ marginTop: '3px' }}>выручка: <b style={{ color: INK }}>{fmt(data.revenue)}</b> сом</div>
        </div>
      </div>

      {/* ИТОГО */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        <Tile label="Вложено всего" value={data.totals.investedTotal} color={ACCENT} />
        <Tile label="Начислено за месяц" value={data.totals.accruedTotal} color={AMBER}
              hint={`по условиям сделок · остаток к выплате ${fmt(data.totals.accrualOutstandingTotal)}`} />
        {/* Б2: возврат тела показываем отдельно — он не гасит начисления. */}
        <Tile label="Выплачено за месяц" value={data.totals.paidTotal} color={GREEN}
              hint={`в т.ч. по начислениям ${fmt(data.totals.accrualPaidTotal)} · возврат тела ${fmt(data.totals.principalReturnedThisMonthTotal)}`} />
        <Tile label="Сумма вложений к возврату" value={data.totals.principalOutstandingTotal} color={RED} hint="сами вложения без процентов · по активным" />
      </div>

      {/* Форма инвестора */}
      {data.canManage && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>{form.id ? 'Редактирование инвестора' : 'Новый инвестор'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
            <label><span style={lbl}>Имя</span><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="инвестор" style={box} /></label>
            <label><span style={lbl}>Контакт</span><input value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} placeholder="телефон / @ (необязательно)" style={box} /></label>
            <label><span style={lbl}>Сумма вложения</span><input type="number" min={0} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
            <label><span style={lbl}>Валюта</span>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
                <option value="KGS">сом (KGS)</option><option value="USD">$ (USD)</option>
              </select>
            </label>
            {form.currency === 'USD' && <label><span style={lbl}>Курс (сом за $1)</span><input type="number" min={0} value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="напр. 89" style={{ ...box, fontFamily: MONO }} /></label>}
            <label><span style={lbl}>Тип сделки</span>
              <select value={form.deal_type_id} onChange={e => setForm(f => ({ ...f, deal_type_id: e.target.value }))} style={box}>
                <option value="">— выберите —</option>
                {data.dealTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            {fields.profit && <label><span style={lbl}>% от чистой прибыли</span><input type="number" min={0} value={form.profit} onChange={e => setForm(f => ({ ...f, profit: e.target.value }))} placeholder="напр. 20" style={{ ...box, fontFamily: MONO }} /></label>}
            {fields.fixed && <label><span style={lbl}>Фикс. ставка, %</span><input type="number" min={0} value={form.fixed} onChange={e => setForm(f => ({ ...f, fixed: e.target.value }))} placeholder="напр. 5" style={{ ...box, fontFamily: MONO }} /></label>}
            {fields.fixed && <label><span style={lbl}>Период ставки</span>
              <select value={form.rate_period} onChange={e => setForm(f => ({ ...f, rate_period: e.target.value as RatePeriod }))} style={box}>
                <option value="monthly">в месяц</option><option value="annual">в год</option><option value="term">за весь срок</option>
              </select>
            </label>}
            {fields.royalty && <label><span style={lbl}>Роялти, % от выручки</span><input type="number" min={0} value={form.royalty} onChange={e => setForm(f => ({ ...f, royalty: e.target.value }))} placeholder="напр. 3" style={{ ...box, fontFamily: MONO }} /></label>}
            <label><span style={lbl}>Дата начала</span><input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} style={box} /></label>
            <label><span style={lbl}>Срок, мес.</span><input type="number" min={0} value={form.term} onChange={e => setForm(f => ({ ...f, term: e.target.value }))} placeholder="напр. 12" style={{ ...box, fontFamily: MONO }} /></label>
            <label><span style={lbl}>Возврат тела (дата)</span><input type="date" value={form.principal_due} onChange={e => setForm(f => ({ ...f, principal_due: e.target.value }))} style={box} /></label>
            <label><span style={lbl}>Статус</span>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as InvestorStatus }))} style={box}>
                <option value="active">Активный</option><option value="closed">Закрыт</option>
              </select>
            </label>
            <label><span style={lbl}>Комментарий</span><input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="необязательно" style={box} /></label>
          </div>
          <div style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving} style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>{form.id ? 'Сохранить' : '＋ Добавить'}</button>
            {form.id && <button onClick={() => setForm(emptyForm())} style={{ border: `1px solid ${LINE}`, background: '#fff', color: MUTE, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', cursor: 'pointer' }}>Отмена</button>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input value={newType} onChange={e => setNewType(e.target.value)} placeholder="свой тип сделки" style={{ ...box, width: '180px', padding: '8px 10px' }} />
              <button onClick={addType} disabled={saving} style={{ border: `1px solid ${LINE}`, background: '#fff', color: ACCENT, borderRadius: '10px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>＋ тип</button>
            </div>
          </div>
        </div>
      )}

      {/* Список инвесторов */}
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Инвесторы</div>
        <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Начислено — за {MONTHS[month].toLowerCase()} по условиям сделки. Нажмите на карточку для истории выплат.</p>
        {data.investors.length === 0 ? (
          <div style={{ fontSize: '12.5px', color: FAINT }}>Инвесторов пока нет</div>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {data.investors.map(i => {
              const dl = dueLabel(i.daysToPrincipal)
              const open = expanded === i.id
              return (
                <div key={i.id} style={{ border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden', opacity: i.status === 'closed' ? 0.7 : 1 }}>
                  <div onClick={() => { setExpanded(open ? null : i.id); setPayoutForm(emptyPayout()) }} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,1.4fr) repeat(3, minmax(110px,1fr)) auto', gap: '12px', alignItems: 'center', padding: '13px 16px', cursor: 'pointer', background: open ? '#f4f7f9' : '#fff' }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: INK }}>{i.name} {i.status === 'closed' && <span style={{ fontSize: '10px', color: FAINT, fontWeight: 600 }}>· закрыт</span>}</div>
                      <div style={{ fontSize: '11.5px', color: MUTE, marginTop: '2px' }}>{i.deal_type_name} · вложено <b style={{ color: INK, fontFamily: MONO }}>{fmt(i.amount_som)}</b>{i.currency === 'USD' && <span style={{ color: FAINT }}> (${fmt(i.amount_original)}×{fmt1(i.rate)})</span>}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}><div style={{ fontSize: '10.5px', color: FAINT }}>начислено</div><div style={{ fontFamily: MONO, fontWeight: 700, color: AMBER }}>{fmt(i.accruedThisMonth)}</div></div>
                    <div style={{ textAlign: 'right' }}><div style={{ fontSize: '10.5px', color: FAINT }}>выплачено (мес.)</div><div style={{ fontFamily: MONO, fontWeight: 700, color: GREEN }}>{fmt(i.paidThisMonth)}</div></div>
                    <div style={{ textAlign: 'right' }} title="Тело инвестиции — сама вложенная сумма, без процентов и доли прибыли"><div style={{ fontSize: '10.5px', color: FAINT }}>вложение к возврату</div><div style={{ fontFamily: MONO, fontWeight: 700, color: i.principalOutstanding > 0 ? RED : GREEN }}>{fmt(i.principalOutstanding)}</div>{i.principal_due_date && i.principalOutstanding > 0 && <div style={{ fontSize: '10px', color: dl.color }}>{ru(i.principal_due_date)} · {dl.text}</div>}</div>
                    <div style={{ color: FAINT, fontSize: '12px' }}>{open ? '▲' : '▼'}</div>
                  </div>

                  {open && (
                    <div style={{ padding: '14px 16px', borderTop: `1px solid ${LINE}`, background: '#fbfcfd' }}>
                      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: MUTE, marginBottom: '12px' }}>
                        {i.profit_share_pct != null && <span>Доля прибыли: <b style={{ color: INK }}>{fmt1(i.profit_share_pct)}%</b></span>}
                        {i.fixed_rate_pct != null && <span>Фикс: <b style={{ color: INK }}>{fmt1(i.fixed_rate_pct)}%</b> {i.rate_period ? RATE_PERIOD_LABEL[i.rate_period] : ''}</span>}
                        {i.royalty_pct != null && <span>Роялти: <b style={{ color: INK }}>{fmt1(i.royalty_pct)}%</b></span>}
                        {i.start_date && <span>с {ru(i.start_date)}</span>}
                        {i.term_months != null && <span>срок {i.term_months} мес.</span>}
                        <span>выплачено всего: <b style={{ color: INK, fontFamily: MONO }}>{fmt(i.paidTotal)}</b> · возвращено тела: <b style={{ color: INK, fontFamily: MONO }}>{fmt(i.principalReturned)}</b></span>
                        {i.contact && <span>· {i.contact}</span>}
                        {data.canManage && <span style={{ marginLeft: 'auto' }}>
                          <button onClick={() => edit(i)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '10px' }}>изменить</button>
                          <button onClick={() => remove(i)} style={{ background: 'transparent', border: 'none', color: RED, fontWeight: 600, cursor: 'pointer', fontSize: '12px' }}>удалить</button>
                        </span>}
                      </div>

                      {/* Реестр выплат */}
                      {i.payouts.length > 0 ? (
                        <div style={{ display: 'grid', gap: '5px', marginBottom: data.canManage ? '12px' : 0 }}>
                          {i.payouts.map(p => (
                            <div key={p.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '12px', alignItems: 'center', padding: '7px 12px', borderRadius: '9px', background: '#fff', border: `1px solid ${LINE}`, fontSize: '12.5px' }}>
                              <span style={{ fontFamily: MONO, color: FAINT }}>{ru(p.payout_date)}</span>
                              <span style={{ color: MUTE }}>{PAYOUT_TYPE_LABEL[p.payout_type]}{p.note ? ` · ${p.note}` : ''}</span>
                              <span style={{ fontFamily: MONO, fontWeight: 700, color: p.payout_type === 'principal_return' ? RED : GREEN }}>{fmt(p.amount_som)} сом</span>
                              {data.canManage ? <button onClick={() => removePayout(p.id)} style={{ background: 'transparent', border: 'none', color: RED, cursor: 'pointer', fontSize: '11px' }}>уд.</button> : <span />}
                            </div>
                          ))}
                        </div>
                      ) : <div style={{ fontSize: '12px', color: FAINT, marginBottom: data.canManage ? '12px' : 0 }}>Выплат ещё не было</div>}

                      {/* Добавить выплату */}
                      {data.canManage && (
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                          <label style={{ flex: '0 0 120px' }}><span style={lbl}>Сумма (сом)</span><input type="number" min={0} value={payoutForm.amount} onChange={e => setPayoutForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
                          <label style={{ flex: '0 0 140px' }}><span style={lbl}>Дата</span><input type="date" value={payoutForm.date} onChange={e => setPayoutForm(f => ({ ...f, date: e.target.value }))} style={box} /></label>
                          <label style={{ flex: '0 0 160px' }}><span style={lbl}>Тип выплаты</span>
                            <select value={payoutForm.type} onChange={e => setPayoutForm(f => ({ ...f, type: e.target.value as PayoutType }))} style={box}>
                              <option value="profit_share">Доля прибыли</option><option value="interest">Проценты</option>
                              <option value="principal_return">Возврат тела</option><option value="other">Прочее</option>
                            </select>
                          </label>
                          <label style={{ flex: '1 1 140px' }}><span style={lbl}>Комментарий</span><input value={payoutForm.note} onChange={e => setPayoutForm(f => ({ ...f, note: e.target.value }))} placeholder="необязательно" style={box} /></label>
                          <button onClick={() => addPayout(i)} disabled={saving} style={{ background: ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '9px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>＋ выплата</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* График выплат — регулярные обязательства (сколько в месяц и до какой даты) */}
      {data.payoutSchedule.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>График выплат</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>
            Сколько начислять инвесторам в месяц и до какой даты. Фиксированные — стабильная сумма каждый месяц;
            от прибыли и роялти — плавающие, зависят от результата месяца.
          </p>
          <div style={{ display: 'grid', gap: '6px' }}>
            {data.payoutSchedule.map(s => (
              <div key={s.investor_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '12px', alignItems: 'center', padding: '10px 12px', borderRadius: '10px', background: '#f8fafb', border: `1px solid ${LINE}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{s.name}</div>
                  <div style={{ fontSize: '11px', color: FAINT }}>{s.basis}</div>
                </div>
                <span style={{
                  fontSize: '10.5px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', whiteSpace: 'nowrap',
                  color: s.isFixed ? ACCENT : AMBER, background: s.isFixed ? '#e2eef4' : '#fbf1e6',
                }}>{s.isFixed ? 'фиксированная' : 'плавающая'}</span>
                <div style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>
                  {fmt(s.monthlyAmount)} <span style={{ fontSize: '10px', color: STEEL }}>сом/мес</span>
                </div>
                <div style={{ fontSize: '11.5px', color: FAINT, whiteSpace: 'nowrap', minWidth: '92px', textAlign: 'right' }}>
                  {s.untilDate ? `до ${ru(s.untilDate)}` : 'бессрочно'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ближайшие возвраты вложений (тела) */}
      {data.upcomingPrincipal.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Ближайшие возвраты вложений</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Возврат самой вложенной суммы — тела инвестиции, без процентов (ближайшие и просроченные — сверху)</p>
          <div style={{ display: 'grid', gap: '6px' }}>
            {data.upcomingPrincipal.map(u => {
              const dl = dueLabel(u.daysToPrincipal)
              const overdue = u.daysToPrincipal < 0
              return (
                <div key={u.investor_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '10px 14px', borderRadius: '10px', background: overdue ? '#fdf1f0' : '#f4f7f9', border: `1px solid ${LINE}` }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{u.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: '13px', fontWeight: 700, color: RED }}>{fmt(u.principalOutstanding)} сом</div>
                  <div style={{ fontSize: '12px', color: dl.color, fontWeight: overdue ? 700 : 500, whiteSpace: 'nowrap', textAlign: 'right' }}>{ru(u.principal_due_date)} · {dl.text}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
