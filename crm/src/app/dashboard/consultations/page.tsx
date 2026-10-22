'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/contexts/AuthContext'
import type { Consultation, Employee } from '@/types'
import {
  CONSULTATION_STATUS_MAP,
  ALB_STATUS_MAP,
  ACTUAL_STATUS_MAP,
  STATUS_AFTER_FV_MAP,
  FORMAT_BADGE_MAP,
} from '@/lib/constants'
import { formatTime, formatMoney } from '@/lib/formatters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Search, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import ConsultationModal from '@/components/ConsultationModal'
import { getActivePartners, type PartnerOption } from '@/actions/partners'

// ─── Хелперы дат ──────────────────────────────────────────────────────────────

function toLocalISO(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDayLabel(date: Date): string {
  const today = toLocalISO(new Date())
  const iso   = toLocalISO(date)
  if (iso === today) return 'Сегодня'
  const yesterday = toLocalISO(new Date(Date.now() - 86400000))
  if (iso === yesterday) return 'Вчера'
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Короткая дата DD.MM из ISO 'YYYY-MM-DD' — для колонки «Перенос».
function shortDate(iso: string): string {
  const parts = iso.split('-')
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : iso
}

// ─── Бейдж статуса ────────────────────────────────────────────────────────────

function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap"
      style={{ backgroundColor: bg, color }}
    >
      {label}
    </span>
  )
}

// ─── Компонент страницы ───────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function ConsultationsPage() {
  const { user: employee } = useAuth()
  const supabase = useMemo(() => createClient(), [])

  const [consultations, setConsultations] = useState<Consultation[]>([])
  const [employees, setEmployees]         = useState<Pick<Employee, 'id' | 'name'>[]>([])
  const [partners, setPartners]           = useState<PartnerOption[]>([])
  const [loading, setLoading]             = useState(false)
  const [currentDate, setCurrentDate]     = useState<Date>(() => new Date())

  // Фильтры
  const [search,        setSearch]        = useState('')
  const [filterStatus,  setFilterStatus]  = useState<string>('')
  const [filterManager, setFilterManager] = useState<string>('')
  const [page, setPage]                   = useState(0)

  const dateInputRef = useRef<HTMLInputElement>(null)

  // Modal
  const [selectedConsultation, setSelectedConsultation] = useState<Consultation | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [isNew,     setIsNew]     = useState(false)

  const canEdit = employee?.role === 'owner' || employee?.role === 'rop'
    || employee?.role === 'mp' || employee?.role === 'lmai'

  // ── Загрузка за один день ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const iso = toLocalISO(currentDate)

    const run = async () => {
      setLoading(true)
      const query = supabase
        .from('consultations')
        .select('*, manager:employees!consultations_manager_id_fkey(id, name)')
        .eq('date', iso)
        .is('deleted_at', null)
        .order('time', { ascending: true })

      // По бизнес-правилу «клиент общий» менеджеры (mp/lmai) видят ВСЕ записи, а не только свои
      // (permissions.consultations.scope='all'). Видимость обеспечивает RLS (057): фильтр по
      // manager_id здесь убран, чтобы UI соответствовал праву. owner/rop — как раньше (RLS: all/team).

      const [{ data: cons, error }, { data: emps }] = await Promise.all([
        query,
        supabase.from('employees').select('id, name').neq('status', 'archived').order('name'),
      ])

      if (error) { toast.error('Ошибка загрузки данных'); return }

      // Self-join через embed не резолвится PostgREST-хинтами (ambiguous FK на ту же
      // таблицу) — подтягиваем связанные rescheduled_to/from отдельным batch-запросом.
      const rows = (cons as unknown as Consultation[]) ?? []
      const relatedIds = Array.from(new Set(
        rows.flatMap(r => [r.rescheduled_to_id, r.rescheduled_from_id]).filter((id): id is string => !!id),
      ))
      let relatedById = new Map<string, { id: string; date: string; time: string | null }>()
      if (relatedIds.length > 0) {
        const { data: related } = await supabase
          .from('consultations')
          .select('id, date, time')
          .in('id', relatedIds)
        relatedById = new Map((related ?? []).map(r => [r.id as string, r as { id: string; date: string; time: string | null }]))
      }
      const withRelations = rows.map(r => ({
        ...r,
        rescheduled_to: r.rescheduled_to_id ? relatedById.get(r.rescheduled_to_id) ?? null : null,
        rescheduled_from: r.rescheduled_from_id ? relatedById.get(r.rescheduled_from_id) ?? null : null,
      }))

      if (!cancelled) {
        setConsultations(withRelations)
        setEmployees((emps as Pick<Employee, 'id' | 'name'>[]) ?? [])
        setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [currentDate, supabase, employee])

  // Справочник партнёров для атрибуции (source='partner') — грузим один раз
  useEffect(() => {
    let cancelled = false
    getActivePartners().then(list => { if (!cancelled) setPartners(list) })
    return () => { cancelled = true }
  }, [])

  // ── Клиентская фильтрация ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return consultations.filter((c) => {
      if (q && !(
        c.client_name?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.deal_number?.includes(q)
      )) return false
      if (filterStatus && c.status !== filterStatus) return false
      if (filterManager) {
        const mgr = c.manager as unknown as { id: string; name: string } | null
        if (mgr?.id !== filterManager) return false
      }
      return true
    })
  }, [consultations, search, filterStatus, filterManager])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── Навигация по дням ─────────────────────────────────────────────────────
  const prevDay = () => { setCurrentDate(d => new Date(d.getTime() - 86400000)); setPage(0) }
  const nextDay = () => { setCurrentDate(d => new Date(d.getTime() + 86400000)); setPage(0) }
  const goToday = () => { setCurrentDate(new Date()); setPage(0) }

  const dayLabel = formatDayLabel(currentDate)
  const isToday  = toLocalISO(currentDate) === toLocalISO(new Date())

  // ── Modal handlers ────────────────────────────────────────────────────────
  const handleEdit = (c: Consultation) => { setSelectedConsultation(c); setIsNew(false); setModalOpen(true) }
  const handleNew  = () => { setSelectedConsultation(null); setIsNew(true); setModalOpen(true) }
  const handleModalSave = () => {
    setModalOpen(false)
    setCurrentDate(d => new Date(d))  // триггерим перезагрузку
  }

  const pluralRecords = (n: number) => {
    if (n % 100 >= 11 && n % 100 <= 14) return 'записей'
    switch (n % 10) {
      case 1: return 'запись'
      case 2: case 3: case 4: return 'записи'
      default: return 'записей'
    }
  }

  return (
    <div className="p-6">

      {/* Шапка */}
      <div
        className="-mx-6 -mt-6 px-6 py-4 mb-5 flex items-center justify-between"
        style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #ebebee' }}
      >
        <div>
          <h1 className="font-bold" style={{ fontSize: 18, color: '#0c2136' }}>
            Консультации
          </h1>
          <p style={{ fontSize: 12, color: '#a2b4c0', marginTop: 2 }}>
            {filtered.length} {pluralRecords(filtered.length)} · {dayLabel}
          </p>
        </div>
        {canEdit && (
          <Button
            onClick={handleNew}
            className="text-white rounded-xl font-medium"
            style={{ backgroundColor: '#0c4d6c' }}
          >
            <Plus style={{ width: 16, height: 16, marginRight: 6 }} />
            Новая запись
          </Button>
        )}
      </div>

      {/* Тулбар */}
      <div className="flex flex-wrap items-center gap-3 mb-4">

        {/* Навигация по дням */}
        <div
          className="flex items-center gap-1 rounded-xl px-1 py-1"
          style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb' }}
        >
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={prevDay}>
            <ChevronLeft style={{ width: 16, height: 16 }} />
          </Button>

          {/* Кнопка даты — открывает нативный date picker через showPicker() */}
          <button
            type="button"
            className="flex items-center gap-1.5 px-1 rounded-lg transition-colors hover:bg-gray-100"
            style={{ minWidth: 160 }}
            onClick={() => {
              try {
                dateInputRef.current?.showPicker()
              } catch {
                dateInputRef.current?.click()
              }
            }}
          >
            <span className="font-semibold text-sm" style={{ color: '#0c2136' }}>
              {dayLabel}
            </span>
            <CalendarDays style={{ width: 14, height: 14, color: '#a2b4c0' }} />
          </button>
          <input
            ref={dateInputRef}
            type="date"
            value={toLocalISO(currentDate)}
            onChange={e => {
              if (e.target.value) {
                setCurrentDate(new Date(e.target.value + 'T00:00:00'))
                setPage(0)
              }
            }}
            className="sr-only"
          />

          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={nextDay}>
            <ChevronRight style={{ width: 16, height: 16 }} />
          </Button>
        </div>

        {/* Кнопка «Сегодня» — если не текущий день */}
        {!isToday && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-xl text-xs font-medium"
            style={{ color: '#0c4d6c', borderColor: '#0c4d6c' }}
            onClick={goToday}
          >
            Сегодня
          </Button>
        )}

        {/* Поиск */}
        <div className="relative" style={{ minWidth: 200 }}>
          <Search style={{
            position: 'absolute', left: 12, top: '50%',
            transform: 'translateY(-50%)', width: 15, height: 15, color: '#a2b4c0',
          }} />
          <Input
            className="pl-9 bg-white border-gray-200 h-9 rounded-xl text-sm"
            placeholder="Имя, телефон, сделка..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0) }}
          />
        </div>

        {/* Фильтр по статусу */}
        <Select value={filterStatus} onValueChange={v => { setFilterStatus(v ?? ''); setPage(0) }}>
          <SelectTrigger className="h-9 rounded-xl border-gray-200 bg-white text-sm" style={{ minWidth: 150 }}>
            <SelectValue>
              {filterStatus
                ? (CONSULTATION_STATUS_MAP[filterStatus as keyof typeof CONSULTATION_STATUS_MAP]?.label ?? filterStatus)
                : 'Все статусы'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Все статусы</SelectItem>
            {Object.entries(CONSULTATION_STATUS_MAP).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Фильтр по менеджеру */}
        {(employee?.role === 'owner' || employee?.role === 'rop') && (
          <Select value={filterManager} onValueChange={v => { setFilterManager(v ?? ''); setPage(0) }}>
            <SelectTrigger className="h-9 rounded-xl border-gray-200 bg-white text-sm" style={{ minWidth: 160 }}>
              <SelectValue>
                {filterManager
                  ? (employees.find(e => e.id === filterManager)?.name ?? filterManager)
                  : 'Все менеджеры'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Все менеджеры</SelectItem>
              {employees.map(e => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        <div className="text-xs ml-auto" style={{ color: '#a2b4c0' }}>
          {filtered.length} {pluralRecords(filtered.length)}
        </div>
      </div>

      {/* Таблица */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ border: '1px solid #ebebee', backgroundColor: '#ffffff' }}
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="w-full" style={{ fontSize: 13, minWidth: 1100 }}>
            <thead style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #ebebee' }}>
              <tr>
                {[
                  'Время', 'Клиент', 'Телефон', 'Сделка', 'Формат',
                  'Менеджер', 'Статус', 'Перенос', 'Статус ALB', 'Статус ФВ',
                  'После ФВ', 'Сумма', 'Консультировал',
                ].map(h => (
                  <th
                    key={h}
                    className="px-3 py-2.5 text-left font-semibold uppercase tracking-wider whitespace-nowrap"
                    style={{ fontSize: 10, color: '#a2b4c0' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f5f6f8' }}>
                    {[...Array(13)].map((__, j) => (
                      <td key={j} className="px-3 py-2.5">
                        <div className="animate-pulse rounded" style={{ height: 14, backgroundColor: '#f3f4f6', width: j === 1 ? 120 : 60 }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center" style={{ color: '#a2b4c0', fontSize: 14 }}>
                    {search || filterStatus || filterManager
                      ? 'Нет совпадений'
                      : `Записей на ${dayLabel.toLowerCase()} нет`}
                  </td>
                </tr>
              ) : (
                paged.map(c => {
                  const manager    = c.manager as unknown as { id: string; name: string } | null
                  const rebookTo   = c.rescheduled_to   ?? null
                  const rebookFrom = c.rescheduled_from ?? null
                  const statusInfo = c.status       ? CONSULTATION_STATUS_MAP[c.status] : null
                  const albInfo    = c.alb_status   ? ALB_STATUS_MAP[c.alb_status]     : null
                  const fvInfo     = c.actual_status ? ACTUAL_STATUS_MAP[c.actual_status] : null
                  const afterInfo  = c.status_after_fv ? STATUS_AFTER_FV_MAP[c.status_after_fv] : null
                  const fmtInfo    = c.format       ? FORMAT_BADGE_MAP[c.format]        : null

                  return (
                    <tr
                      key={c.id}
                      style={{ borderBottom: '1px solid #f5f6f8', cursor: canEdit ? 'pointer' : 'default' }}
                      onMouseEnter={e => { if (canEdit) e.currentTarget.style.backgroundColor = '#f9fafb' }}
                      onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                      onClick={() => canEdit && handleEdit(c)}
                    >
                      {/* Время */}
                      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums font-medium" style={{ color: '#0c2136' }}>
                        {formatTime(c.time)}
                      </td>

                      {/* Клиент */}
                      <td className="px-3 py-2.5" style={{ maxWidth: 160 }}>
                        <div className="truncate font-medium" style={{ color: '#0c2136' }}>
                          {c.client_name || '—'}
                        </div>
                        {!c.is_nv && (
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: '#fef3c7', color: '#92400e' }}
                          >Без записи</span>
                        )}
                      </td>

                      {/* Телефон */}
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap" style={{ color: '#6b7280', fontSize: 12 }}>
                        {c.phone || '—'}
                      </td>

                      {/* Сделка */}
                      <td className="px-3 py-2.5 tabular-nums" style={{ color: '#6b7280' }}>
                        {c.deal_number || '—'}
                      </td>

                      {/* Формат */}
                      <td className="px-3 py-2.5">
                        {fmtInfo
                          ? <Badge label={fmtInfo.label} color={fmtInfo.color} bg={fmtInfo.bg} />
                          : <span style={{ color: '#a2b4c0' }}>—</span>}
                      </td>

                      {/* Менеджер */}
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#374151' }}>
                        {manager?.name || '—'}
                      </td>

                      {/* Статус консультации */}
                      <td className="px-3 py-2.5">
                        {statusInfo
                          ? <Badge label={statusInfo.label} color={statusInfo.color} bg={statusInfo.bg} />
                          : <span style={{ color: '#a2b4c0' }}>—</span>}
                      </td>

                      {/* Перенос — куда/откуда перенесли */}
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ fontSize: 12 }}>
                        {c.status === 'Перезапись' && rebookTo ? (
                          <span style={{ color: '#0c4d6c', fontWeight: 600 }}>
                            → {shortDate(rebookTo.date)}{rebookTo.time ? `, ${formatTime(rebookTo.time)}` : ''}
                          </span>
                        ) : c.status === 'Перезаписанный' && rebookFrom ? (
                          <span style={{ color: '#a2b4c0' }}>
                            ← с {shortDate(rebookFrom.date)}{rebookFrom.time ? `, ${formatTime(rebookFrom.time)}` : ''}
                          </span>
                        ) : (
                          <span style={{ color: '#a2b4c0' }}>—</span>
                        )}
                      </td>

                      {/* Статус ALB */}
                      <td className="px-3 py-2.5">
                        {albInfo
                          ? <Badge label={albInfo.label} color={albInfo.color} bg={albInfo.bg} />
                          : <span style={{ color: '#a2b4c0' }}>—</span>}
                      </td>

                      {/* Статус ФВ */}
                      <td className="px-3 py-2.5">
                        {fvInfo
                          ? <Badge label={fvInfo.label} color={fvInfo.color} bg={fvInfo.bg} />
                          : <span style={{ color: '#a2b4c0' }}>—</span>}
                      </td>

                      {/* После ФВ */}
                      <td className="px-3 py-2.5">
                        {afterInfo
                          ? <Badge label={afterInfo.label} color={afterInfo.color} bg={afterInfo.bg} />
                          : <span style={{ color: '#a2b4c0' }}>—</span>}
                      </td>

                      {/* Сумма */}
                      <td className="px-3 py-2.5 tabular-nums text-right whitespace-nowrap" style={{
                        color: c.amount > 0 ? '#0c2136' : '#a2b4c0',
                        fontWeight: c.amount > 0 ? 600 : 400,
                      }}>
                        {c.amount > 0 ? formatMoney(c.amount) : '—'}
                      </td>

                      {/* Консультировал */}
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#6b7280', fontSize: 12 }}>
                        {c.consulting_doctor || '—'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Пагинация */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid #ebebee' }}
          >
            <span style={{ fontSize: 13, color: '#a2b4c0' }}>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} из {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg">
                <ChevronLeft style={{ width: 14, height: 14 }} />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded-lg">
                <ChevronRight style={{ width: 14, height: 14 }} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Modal */}
      {modalOpen && (
        <ConsultationModal
          consultation={selectedConsultation}
          isNew={isNew}
          employees={employees}
          partners={partners}
          defaultDate={toLocalISO(currentDate)}
          onClose={() => setModalOpen(false)}
          onSave={handleModalSave}
        />
      )}
    </div>
  )
}
