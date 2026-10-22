'use client'

// Вкладка «Расходы» — первый кирпич финансов. Ввод в KGS/USD (авто-перевод в сомы),
// группировка по 6 категориям, вертикальный анализ (доля %), итог за месяц, управление
// категориями (owner/бухгалтер), перенос постоянных из прошлого месяца. ФОТ — из Зарплаты.

import { useState, useEffect, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getExpensesTabData, saveExpense, deleteExpense, copyRecurringFromPrevMonth,
  saveExpenseCategory, deleteExpenseCategory,
  type ExpensesTabData, type ExpenseGroup, type Expense, type Currency,
} from '@/actions/finance-expenses'

const INK = '#0c2136', ACCENT = '#0c4d6c', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

const box: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px',
  background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit',
}
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

type FormState = { id: string | null; category_id: string; name: string; amount: string; currency: Currency; rate: string; date: string; recurring: boolean }
const emptyForm = (): FormState => ({ id: null, category_id: '', name: '', amount: '', currency: 'KGS', rate: '', date: '', recurring: false })

export default function ExpensesTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth()) // 0-11
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`

  const [data, setData] = useState<ExpensesTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [newCat, setNewCat] = useState('')
  const [catTab, setCatTab] = useState<string>('all')   // 'all' | category.id — переключатель категорий
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getExpensesTabData(periodMonth).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [periodMonth, reloadKey])

  const manualCats = useMemo(() => (data?.groups ?? []).map(g => g.category).filter(c => !c.is_derived), [data])
  const costGroup = useMemo(() => (data?.groups ?? []).find(g => g.category.name.toLowerCase().includes('себестоим')), [data])

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  const save = () => {
    if (!form.category_id) { toast.error('Выберите категорию'); return }
    if (!form.name.trim()) { toast.error('Укажите название'); return }
    if (!(Number(form.amount) > 0)) { toast.error('Сумма больше 0'); return }
    if (form.currency === 'USD' && !(Number(form.rate) > 0)) { toast.error('Укажите курс для $'); return }
    startSaving(async () => {
      const res = await saveExpense(form.id, {
        category_id: form.category_id, name: form.name, amount_original: Number(form.amount),
        currency: form.currency, rate: form.currency === 'USD' ? Number(form.rate) : 1,
        expense_date: form.date || periodMonth, is_recurring: form.recurring, period_month: periodMonth,
      })
      if (res.success) { toast.success(form.id ? 'Расход обновлён' : 'Расход добавлен'); setForm(emptyForm()); reload() }
      else toast.error(res.error)
    })
  }
  const edit = (e: Expense) => setForm({
    id: e.id, category_id: e.category_id, name: e.name, amount: String(e.amount_original),
    currency: e.currency, rate: e.currency === 'USD' ? String(e.rate) : '', date: e.expense_date, recurring: e.is_recurring,
  })
  const remove = (e: Expense) => { if (!confirm('Удалить расход?')) return; startSaving(async () => {
    const res = await deleteExpense(e.id); if (res.success) { toast.success('Удалён'); if (form.id === e.id) setForm(emptyForm()); reload() } else toast.error(res.error)
  }) }
  const copyRec = () => startSaving(async () => {
    const res = await copyRecurringFromPrevMonth(periodMonth)
    if (res.success) { toast.success(res.copied > 0 ? `Скопировано постоянных: ${res.copied}` : 'Нечего копировать (или уже есть)'); reload() } else toast.error(res.error)
  })
  const addCat = () => { if (!newCat.trim()) return; startSaving(async () => {
    const res = await saveExpenseCategory(null, newCat); if (res.success) { toast.success('Категория добавлена'); setNewCat(''); reload() } else toast.error(res.error)
  }) }
  const delCat = (id: string) => startSaving(async () => {
    const res = await deleteExpenseCategory(id); if (res.success) { toast.success('Категория удалена'); reload() } else toast.error(res.error)
  })

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[90, 220, 320].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
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

      {/* Месяц */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prevMonth} style={{ ...box, width: 'auto', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={nextMonth} style={{ ...box, width: 'auto', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Итого за месяц</div>
          <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 700, color: ACCENT }}>{fmt(data.totalSom)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
        </div>
      </div>

      {/* Форма добавления */}
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>{form.id ? 'Редактирование расхода' : 'Новый расход'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
          <label><span style={lbl}>Категория</span>
            <select value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))} style={box}>
              <option value="">— выберите —</option>
              {manualCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label><span style={lbl}>Название</span><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="статья расхода" style={box} /></label>
          <label><span style={lbl}>Сумма</span><input type="number" min={0} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" style={{ ...box, fontFamily: MONO }} /></label>
          <label><span style={lbl}>Валюта</span>
            <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))} style={box}>
              <option value="KGS">сом (KGS)</option>
              <option value="USD">$ (USD)</option>
            </select>
          </label>
          {form.currency === 'USD' && (
            <label><span style={lbl}>Курс (сом за $1)</span><input type="number" min={0} value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="напр. 89" style={{ ...box, fontFamily: MONO }} /></label>
          )}
          <label><span style={lbl}>Дата</span><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={box} /></label>
        </div>
        <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', fontWeight: 600, color: MUTE, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.recurring} onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))} style={{ width: '16px', height: '16px' }} />
            Ежемесячный (постоянный)
          </label>
          {form.currency === 'USD' && Number(form.amount) > 0 && Number(form.rate) > 0 && (
            <span style={{ fontSize: '12.5px', color: FAINT, fontFamily: MONO }}>= {fmt(Number(form.amount) * Number(form.rate))} сом</span>
          )}
          <button onClick={save} disabled={saving} style={{ marginLeft: 'auto', background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>{form.id ? 'Сохранить' : '＋ Добавить'}</button>
          {form.id && <button onClick={() => setForm(emptyForm())} style={{ border: `1px solid ${LINE}`, background: '#fff', color: MUTE, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Отмена</button>}
        </div>
        <div style={{ marginTop: '12px' }}>
          <button onClick={copyRec} disabled={saving} style={{ background: '#f4f7f9', border: `1px solid ${LINE}`, color: ACCENT, borderRadius: '10px', padding: '9px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>⟳ Скопировать постоянные из прошлого месяца</button>
        </div>
      </div>

      {/* Переключатель категорий — без глубокого скролла */}
      <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
        {[{ id: 'all', name: 'Все', sum: data.totalSom }, ...data.groups.map(g => ({ id: g.category.id, name: g.category.name, sum: g.sumSom }))].map(t => {
          const on = t.id === catTab
          return (
            <button key={t.id} onClick={() => setCatTab(t.id)}
              style={{
                display: 'inline-flex', alignItems: 'baseline', gap: '7px',
                background: on ? ACCENT : '#fff', color: on ? '#fff' : MUTE,
                border: `1px solid ${on ? ACCENT : LINE}`, borderRadius: '999px',
                padding: '8px 15px', fontSize: '13px', fontWeight: on ? 700 : 600, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {t.name}
              <span style={{ fontFamily: MONO, fontSize: '11.5px', opacity: on ? 0.85 : 0.6 }}>{fmt(t.sum)}</span>
            </button>
          )
        })}
      </div>

      {catTab === 'all' ? (
        /* Режим «Все» — структура расходов (вертикальный анализ) */
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Структура расходов</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 14px' }}>Доля каждой категории в общих расходах месяца — видно, где раздуто. Нажмите категорию выше, чтобы увидеть её расходы.</p>
          <div style={{ display: 'grid', gap: '10px' }}>
            {data.groups.map(g => (
              <div key={g.category.id} onClick={() => setCatTab(g.category.id)}
                style={{ display: 'grid', gridTemplateColumns: '190px 1fr 120px', gap: '12px', alignItems: 'center', cursor: 'pointer' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.category.name}{g.derived && <span style={{ color: STEEL, fontWeight: 400, fontSize: '11px' }}> · из Зарплаты</span>}
                </div>
                <div style={{ height: '10px', borderRadius: '6px', background: '#eef2f4', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, g.sharePct ?? 0)}%`, background: g.sumSom > 0 ? ACCENT : 'transparent', borderRadius: '6px' }} />
                </div>
                <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: '13px' }}>
                  <span style={{ fontWeight: 700, color: INK }}>{g.sharePct === null ? '—' : `${fmt1(g.sharePct)}%`}</span>
                  <span style={{ color: FAINT, marginLeft: '8px' }}>{fmt(g.sumSom)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Одна выбранная категория */
        data.groups.filter(g => g.category.id === catTab).map(g => (
          <ExpenseCategoryBlock key={g.category.id} group={g} costMode={costGroup?.category.id === g.category.id} onEdit={edit} onRemove={remove} />
        ))
      )}

      {/* Управление категориями */}
      {data.canManage && (
        <div style={card}>
          <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>Категории расходов</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 12px' }}>Можно добавить свою категорию. Базовые удалить нельзя.</p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.groups.map(g => (
              <span key={g.category.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', fontWeight: 600, color: INK, background: '#f4f7f9', border: `1px solid ${LINE}`, borderRadius: '999px', padding: '5px 12px' }}>
                {g.category.name}
                {!g.category.is_system && <button onClick={() => delCat(g.category.id)} title="Удалить" style={{ background: 'transparent', border: 'none', color: '#c0392b', cursor: 'pointer', fontWeight: 700 }}>✕</button>}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', maxWidth: '420px' }}>
            <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="новая категория" style={box} />
            <button onClick={addCat} disabled={saving} style={{ whiteSpace: 'nowrap', background: ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '0 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>＋ Добавить</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Блок одной категории со списком расходов
function ExpenseCategoryBlock({ group, costMode, onEdit, onRemove }: {
  group: ExpenseGroup; costMode: boolean; onEdit: (e: Expense) => void; onRemove: (e: Expense) => void
}) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '15px', fontWeight: 700 }}>{group.category.name}</div>
        <div style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: ACCENT }}>{fmt(group.sumSom)} <span style={{ fontSize: '12px', color: STEEL }}>сом</span></div>
      </div>

      {/* Себестоимость: переключатель источника (пока залочен на ручной ввод) */}
      {costMode && (
        <div style={{ marginTop: '10px', fontSize: '12px', color: MUTE, background: '#f4f7f9', border: `1px dashed #cdd8df`, borderRadius: '10px', padding: '9px 12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-flex', width: '34px', height: '18px', borderRadius: '999px', background: '#d3dde3', position: 'relative', flexShrink: 0 }}>
            <span style={{ position: 'absolute', left: '2px', top: '2px', width: '14px', height: '14px', borderRadius: '50%', background: '#fff' }} />
          </span>
          Ручной ввод. Автоматически из товароучёта — появится позже.
        </div>
      )}

      {group.derived ? (
        <div style={{ marginTop: '12px', fontSize: '13px', color: MUTE, background: '#f6f9fa', borderRadius: '10px', padding: '12px 14px' }}>
          Сумма ФОТ берётся автоматически из раздела <b>Зарплата</b> за месяц — вручную не вводится.
        </div>
      ) : group.items.length === 0 ? (
        <div style={{ marginTop: '12px', fontSize: '12.5px', color: FAINT }}>Нет расходов в этой категории за месяц</div>
      ) : (
        <div style={{ marginTop: '12px', display: 'grid', gap: '6px' }}>
          {group.items.map(e => (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f9fafb', border: `1px solid ${LINE}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{e.name} {e.is_recurring && <span style={{ fontSize: '10.5px', fontWeight: 600, color: ACCENT, background: '#e2eef4', padding: '1px 7px', borderRadius: '999px' }}>ежемес.</span>}</div>
                <div style={{ fontSize: '11.5px', color: FAINT, fontFamily: MONO }}>
                  {e.expense_date.slice(8, 10)}.{e.expense_date.slice(5, 7)}
                  {e.currency === 'USD' && ` · $${fmt(e.amount_original)} × ${fmt1(e.rate)}`}
                </div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>{fmt(e.amount_som)} <span style={{ fontSize: '11px', color: STEEL }}>сом</span></div>
              <div style={{ whiteSpace: 'nowrap' }}>
                <button onClick={() => onEdit(e)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '8px' }}>изм.</button>
                <button onClick={() => onRemove(e)} style={{ background: 'transparent', border: 'none', color: '#c0392b', fontWeight: 600, cursor: 'pointer', fontSize: '12px' }}>уд.</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
