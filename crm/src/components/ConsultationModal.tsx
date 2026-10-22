'use client'

import { useState, useTransition, useEffect } from 'react'
import { X, Trash2, History } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import Modal from './Modal'
import {
  createConsultation,
  updateConsultation,
  deleteConsultation,
  rebookConsultation,
  getConsultationAuditLog,
  type ConsultationFormData,
  type AuditLogEntry,
} from '@/actions/consultations'
import { useAuth } from '@/contexts/AuthContext'
import type { Consultation, Employee } from '@/types'
import type { PartnerOption } from '@/actions/partners'
import { CONSULTATION_SOURCE_ORDER, CONSULTATION_SOURCE_LABELS } from '@/lib/constants'

const AUDIT_ACTION_LABELS: Record<AuditLogEntry['action'], string> = {
  create: 'Создание', update: 'Изменение', delete: 'Удаление', rebook: 'Перезапись',
}

function AuditLogPanel({ consultationId, onClose }: { consultationId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null)

  useEffect(() => {
    getConsultationAuditLog(consultationId).then(setEntries)
  }, [consultationId])

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col rounded-3xl"
      style={{ backgroundColor: 'rgba(255,255,255,0.98)' }}
    >
      <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: '1px solid #ebebee' }}>
        <h3 className="font-semibold text-sm" style={{ color: '#0c2136' }}>История изменений</h3>
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100">
          <X size={16} style={{ color: '#a2b4c0' }} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {entries === null ? (
          <p className="text-sm" style={{ color: '#a2b4c0' }}>Загрузка...</p>
        ) : entries.length === 0 ? (
          <p className="text-sm" style={{ color: '#a2b4c0' }}>Изменений не найдено</p>
        ) : (
          entries.map(entry => (
            <div key={entry.id} className="rounded-xl p-3" style={{ backgroundColor: '#f9fafb', border: '1px solid #ebebee' }}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold" style={{ color: '#0c4d6c' }}>{AUDIT_ACTION_LABELS[entry.action]}</span>
                <span style={{ color: '#a2b4c0' }}>{new Date(entry.created_at).toLocaleString('ru-RU')}</span>
              </div>
              <p className="text-xs mt-1" style={{ color: '#6b7280' }}>
                {entry.changed_by_name ?? 'Система'}
              </p>
              <pre className="text-[11px] mt-2 whitespace-pre-wrap break-all" style={{ color: '#374151' }}>
                {JSON.stringify(entry.changes, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Опции статусов ───────────────────────────────────────────────────────────

// 'Перезаписанный' — системный статус (ставит только RPC перезаписи), поэтому НЕ в ручном
// списке. Остаётся валидным в CHECK/zod/CONSULTATION_STATUS_MAP для отображения бейджем.
const STATUSES_INITIAL  = ['Придёт', 'Не придёт', 'Перезапись', 'Отменил', 'Не отвечает'] as const
const STATUSES_ALB      = ['Не записан', 'Записан', 'Пришёл', 'Не пришёл', 'Купил'] as const
const STATUSES_ACTUAL   = ['Пришла', 'Не пришла'] as const
const STATUSES_AFTER_FV = ['Купила', 'Не купила', 'Предоплата', 'Дожать', 'Отказ'] as const
const FORMATS           = ['Онлайн', 'Офлайн'] as const

// ─── Телефон: маска +996 (XXX) XXX-XXX ───────────────────────────────────────

function applyPhoneMask(raw: string): string {
  // Оставляем только цифры
  const digits = raw.replace(/\D/g, '')
  // Убираем ведущий 996 если вдруг вставили полный номер
  const local = digits.startsWith('996') ? digits.slice(3) : digits
  const d = local.slice(0, 9)

  if (!d.length)  return ''
  if (d.length <= 3)  return `+996 (${d}`
  if (d.length <= 6)  return `+996 (${d.slice(0, 3)}) ${d.slice(3)}`
  return `+996 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

function rawPhoneDigits(formatted: string): string {
  return formatted.replace(/\D/g, '').replace(/^996/, '')
}

// ─── Имя клиента: только буквы (кирилл/лат/кырг), пробел, дефис ──────────────

function filterClientName(value: string): string {
  // Разрешаем: буквы Юникода (\p{L}), пробел, дефис
  return value.replace(/[^\p{L}\s\-]/gu, '')
}

// ─── Деньги: форматирование с разделителями тысяч ────────────────────────────

function formatMoneyInput(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return Number(digits).toLocaleString('ru-RU')
}

function parseMoneyInput(formatted: string): number {
  return parseInt(formatted.replace(/\s/g, '').replace(/\D/g, ''), 10) || 0
}

// ─── Типы ─────────────────────────────────────────────────────────────────────

interface FormState {
  date:              string
  time:              string
  client_name:       string
  phone:             string   // хранится в отформатированном виде
  deal_number:       string
  format:            string
  manager_id:        string
  status:            string
  alb_status:        string
  actual_status:     string
  status_after_fv:   string
  amount:            string   // отформатированная строка
  delivery_cost:     string
  is_nv:             boolean
  is_returning_customer: boolean
  source:            string   // источник обращения (атрибуция)
  partner_id:        string   // партнёр (только при source='partner')
  comment:           string
  consulting_doctor: string
  rebook_date:       string   // новая дата при статусе "Перезапись"
  rebook_time:       string   // новое время при статусе "Перезапись"
}

interface Props {
  consultation: Consultation | null
  isNew:        boolean
  employees:    Pick<Employee, 'id' | 'name'>[]
  partners?:    PartnerOption[]   // справочник партнёров для атрибуции
  defaultDate?: string   // для новой записи — дата текущего дня
  onClose:      () => void
  onSave:       () => void
}

// ─── Компонент ────────────────────────────────────────────────────────────────

export default function ConsultationModal({
  consultation, isNew, employees, partners = [], defaultDate, onClose, onSave,
}: Props) {
  const { user } = useAuth()
  const canViewHistory = !isNew && (user?.role === 'owner' || user?.role === 'rop')
  const [isPending, startTransition] = useTransition()
  const [isDeleting, setIsDeleting]  = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const init = (consultation?: Consultation | null): FormState => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().slice(0, 10)
    return {
      date:              consultation?.date ?? defaultDate ?? new Date().toISOString().slice(0, 10),
      time:              consultation?.time?.slice(0, 5) ?? '10:00',
      client_name:       consultation?.client_name ?? '',
      phone:             consultation?.phone ? applyPhoneMask(consultation.phone) : '',
      deal_number:       consultation?.deal_number ?? '',
      format:            consultation?.format ?? '',
      manager_id:        consultation?.manager_id ?? '',
      status:            consultation?.status ?? '',
      alb_status:        consultation?.alb_status ?? '',
      actual_status:     consultation?.actual_status ?? '',
      status_after_fv:   consultation?.status_after_fv ?? '',
      amount:            consultation?.amount ? formatMoneyInput(String(consultation.amount)) : '',
      delivery_cost:     consultation?.delivery_cost ? formatMoneyInput(String(consultation.delivery_cost)) : '',
      is_nv:             consultation?.is_nv ?? true,
      is_returning_customer: consultation?.is_returning_customer ?? false,
      source:            consultation?.source ?? 'other',
      partner_id:        consultation?.partner_id ?? '',
      comment:           consultation?.comment ?? '',
      consulting_doctor: consultation?.consulting_doctor ?? '',
      rebook_date:       tomorrowStr,
      rebook_time:       '10:00',
    }
  }

  const [form, setForm] = useState<FormState>(() => init(consultation))
  const set = (field: keyof FormState, value: string | boolean | null) =>
    setForm(f => ({ ...f, [field]: value ?? '' }))

  // ── Построение payload ────────────────────────────────────────────────────
  const buildPayload = (): ConsultationFormData => ({
    date:              form.date,
    time:              form.time,
    client_name:       form.client_name.trim(),
    phone:             form.phone || null,
    deal_number:       form.deal_number || null,
    format:            (form.format as ConsultationFormData['format']) || null,
    manager_id:        form.manager_id || null,
    status:            (form.status as ConsultationFormData['status']) || null,
    alb_status:        (form.alb_status as ConsultationFormData['alb_status']) || null,
    actual_status:     (form.actual_status as ConsultationFormData['actual_status']) || null,
    status_after_fv:   (form.status_after_fv as ConsultationFormData['status_after_fv']) || null,
    amount:            parseMoneyInput(form.amount),
    delivery_cost:     parseMoneyInput(form.delivery_cost),
    is_nv:             form.is_nv,
    is_returning_customer: form.is_returning_customer,
    source:            (form.source as ConsultationFormData['source']) || 'other',
    partner_id:        form.source === 'partner' ? (form.partner_id || null) : null,
    comment:           form.comment || null,
    consulting_doctor: form.consulting_doctor || null,
  })

  // ── Сохранение ────────────────────────────────────────────────────────────
  const handleSave = () => {
    if (!form.client_name.trim()) { toast.error('Укажите имя клиента'); return }
    if (form.status_after_fv === 'Отказ' && !form.comment.trim()) {
      toast.error('При статусе «Отказ» комментарий обязателен')
      return
    }
    if (form.source === 'partner' && !form.partner_id) {
      toast.error('Выберите партнёра для источника «Партнёр»')
      return
    }
    // Перезапись срабатывает ТОЛЬКО при ПЕРЕХОДЕ в 'Перезапись' (раньше статус был иным).
    // Повторное сохранение уже-перезаписанной записи — это обычное обновление, а не новый
    // перенос (иначе плодятся дубли). Серверная RPC дополнительно защищает от повтора/гонок
    // (FOR UPDATE + rescheduled_to_id IS NULL).
    const isRebook = !isNew && form.status === 'Перезапись' && consultation?.status !== 'Перезапись'

    if (isRebook) {
      if (!form.rebook_date) { toast.error('Укажите новую дату'); return }
      if (!form.rebook_time) { toast.error('Укажите новое время'); return }
    }
    startTransition(async () => {
      const payload = buildPayload()

      let result
      if (isRebook) {
        result = await rebookConsultation(
          consultation!.id,
          form.rebook_date,
          form.rebook_time,
          payload,
        )
      } else {
        result = isNew
          ? await createConsultation(payload)
          : await updateConsultation(consultation!.id, payload)
      }

      if (result.success) {
        toast.success(
          isRebook
            ? 'Перезапись выполнена, новая запись создана'
            : isNew ? 'Запись добавлена' : 'Изменения сохранены'
        )
        onSave()
      } else {
        toast.error(result.error)
      }
    })
  }

  // ── Удаление ──────────────────────────────────────────────────────────────
  const handleDelete = () => {
    if (!consultation || !confirm('Удалить эту запись?')) return
    setIsDeleting(true)
    deleteConsultation(consultation.id).then(result => {
      if (result.success) { toast.success('Запись удалена'); onSave() }
      else { toast.error(result.error); setIsDeleting(false) }
    })
  }

  // ── Стили ─────────────────────────────────────────────────────────────────
  const inp = 'h-9 rounded-xl border-gray-200 text-sm focus-visible:ring-1 focus-visible:ring-[#0c4d6c] focus-visible:border-[#0c4d6c]'
  const sel = `${inp} w-full`

  const sectionTitle = (text: string) => (
    <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: '#a2b4c0' }}>
      {text}
    </p>
  )

  return (
    <Modal onClose={onClose}>
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col relative"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {showHistory && consultation && (
          <AuditLogPanel consultationId={consultation.id} onClose={() => setShowHistory(false)} />
        )}
        {/* ── Шапка ──────────────────────────────────────────────────────── */}
        <div
          className="flex items-center gap-4 px-6 py-4 rounded-t-3xl shrink-0"
          style={{ background: 'linear-gradient(135deg, #0c4d6c 0%, #0c2136 100%)' }}
        >
          <div
            className="flex items-center justify-center w-10 h-10 rounded-2xl font-bold text-white shrink-0"
            style={{ backgroundColor: 'rgba(255,255,255,0.2)', fontSize: 16 }}
          >
            {form.client_name ? form.client_name.charAt(0).toUpperCase() : '📋'}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-white text-base leading-tight">
              {isNew ? 'Новая запись' : 'Редактировать запись'}
            </h2>
            <p className="text-[12px] truncate" style={{ color: 'rgba(255,255,255,0.6)', marginTop: 1 }}>
              {form.client_name || 'Введите данные клиента'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl transition-colors shrink-0"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.15)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; e.currentTarget.style.background = 'transparent' }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* ── Тело (скролл без полосы) ────────────────────────────────────── */}
        <div className="scroll-hidden flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* ── Блок: Запись ─────────────────────────────────────────────── */}
          {sectionTitle('Запись')}
          <div className="grid grid-cols-2 gap-3">

            {/* Дата */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Дата *</Label>
              <input
                type="date"
                value={form.date}
                onChange={e => set('date', e.target.value)}
                className={`${inp} w-full px-3 bg-white cursor-pointer`}
                style={{ colorScheme: 'light' }}
              />
            </div>

            {/* Время */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Время *</Label>
              <Input
                type="time"
                value={form.time}
                onChange={e => set('time', e.target.value)}
                className={inp}
              />
            </div>

            {/* Формат */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Формат</Label>
              <Select value={form.format} onValueChange={v => set('format', v)}>
                <SelectTrigger className={sel}><SelectValue>{form.format || '—'}</SelectValue></SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {FORMATS.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Номер сделки */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Номер сделки</Label>
              <Input
                value={form.deal_number}
                onChange={e => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 7)
                  set('deal_number', digits ? `#${digits}` : '')
                }}
                placeholder="#1234567"
                maxLength={8}
                inputMode="numeric"
                className={inp}
              />
            </div>

            {/* Источник обращения (атрибуция канала) */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Источник</Label>
              <Select value={form.source} onValueChange={v => { set('source', v); if (v !== 'partner') set('partner_id', '') }}>
                <SelectTrigger className={sel}><SelectValue>{CONSULTATION_SOURCE_LABELS[form.source] ?? '—'}</SelectValue></SelectTrigger>
                <SelectContent className="z-[99999]">
                  {CONSULTATION_SOURCE_ORDER.map(s => <SelectItem key={s} value={s}>{CONSULTATION_SOURCE_LABELS[s]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Партнёр — только при источнике «Партнёр» */}
            {form.source === 'partner' && (
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-500">Партнёр *</Label>
                {partners.length === 0 ? (
                  <p className="text-xs text-gray-400 h-9 flex items-center">Нет партнёров — добавьте на вкладке «Партнёры»</p>
                ) : (
                  <Select value={form.partner_id} onValueChange={v => set('partner_id', v)}>
                    <SelectTrigger className={sel}>
                      <SelectValue>{partners.find(p => p.id === form.partner_id)?.name ?? '— выберите —'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-[99999]">
                      {partners.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>

          {/* ── Блок: Клиент ─────────────────────────────────────────────── */}
          {sectionTitle('Клиент')}
          <div className="grid grid-cols-2 gap-3">

            {/* Имя — только буквы, пробел, дефис */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Имя клиента *</Label>
              <Input
                value={form.client_name}
                onChange={e => set('client_name', filterClientName(e.target.value))}
                placeholder="Имя Фамилия"
                className={inp}
              />
            </div>

            {/* Телефон: маска +996 (XXX) XXX-XXX */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Телефон</Label>
              <Input
                value={form.phone}
                inputMode="tel"
                placeholder="+996 (XXX) XXX-XXX"
                className={`${inp} tabular-nums`}
                onChange={e => {
                  const digits = rawPhoneDigits(e.target.value)
                  set('phone', digits ? applyPhoneMask(e.target.value) : '')
                }}
                onKeyDown={e => {
                  // Не даём стереть префикс +996 (
                  const inp = e.currentTarget
                  if ((e.key === 'Backspace' || e.key === 'Delete') && inp.selectionStart !== null && inp.selectionStart <= 6) {
                    e.preventDefault()
                  }
                }}
                onFocus={() => { if (!form.phone) set('phone', '+996 (') }}
                onBlur={() => {
                  // Если введено меньше 9 цифр — очищаем
                  if (rawPhoneDigits(form.phone).length < 9) set('phone', '')
                }}
              />
            </div>

            {/* Менеджер — на всю ширину */}
            <div className="col-span-2 space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Менеджер</Label>
              <Select value={form.manager_id} onValueChange={v => set('manager_id', v)}>
                <SelectTrigger className={sel}>
                  <SelectValue>{employees.find(e => e.id === form.manager_id)?.name || '—'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {employees.map(e => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Блок: Статусы ────────────────────────────────────────────── */}
          {sectionTitle('Статусы')}
          <div className="grid grid-cols-2 gap-3">

            {/* Статус консультации */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Статус консультации</Label>
              <Select value={form.status} onValueChange={v => set('status', v)}>
                <SelectTrigger className={sel}><SelectValue>{form.status || '—'}</SelectValue></SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {STATUSES_INITIAL.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Статус ALB */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Статус ALB</Label>
              <Select value={form.alb_status} onValueChange={v => set('alb_status', v)}>
                <SelectTrigger className={sel}><SelectValue>{form.alb_status || '—'}</SelectValue></SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {STATUSES_ALB.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Статус ФВ */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Статус ФВ</Label>
              <Select value={form.actual_status} onValueChange={v => set('actual_status', v)}>
                <SelectTrigger className={sel}><SelectValue>{form.actual_status || '—'}</SelectValue></SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {STATUSES_ACTUAL.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Статус после ФВ */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Статус после ФВ</Label>
              <Select value={form.status_after_fv} onValueChange={v => set('status_after_fv', v)}>
                <SelectTrigger
                  className={sel}
                  style={form.status_after_fv === 'Отказ' ? { borderColor: '#fca5a5', color: '#dc2626' } : {}}
                >
                  <SelectValue>{form.status_after_fv || '—'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {STATUSES_AFTER_FV.map(s => (
                    <SelectItem key={s} value={s} className={s === 'Отказ' ? 'text-red-600 font-medium' : ''}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Блок «Новая запись» — появляется при статусе «Перезапись» и только при редактировании */}
          {!isNew && form.status === 'Перезапись' && (
            <div className="p-4 rounded-2xl space-y-3" style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#92400e' }}>
                Новая запись — укажи дату и время
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-gray-500">Новая дата *</Label>
                  <input
                    type="date"
                    value={form.rebook_date}
                    onChange={e => set('rebook_date', e.target.value)}
                    className={`${inp} w-full px-3 bg-white cursor-pointer`}
                    style={{ colorScheme: 'light' }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-gray-500">Новое время *</Label>
                  <input
                    type="time"
                    value={form.rebook_time}
                    onChange={e => set('rebook_time', e.target.value)}
                    className={`${inp} w-full px-3 bg-white cursor-pointer`}
                  />
                </div>
              </div>
              <p className="text-xs" style={{ color: '#92400e' }}>
                Текущая запись сохранится со статусом «Перезапись». Будет создана новая запись на выбранную дату.
              </p>
            </div>
          )}

          {/* Причина отказа — появляется если выбран «Отказ» */}
          {form.status_after_fv === 'Отказ' && (
            <div className="p-3 rounded-xl" style={{ backgroundColor: '#fff8f8', border: '1px solid #fecaca' }}>
              <Label className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#dc2626' }}>
                Причина отказа *
              </Label>
              <textarea
                className="mt-1.5 w-full text-sm rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-red-400"
                style={{ border: '1px solid #fca5a5', background: '#fff' }}
                rows={2}
                placeholder="Обязательно укажи причину..."
                value={form.comment}
                onChange={e => set('comment', e.target.value)}
              />
            </div>
          )}

          {/* ── Блок: Финансы ────────────────────────────────────────────── */}
          {sectionTitle('Финансы')}
          <div className="grid grid-cols-2 gap-3">

            {/* Сумма покупки */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Сумма покупки (KGS)</Label>
              <Input
                value={form.amount}
                inputMode="numeric"
                placeholder="0"
                className={`${inp} tabular-nums`}
                onFocus={e => {
                  // При фокусе очищаем если 0
                  if (form.amount === '0') set('amount', '')
                  e.target.select()
                }}
                onChange={e => {
                  const only = e.target.value.replace(/\D/g, '')
                  set('amount', only ? formatMoneyInput(only) : '')
                }}
                onBlur={() => {
                  if (!form.amount) set('amount', '')
                }}
              />
            </div>

            {/* Расходы доставки */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Расходы доставки (KGS)</Label>
              <Input
                value={form.delivery_cost}
                inputMode="numeric"
                placeholder="0"
                className={`${inp} tabular-nums`}
                onFocus={e => {
                  if (form.delivery_cost === '0') set('delivery_cost', '')
                  e.target.select()
                }}
                onChange={e => {
                  const only = e.target.value.replace(/\D/g, '')
                  set('delivery_cost', only ? formatMoneyInput(only) : '')
                }}
                onBlur={() => {
                  if (!form.delivery_cost) set('delivery_cost', '')
                }}
              />
            </div>
          </div>

          {/* ── Блок: Дополнительно ──────────────────────────────────────── */}
          {sectionTitle('Дополнительно')}
          <div className="space-y-3">

            {/* Чекбокс «Без предварительной записи»: отмечен ⇔ is_nv = false */}
            <label
              htmlFor="is_nv"
              className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors"
              style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a' }}
            >
              <input
                type="checkbox"
                id="is_nv"
                checked={!form.is_nv}
                onChange={e => set('is_nv', !e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                style={{ accentColor: '#f59e0b' }}
              />
              <span className="text-sm font-medium select-none" style={{ color: '#92400e' }}>
                Без предварительной записи — случайный посетитель, зашёл без записи
              </span>
            </label>

            {/* Чекбокс «Постоянный клиент» (миграция 048). На расчёт факта не влияет:
                продажи и выручка считаются как обычно. Нужен для статистики
                повторных покупок в блоке на экране менеджера продаж. */}
            <label
              htmlFor="is_returning_customer"
              className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors"
              style={{ backgroundColor: '#e2eef4', border: '1px solid #b9d4e2' }}
            >
              <input
                type="checkbox"
                id="is_returning_customer"
                checked={form.is_returning_customer}
                onChange={e => set('is_returning_customer', e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                style={{ accentColor: '#0c4d6c' }}
              />
              <span className="text-sm font-medium select-none" style={{ color: '#0c4d6c' }}>
                Постоянный клиент — покупал у нас раньше
              </span>
            </label>

            {/* Консультировал */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Консультировал</Label>
              <Input
                value={form.consulting_doctor}
                onChange={e => set('consulting_doctor', e.target.value)}
                placeholder="Имя специалиста"
                className={inp}
              />
            </div>

            {/* Комментарий (скрыт если выбран «Отказ» — там отдельное поле) */}
            {form.status_after_fv !== 'Отказ' && (
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-500">Комментарий</Label>
                <Textarea
                  value={form.comment}
                  onChange={e => set('comment', e.target.value)}
                  rows={2}
                  className="rounded-xl border-gray-200 resize-none text-sm focus-visible:ring-1 focus-visible:ring-[#0c4d6c] focus-visible:border-[#0c4d6c]"
                  placeholder="Заметки по записи..."
                />
              </div>
            )}
          </div>
        </div>

        {/* ── Подвал ──────────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0 rounded-b-3xl"
          style={{ borderTop: '1px solid #ebebee', backgroundColor: '#fafafa' }}
        >
          <div className="flex gap-2">
            {canViewHistory && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowHistory(true)}
                className="rounded-xl text-xs h-8 px-3 border-gray-200"
                style={{ color: '#0c4d6c' }}
              >
                <History style={{ width: 13, height: 13, marginRight: 5 }} />
                История
              </Button>
            )}
            {!isNew && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={isDeleting}
                className="rounded-xl text-xs h-8 px-3"
              >
                <Trash2 style={{ width: 13, height: 13, marginRight: 5 }} />
                {isDeleting ? 'Удаление...' : 'Удалить'}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-9 rounded-xl px-4 text-sm border-gray-200"
              style={{ color: '#6b7280' }}
            >
              Отмена
            </Button>
            <Button
              onClick={handleSave}
              disabled={isPending}
              className="h-9 rounded-xl px-5 font-semibold text-sm text-white"
              style={{ backgroundColor: '#0c4d6c' }}
            >
              {isPending ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
