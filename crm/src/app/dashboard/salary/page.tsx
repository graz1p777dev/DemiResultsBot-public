'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { toast } from 'sonner'
import {
  getSalarySheet,
  addAdvance,
  toggleKpiItem,
  closeMonth,
  closeEmployeeMonth,
  type SalarySheet,
  type SalaryRow,
} from '@/actions/salary'

const MONO = "'IBM Plex Mono', monospace"
const RU_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

const NBSP = ' '
function fmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + NBSP + 'сом'
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase()
}

function fmtDate(iso: string): string {
  return iso.split('-').reverse().join('.')
}

// Цвет % плана: <80 красный, 80–99 янтарный, ≥100 зелёный (oklch из макета)
function planColor(pct: number | null): string {
  if (pct === null) return '#a2b4c0'
  if (pct < 80)  return 'oklch(0.55 0.15 25)'
  if (pct < 100) return 'oklch(0.62 0.11 70)'
  return 'oklch(0.52 0.10 165)'
}

const th: React.CSSProperties = {
  padding: '12px 12px', fontSize: '11px', textTransform: 'uppercase',
  letterSpacing: '0.05em', color: '#7b8a95', fontWeight: 600, textAlign: 'right',
}

export default function SalaryPage() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [sheet, setSheet] = useState<SalarySheet | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingId, setAddingId]     = useState<string | null>(null)
  const [draft, setDraft]           = useState('')
  const [closing, setClosing]       = useState(false)
  const [closingEmpId, setClosingEmpId] = useState<string | null>(null)

  const load = useCallback(async (y: number, m: number) => {
    setLoading(true)
    const data = await getSalarySheet(y, m)
    setSheet(data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(year, month)
  }, [load, year, month])

  const prevMonth = () => {
    setExpandedId(null); setAddingId(null)
    if (month === 1) { setYear(y => y - 1); setMonth(12) } else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    setExpandedId(null); setAddingId(null)
    if (month === 12) { setYear(y => y + 1); setMonth(1) } else setMonth(m => m + 1)
  }

  const handleCloseMonth = async () => {
    if (!confirm(`Закрыть ${RU_MONTHS[month - 1]} ${year}? Ведомость станет доступна только для чтения — отменить закрытие нельзя.`)) return
    setClosing(true)
    const res = await closeMonth(year, month)
    setClosing(false)
    if (res.success) { toast.success('Месяц закрыт'); void load(year, month) }
    else toast.error(res.error)
  }

  const handleCloseEmployee = async (row: SalaryRow) => {
    if (!confirm(`Закрыть расчёт для ${row.name} за ${RU_MONTHS[month - 1]} ${year}? Это действие нельзя отменить.`)) return
    setClosingEmpId(row.employee_id)
    const res = await closeEmployeeMonth(row.employee_id, year, month)
    setClosingEmpId(null)
    if (res.success) { toast.success(`Расчёт для ${row.name} закрыт`); void load(year, month) }
    else toast.error(res.error)
  }

  const handleAddAdvance = async (employeeId: string) => {
    const amount = Number(draft)
    if (!amount || amount <= 0) { toast.error('Введите сумму'); return }
    const res = await addAdvance(employeeId, year, month, amount)
    if (res.success) { toast.success('Аванс добавлен'); setAddingId(null); setDraft(''); void load(year, month) }
    else toast.error(res.error)
  }

  const handleToggleKpi = async (row: SalaryRow, itemId: string, current: boolean) => {
    // В узком режиме KPI-пункты только для чтения: отметку ставит руководитель,
    // не сам сотрудник (сервер это тоже отклонит — toggleKpiItem требует
    // requireSalaryAccess + salaries.edit).
    if (sheet?.ownOnly) return
    if (sheet?.monthClosed || row.is_closed) return
    const res = await toggleKpiItem(row.employee_id, itemId, year, month, !current)
    if (res.success) void load(year, month)
    else toast.error(res.error)
  }

  // ── Доступ ──────────────────────────────────────────────────────────────────
  // Решает СЕРВЕР, не роль в клиенте. Раньше здесь стоял хардкод
  // `role !== 'owner' && role !== 'accountant'`, из-за чего rop/mp/lmai видели пункт
  // меню «Моя зарплата» и упирались в «Нет доступа», хотя getSalarySheet уже отдавал
  // им их собственную строку. Теперь отказ показываем только когда сервер вернул null
  // (нет права salaries.view вовсе).
  if (!loading && !sheet) {
    return (
      <div style={{ minHeight: '100vh', background: '#e6ebee', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
        <div style={{ background: '#fff', borderRadius: '16px', padding: '28px 34px', border: '1px solid #e3e9ec', textAlign: 'center', maxWidth: '380px' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#0c2136' }}>Нет доступа</div>
          <p style={{ fontSize: '13px', color: '#7b8a95', margin: '8px 0 0' }}>Раздел зарплаты для вашей роли недоступен</p>
        </div>
      </div>
    )
  }

  const monthLabel = `${RU_MONTHS[month - 1]} ${year}`
  const isClosed = sheet?.monthClosed ?? false
  const rows = sheet?.rows ?? []

  // Узкий режим: сотрудник видит только собственный лист. Флаг приходит с сервера
  // вместе с уже отфильтрованными строками — это не «скрытие» чужих данных в UI,
  // чужие строки сюда физически не доезжают.
  const ownOnly = sheet?.ownOnly ?? false

  const totals = rows.map(r => r.salary_calc + r.plan_bonus + r.items_bonus + r.daily_bonus)
  const fot = totals.reduce((a, b) => a + b, 0)
  const ownAdvances = rows.reduce((s, r) => s + r.advances.reduce((a, x) => a + x.amount, 0), 0)

  return (
    <div style={{ minHeight: '100vh', background: '#e6ebee', padding: '28px 28px 64px', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: '#0c2136' }}>
      <div style={{ maxWidth: '1320px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* ===== HEADER ===== */}
        <div style={{ background: '#0c2136', color: '#fff', borderRadius: '18px', padding: '22px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap', boxShadow: '0 12px 30px -18px rgba(12,33,54,0.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ width: '52px', height: '52px', borderRadius: '14px', background: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="6" width="19" height="13" rx="3" stroke="#fff" strokeWidth="1.8"/><path d="M2.5 10.5h19" stroke="#fff" strokeWidth="1.8"/><circle cx="17" cy="14.5" r="1.6" fill="#fff"/></svg>
            </div>
            <div>
              <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.01em' }}>{ownOnly ? 'Моя зарплата' : 'Зарплата'}</div>
              <div style={{ fontSize: '13px', color: '#a2b4c0' }}>{ownOnly ? 'Ваш личный расчёт за месяц' : 'Расчёт и учёт заработной платы сотрудников'}</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' }}>
            {/* Переключатель месяца */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '6px 8px' }}>
              <button onClick={prevMonth} aria-label="Предыдущий месяц" style={{ width: '34px', height: '34px', border: 0, borderRadius: '9px', background: 'rgba(255,255,255,0.08)', color: '#fff', cursor: 'pointer', fontSize: '16px' }}>‹</button>
              <div style={{ minWidth: '132px', textAlign: 'center', fontWeight: 600, fontSize: '15px' }}>{monthLabel}</div>
              <button onClick={nextMonth} aria-label="Следующий месяц" style={{ width: '34px', height: '34px', border: 0, borderRadius: '9px', background: 'rgba(255,255,255,0.08)', color: '#fff', cursor: 'pointer', fontSize: '16px' }}>›</button>
            </div>

            {/* Статус месяца */}
            {isClosed ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(162,180,192,0.16)', border: '1px solid rgba(162,180,192,0.4)', color: '#a2b4c0', borderRadius: '999px', padding: '7px 14px', fontSize: '13px', fontWeight: 600 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="#a2b4c0" strokeWidth="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#a2b4c0" strokeWidth="2"/></svg>
                Месяц закрыт
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(12,77,108,0.55)', border: '1px solid #0c4d6c', color: '#cfe6f0', borderRadius: '999px', padding: '7px 14px', fontSize: '13px', fontWeight: 600 }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4fd1c5', display: 'inline-block' }} />
                Месяц открыт
              </div>
            )}

            {/* Закрытие месяца — управляющее действие, в узком режиме недоступно
                (сервер всё равно откажет: requireSalaryAccess пускает owner/accountant). */}
            {!ownOnly && !isClosed && rows.length > 0 && (
              <button
                onClick={handleCloseMonth}
                disabled={closing}
                style={{ border: 0, borderRadius: '11px', background: closing ? '#5c6f7c' : '#0c4d6c', color: '#fff', cursor: closing ? 'default' : 'pointer', fontSize: '14px', fontWeight: 600, padding: '11px 18px', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'inherit' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="#fff" strokeWidth="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#fff" strokeWidth="2"/></svg>
                {closing ? 'Закрытие…' : 'Закрыть месяц'}
              </button>
            )}
          </div>
        </div>

        {/* Лента закрытого месяца */}
        {isClosed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#dfe6ea', border: '1px dashed #a2b4c0', borderRadius: '12px', padding: '12px 18px', fontSize: '13.5px', backgroundImage: 'repeating-linear-gradient(45deg, rgba(162,180,192,0.10) 0, rgba(162,180,192,0.10) 8px, transparent 8px, transparent 16px)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="#0c2136" strokeWidth="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#0c2136" strokeWidth="2"/></svg>
            <span>
              Ведомость зафиксирована и доступна только для чтения.
              {sheet?.closedAt ? ` Зафиксировано ${fmtDate(sheet.closedAt.slice(0, 10))}` : ''}
              {sheet?.closedByName ? ` пользователем ${sheet.closedByName}.` : ''}
            </span>
          </div>
        )}

        {/* ===== SUMMARY CARDS ===== */}
        {/* В узком режиме карточки — личные. Показывать ФОТ/численность/среднюю по
            компании сотруднику нельзя: это агрегаты по чужим зарплатам. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          {(ownOnly
            ? [
                { title: 'Начислено за месяц', value: fmt(fot), sub: 'оклад и бонусы' },
                { title: 'Авансы', value: fmt(ownAdvances), sub: 'выдано в течение месяца' },
                { title: 'К выплате', value: fmt(fot - ownAdvances), sub: 'начислено минус авансы' },
              ]
            : [
                { title: 'Фонд оплаты труда', value: fmt(fot), sub: 'общая сумма всех начислений' },
                { title: 'Сотрудников', value: String(rows.length), sub: 'в ведомости за месяц' },
                { title: 'Средняя зарплата', value: rows.length > 0 ? fmt(fot / rows.length) : '—', sub: 'начислено на сотрудника' },
              ]
          ).map(c => (
            <div key={c.title} style={{ background: '#fff', borderRadius: '16px', padding: '20px 22px', border: '1px solid #e3e9ec', boxShadow: '0 8px 24px -20px rgba(12,33,54,0.4)' }}>
              <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600, marginBottom: '10px' }}>{c.title}</div>
              <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 600, letterSpacing: '-0.01em' }}>{c.value}</div>
              <div style={{ fontSize: '12.5px', color: '#7b8a95', marginTop: '6px' }}>{c.sub}</div>
            </div>
          ))}
        </div>

        {/* ===== TABLE ===== */}
        <div style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e3e9ec', overflow: 'hidden', boxShadow: '0 8px 24px -20px rgba(12,33,54,0.4)' }}>
          <div style={{ padding: '18px 24px', borderBottom: '1px solid #eef2f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '15px', fontWeight: 700 }}>{ownOnly ? 'Мой расчёт' : 'Ведомость'} · {monthLabel}</div>
            <div style={{ fontSize: '12.5px', color: '#7b8a95' }}>{ownOnly ? 'Нажмите на строку, чтобы раскрыть расчёт' : 'Нажмите на сотрудника, чтобы раскрыть расчёт'}</div>
          </div>

          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#a2b4c0', fontSize: '13px' }}>Загрузка ведомости…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#a2b4c0', fontSize: '13px' }}>{ownOnly ? 'Расчёт за этот месяц ещё не сформирован' : 'Нет сотрудников в ведомости'}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1120px', fontSize: '13.5px' }}>
                <thead>
                  <tr style={{ background: '#f3f6f8' }}>
                    <th style={{ ...th, textAlign: 'left', padding: '12px 16px 12px 24px' }}>Сотрудник</th>
                    <th style={th}>Оклад</th>
                    <th style={{ ...th, textAlign: 'center' }}>% плана</th>
                    <th style={th}>Бонус за план</th>
                    <th style={th}>Бонус KPI</th>
                    <th style={th}>Ежедн.</th>
                    <th style={th}>Итого начислено</th>
                    <th style={th}>Аванс</th>
                    <th style={th}>К выплате</th>
                    <th style={{ ...th, textAlign: 'center', padding: '12px 24px 12px 12px' }}>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const total = r.salary_calc + r.plan_bonus + r.items_bonus + r.daily_bonus
                    const adv = r.advances.reduce((s, a) => s + a.amount, 0)
                    const toPay = total - adv
                    const expanded = expandedId === r.employee_id
                    const rowClosed = isClosed || r.is_closed
                    const kpiDone = r.kpi_items.filter(k => k.is_completed).length

                    return (
                      <Fragment key={r.employee_id}>
                        <tr
                          onClick={() => { setExpandedId(expanded ? null : r.employee_id); setAddingId(null); setDraft('') }}
                          style={{ cursor: 'pointer', background: expanded ? '#f7fafb' : '#fff', borderTop: '1px solid #eef2f4' }}
                        >
                          <td style={{ padding: '14px 16px 14px 24px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#e6ebee', color: '#0c4d6c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '13px', flexShrink: 0 }}>{initials(r.name)}</div>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{r.name}</div>
                                <div style={{ fontSize: '12px', color: '#7b8a95' }}>{r.role_label}</div>
                              </div>
                              <span style={{ marginLeft: '4px', color: '#a2b4c0', fontSize: '12px', transition: 'transform .15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
                            </div>
                          </td>
                          <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                            <div style={{ fontFamily: MONO, fontWeight: 500 }}>{fmt(r.salary_calc)}</div>
                            <div style={{ fontSize: '11px', color: '#a2b4c0' }}>{r.salary_type === 'per_shift' ? `сдельно, ${r.worked_days} дн.` : 'фикс.'}</div>
                          </td>
                          <td style={{ padding: '14px 12px', textAlign: 'center', fontFamily: MONO, fontWeight: 600, color: planColor(r.plan_pct) }}>
                            {r.plan_pct === null ? '—' : `${Math.round(r.plan_pct)}%`}
                          </td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO, color: r.plan_bonus > 0 ? '#0c2136' : '#c2ccd3' }}>{fmt(r.plan_bonus)}</td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO }}>{fmt(r.items_bonus)}</td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO }}>{fmt(r.daily_bonus)}</td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO, fontWeight: 600 }}>{fmt(total)}</td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO, color: '#9aa7b0' }}>{fmt(adv)}</td>
                          <td style={{ padding: '14px 12px', textAlign: 'right', fontFamily: MONO, fontWeight: 700, color: '#0c4d6c', fontSize: '14.5px' }}>{fmt(toPay)}</td>
                          <td style={{ padding: '14px 24px 14px 12px', textAlign: 'center' }}>
                            {rowClosed ? (
                              <span style={{ display: 'inline-flex', background: '#0c2136', color: '#cdd6dd', borderRadius: '999px', padding: '4px 11px', fontSize: '11.5px', fontWeight: 600 }}>Закрыт</span>
                            ) : (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ display: 'inline-flex', background: '#eef2f4', color: '#647581', border: '1px solid #dbe3e7', borderRadius: '999px', padding: '4px 11px', fontSize: '11.5px', fontWeight: 600 }}>Черновик</span>
                                {!ownOnly && <button
                                  onClick={e => { e.stopPropagation(); void handleCloseEmployee(r) }}
                                  disabled={closingEmpId === r.employee_id}
                                  title={`Закрыть расчёт для ${r.name}`}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', border: '1px solid #0c4d6c', background: closingEmpId === r.employee_id ? '#eef2f4' : '#fff', color: '#0c4d6c', borderRadius: '999px', padding: '4px 10px', fontSize: '11.5px', fontWeight: 600, cursor: closingEmpId === r.employee_id ? 'default' : 'pointer', fontFamily: 'inherit' }}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="#0c4d6c" strokeWidth="2.4"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#0c4d6c" strokeWidth="2.4"/></svg>
                                  {closingEmpId === r.employee_id ? '…' : 'Закрыть'}
                                </button>}
                              </span>
                            )}
                          </td>
                        </tr>

                        {/* ===== ДЕТАЛЬНАЯ КАРТОЧКА ===== */}
                        {expanded && (
                          <tr>
                            <td colSpan={10} style={{ padding: 0, background: '#f7fafb', borderTop: '1px solid #e3e9ec' }}>
                              <div style={{ padding: '26px 28px', backgroundImage: rowClosed ? 'repeating-linear-gradient(45deg, rgba(162,180,192,0.09) 0, rgba(162,180,192,0.09) 8px, transparent 8px, transparent 16px)' : 'none' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: '28px', alignItems: 'start' }}>

                                  {/* LEFT: разбивка + KPI */}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
                                    <div>
                                      <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600, marginBottom: '12px' }}>Разбивка начислений</div>
                                      <div style={{ background: '#fff', border: '1px solid #e3e9ec', borderRadius: '12px', overflow: 'hidden' }}>
                                        {[
                                          {
                                            label: 'Оклад',
                                            note: r.salary_type === 'per_shift' ? `сдельно · ${r.worked_days} дн. × ${fmt(r.salary_amount)}` : 'фиксированный оклад',
                                            amount: r.salary_calc, color: '#0c2136',
                                          },
                                          {
                                            label: 'Бонус за план',
                                            note: r.plan_pct === null ? 'роль без декомпозиции плана' : `${Math.round(r.plan_pct)}% выполнения личного плана выручки`,
                                            amount: r.plan_bonus, color: r.plan_bonus > 0 ? '#0c4d6c' : '#a2b4c0',
                                          },
                                          {
                                            label: 'Бонус за KPI-пункты',
                                            note: r.kpi_items.length > 0 ? `${kpiDone} из ${r.kpi_items.length} пунктов выполнено` : 'KPI-пункты для роли не настроены',
                                            amount: r.items_bonus, color: r.items_bonus > 0 ? '#0c4d6c' : '#a2b4c0',
                                          },
                                          {
                                            label: 'Ежедневный бонус',
                                            note: r.daily_bonus > 0 ? 'по ступеням дневной выручки' : 'не начислен',
                                            amount: r.daily_bonus, color: r.daily_bonus > 0 ? '#0c2136' : '#a2b4c0',
                                          },
                                        ].map(b => (
                                          <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '13px 16px', borderBottom: '1px solid #f0f4f6' }}>
                                            <div>
                                              <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{b.label}</div>
                                              <div style={{ fontSize: '12px', color: '#7b8a95' }}>{b.note}</div>
                                            </div>
                                            <div style={{ fontFamily: MONO, fontWeight: 600, color: b.color, whiteSpace: 'nowrap' }}>{fmt(b.amount)}</div>
                                          </div>
                                        ))}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: '#0c2136', color: '#fff' }}>
                                          <div style={{ fontWeight: 600, fontSize: '13.5px' }}>Итого начислено</div>
                                          <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '15px' }}>{fmt(total)}</div>
                                        </div>
                                      </div>
                                    </div>

                                    {r.kpi_items.length > 0 && (
                                      <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                                          <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600 }}>KPI-пункты</div>
                                          <div style={{ fontSize: '12px', color: '#7b8a95' }}>{kpiDone} из {r.kpi_items.length} выполнено</div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                          {r.kpi_items.map(k => (
                                            <label
                                              key={k.id}
                                              onClick={e => { e.stopPropagation(); void handleToggleKpi(r, k.id, k.is_completed) }}
                                              style={{ display: 'flex', alignItems: 'center', gap: '11px', background: '#fff', border: '1px solid #e3e9ec', borderRadius: '10px', padding: '11px 14px', cursor: rowClosed || ownOnly ? 'default' : 'pointer' }}
                                            >
                                              <span style={{ width: '19px', height: '19px', borderRadius: '6px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: k.is_completed ? '#0c4d6c' : '#fff', border: `1.5px solid ${k.is_completed ? '#0c4d6c' : '#cdd8de'}` }}>
                                                {k.is_completed && <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                              </span>
                                              <span style={{ flex: 1, fontSize: '13px', color: k.is_completed ? '#0c2136' : '#7b8a95' }}>{k.name}</span>
                                              <span style={{ fontFamily: MONO, fontSize: '12.5px', color: '#9aa7b0' }}>{fmt(k.bonus_amount)}</span>
                                            </label>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>

                                  {/* RIGHT: к выплате + авансы */}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
                                    <div style={{ background: '#0c4d6c', color: '#fff', borderRadius: '14px', padding: '22px 24px' }}>
                                      <div style={{ fontSize: '12.5px', color: '#bfe0ee', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>К выплате</div>
                                      <div style={{ fontFamily: MONO, fontSize: '40px', fontWeight: 600, letterSpacing: '-0.02em', marginTop: '6px', lineHeight: 1 }}>{fmt(toPay)}</div>
                                      <div style={{ display: 'flex', gap: '18px', marginTop: '16px', fontSize: '12.5px', color: '#bfe0ee' }}>
                                        <div>Начислено: <span style={{ color: '#fff', fontFamily: MONO }}>{fmt(total)}</span></div>
                                        <div>Аванс: <span style={{ color: '#fff', fontFamily: MONO }}>−{fmt(adv)}</span></div>
                                      </div>
                                    </div>

                                    <div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                                        <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7b8a95', fontWeight: 600 }}>Авансы за месяц</div>
                                        {!ownOnly && !rowClosed && (
                                          <button
                                            onClick={e => { e.stopPropagation(); setAddingId(addingId === r.employee_id ? null : r.employee_id); setDraft('') }}
                                            style={{ border: '1px solid #0c4d6c', background: '#fff', color: '#0c4d6c', borderRadius: '9px', padding: '6px 12px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                                          >
                                            + Добавить аванс
                                          </button>
                                        )}
                                      </div>

                                      <div style={{ background: '#fff', border: '1px solid #e3e9ec', borderRadius: '12px', overflow: 'hidden' }}>
                                        {r.advances.length > 0 ? (
                                          r.advances.map(a => (
                                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 15px', borderBottom: '1px solid #f0f4f6' }}>
                                              <div>
                                                <div style={{ fontSize: '13px', fontWeight: 500 }}>{fmtDate(a.date)}</div>
                                                <div style={{ fontSize: '11.5px', color: '#a2b4c0' }}>выдал: {a.by_name ?? '—'}</div>
                                              </div>
                                              <div style={{ fontFamily: MONO, fontWeight: 600 }}>{fmt(a.amount)}</div>
                                            </div>
                                          ))
                                        ) : (
                                          <div style={{ padding: '16px 15px', fontSize: '13px', color: '#a2b4c0', textAlign: 'center' }}>Авансов за месяц не было</div>
                                        )}

                                        {addingId === r.employee_id && !rowClosed && (
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 15px', background: '#f3f6f8', borderTop: '1px solid #e3e9ec' }}>
                                            <input
                                              value={draft}
                                              onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
                                              placeholder="Сумма, сом"
                                              inputMode="numeric"
                                              style={{ flex: 1, border: '1px solid #cdd8de', borderRadius: '8px', padding: '8px 11px', fontFamily: MONO, fontSize: '13px', outline: 'none', background: '#fff' }}
                                            />
                                            <button onClick={() => void handleAddAdvance(r.employee_id)} style={{ border: 0, background: '#0c4d6c', color: '#fff', borderRadius: '8px', padding: '8px 14px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Сохранить</button>
                                            <button onClick={() => { setAddingId(null); setDraft('') }} style={{ border: 0, background: '#e6ebee', color: '#647581', borderRadius: '8px', padding: '8px 12px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Отмена</button>
                                          </div>
                                        )}

                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 15px', background: '#f7fafb', borderTop: '1px solid #e3e9ec' }}>
                                          <div style={{ fontSize: '12.5px', color: '#647581', fontWeight: 600 }}>Всего авансов</div>
                                          <div style={{ fontFamily: MONO, fontWeight: 600 }}>{fmt(adv)}</div>
                                        </div>
                                      </div>

                                      {rowClosed && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '10px', fontSize: '12px', color: '#9aa7b0' }}>
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="#9aa7b0" strokeWidth="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#9aa7b0" strokeWidth="2"/></svg>
                                          Изменения недоступны — месяц закрыт
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ fontSize: '12px', color: '#9aa7b0', textAlign: 'center', paddingTop: '4px' }}>
          Demi Results OS · {ownOnly ? 'показан только ваш расчёт' : 'доступ: владелец, бухгалтер'} · суммы указаны в сомах
        </div>
      </div>
    </div>
  )
}
