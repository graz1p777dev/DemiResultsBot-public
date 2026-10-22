'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, ChevronLeft, ChevronRight, Filter, Plus, Search, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import type { Deal, DealEmployee, DealPipeline, DealStage } from '@/types'
import { getDealsData, moveDeal, updateStageGuidance } from '@/actions/deals'
import { stageGuidance, stageSoft } from './deal-config'
import DealCard from './DealCard'
import DealSheet from './DealSheet'
import { dealOpenTarget, sortDeals, type DealSort } from './deal-view'

const INITIAL_COLUMN_LIMIT = 80
const control = 'h-9 rounded-xl border border-[#cddde5] bg-white px-3 text-xs font-semibold text-[#075a78] outline-none'

function isOverdue(deal: Deal) {
  if (!deal.next_task_at) return false
  const value = deal.next_task_at.length === 10 ? `${deal.next_task_at}T23:59:59` : deal.next_task_at
  return new Date(value).getTime() < Date.now()
}

function searchable(deal: Deal) {
  return [deal.title, deal.customer_name, deal.customer_phone, deal.customer_username,
    deal.client_first_name, deal.client_last_name, deal.client_city,
    deal.client_instagram_username, deal.client_telegram_username, deal.client_whatsapp_id,
    deal.id, deal.client_id, deal.amocrm_lead_id, deal.responsible_name,
    ...(deal.tags ?? []).map(tag => tag.name)].filter(Boolean).join(' ').toLocaleLowerCase('ru')
}

export default function DealsBoard({ initialPipelines, initialStages, initialDeals, employees: initialEmployees, viewerId, canManageStages, pipelineCode }: { initialPipelines: DealPipeline[]; initialStages: DealStage[]; initialDeals: Deal[]; employees: DealEmployee[]; viewerId: string; canViewAll: boolean; canManageStages: boolean; pipelineCode: 'new-sales' | 'repeat-sales' }) {
  const router = useRouter()
  const [pipelines, setPipelines] = useState(initialPipelines)
  const [stages, setStages] = useState(initialStages)
  const [deals, setDeals] = useState(initialDeals)
  const [employees, setEmployees] = useState(initialEmployees)
  const [loadingInitial, setLoadingInitial] = useState(initialPipelines.length === 0)
  const [loadError, setLoadError] = useState(false)
  const [search, setSearch] = useState('')
  const [assignment, setAssignment] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [employeeId, setEmployeeId] = useState('')
  const [stageId, setStageId] = useState('')
  const [tagId, setTagId] = useState('')
  const [source, setSource] = useState('')
  const [deadline, setDeadline] = useState<'all' | 'overdue' | 'current'>('all')
  const [taskMode, setTaskMode] = useState<'all' | 'with' | 'without' | 'without-next'>('all')
  const [attention, setAttention] = useState<'all' | 'attention' | 'urgent'>('all')
  const [city, setCity] = useState('')
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [view, setView] = useState<'active' | 'won' | 'lost'>('active')
  const [sort, setSort] = useState<DealSort>('updated-desc')
  const [dragId, setDragId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const [overStage, setOverStage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Deal | 'new' | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const boardRef = useRef<HTMLElement | null>(null)

  const refresh = useCallback(async () => {
    const data = await getDealsData(pipelineCode)
    setPipelines(data.pipelines); setStages(data.stages); setDeals(data.deals)
    setEmployees(data.employees)
    setLoadError(false)
  }, [pipelineCode])

  useEffect(() => {
    if (!loadingInitial) return
    void refresh()
      .catch(() => { setLoadError(true); toast.error('Не удалось загрузить сделки') })
      .finally(() => setLoadingInitial(false))
  }, [loadingInitial, refresh])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setSearch(params.get('q') ?? '')
    setHighlighted(params.get('highlight'))
  }, [])

  useEffect(() => {
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const channel = supabase.channel('deals-board').on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => {
      if (dragIdRef.current) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh().catch(() => toast.error('Не удалось обновить сделки. Показаны последние загруженные данные.')), 350)
    }).subscribe()
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(channel) }
  }, [refresh])

  useEffect(() => {
    if (!highlighted) return
    const timer = window.setTimeout(() => document.querySelector(`[data-deal-id="${CSS.escape(highlighted)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }), 250)
    const clear = window.setTimeout(() => setHighlighted(null), 3250)
    return () => { window.clearTimeout(timer); window.clearTimeout(clear) }
  }, [highlighted, deals])

  const pipeline = pipelines.find(item => item.code === pipelineCode)
  const pipelineId = pipeline?.id ?? ''
  const pipelineStages = useMemo(() => stages.filter(stage => stage.pipeline_id === pipelineId), [pipelineId, stages])
  const tags = useMemo(() => Array.from(new Map(deals.flatMap(deal => deal.tags ?? []).map(tag => [tag.id, tag])).values()), [deals])
  const cities = useMemo(() => Array.from(new Set(deals.map(deal => deal.client_city).filter(Boolean) as string[])).sort(), [deals])
  const activeFilters = [assignment !== 'all', employeeId, stageId, tagId, source, deadline !== 'all', taskMode !== 'all', attention !== 'all', city, createdFrom, createdTo].filter(Boolean).length

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ru')
    const qDigits = q.replace(/\D/g, '')
    return deals.filter(deal => {
      if (deal.pipeline_id !== pipelineId) return false
      if (assignment === 'mine' && deal.responsible_employee_id !== viewerId) return false
      if (assignment === 'unassigned' && deal.responsible_employee_id) return false
      if (employeeId && deal.responsible_employee_id !== employeeId) return false
      if (stageId && deal.stage_id !== stageId) return false
      if (tagId && !(deal.tags ?? []).some(tag => tag.id === tagId)) return false
      if (source && deal.source !== source) return false
      if (deadline === 'overdue' && !isOverdue(deal)) return false
      if (deadline === 'current' && isOverdue(deal)) return false
      if (taskMode === 'with' && !deal.has_open_tasks) return false
      if (taskMode === 'without' && deal.has_open_tasks) return false
      if (taskMode === 'without-next' && deal.next_task_at) return false
      if (attention === 'urgent' && !deal.is_urgent) return false
      if (attention === 'attention' && !(deal.sla_due_at && new Date(deal.sla_due_at).getTime() < Date.now())) return false
      if (city && deal.client_city !== city) return false
      if (createdFrom && deal.created_at.slice(0, 10) < createdFrom) return false
      if (createdTo && deal.created_at.slice(0, 10) > createdTo) return false
      if (!q) return true
      const haystack = searchable(deal)
      return haystack.includes(q) || Boolean(qDigits && haystack.replace(/\D/g, '').includes(qDigits))
    })
  }, [assignment, attention, city, createdFrom, createdTo, deadline, deals, employeeId, pipelineId, search, source, stageId, tagId, taskMode, viewerId])

  const visibleStages = useMemo(() => pipelineStages.filter(stage => (
    view === 'active' ? stage.kind === 'normal' : stage.kind === view
  )), [pipelineStages, view])

  const viewFiltered = useMemo(() => filtered.filter(deal => {
    if (view === 'active') return deal.status === 'open'
    return deal.status === view
  }), [filtered, view])

  const byStage = useMemo(() => {
    const result = new Map<string, Deal[]>()
    visibleStages.forEach(stage => result.set(stage.id, []))
    sortDeals(viewFiltered, sort).forEach(deal => result.get(deal.stage_id)?.push(deal))
    return result
  }, [sort, viewFiltered, visibleStages])

  const resetFilters = () => {
    setAssignment('all'); setEmployeeId(''); setStageId(''); setTagId(''); setSource('')
    setDeadline('all'); setTaskMode('all'); setAttention('all'); setCity(''); setCreatedFrom(''); setCreatedTo('')
  }

  const editStageGuidance = async (stage: DealStage) => {
    const next = window.prompt(`Подсказка менеджеру на этапе «${stage.name}». Оставьте поле пустым, чтобы вернуть стандартную подсказку.`, stage.guidance ?? stageGuidance(stage) ?? '')
    if (next === null) return
    const result = await updateStageGuidance(stage.id, next)
    if (!result.success) { toast.error(result.error); return }
    setStages(current => current.map(item => item.id === stage.id ? { ...item, guidance: result.data.guidance } : item))
    toast.success('Подсказка этапа сохранена')
  }

  const drop = async (targetStageId: string) => {
    const id = dragId
    dragIdRef.current = null; setDragId(null); setOverStage(null)
    if (!id) return
    const deal = deals.find(item => item.id === id)
    if (!deal || deal.stage_id === targetStageId) return
    const snapshot = deals
    setDeals(current => current.map(item => item.id === id ? { ...item, stage_id: targetStageId, stage_changed_at: new Date().toISOString() } : item))
    const result = await moveDeal(id, targetStageId)
    if (!result.success) { setDeals(snapshot); toast.error(result.error) } else toast.success('Этап сделки изменён')
  }

  return (
    <div data-dark-blue-surfaces className="flex min-h-[calc(100vh-72px)] flex-col bg-[#f4f8fa]">
      <header className="border-b border-[#dbe8ee] bg-white px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#1784a6]">CRM · Воронка продаж</p><h1 className="mt-1 text-2xl font-bold text-[#092a42]">{pipeline?.name ?? (pipelineCode === 'repeat-sales' ? 'Повторные продажи' : 'Новые продажи')}</h1><p className="mt-1 text-sm text-slate-500">{loadingInitial ? 'Загружаю всю воронку…' : loadError ? 'Данные временно недоступны' : `${viewFiltered.length} сделок`}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setSelected('new')} className={`${control} inline-flex items-center gap-2`}><Plus size={15}/> Новая сделка</button>
            <label className="relative"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Имя, телефон, Instagram, ID, тег…" className="h-9 w-72 rounded-xl border border-[#cddde5] bg-[#f9fcfd] pl-9 pr-3 text-xs text-[#092a42] outline-none focus:border-[#1784a6]"/></label>
            <button onClick={() => setFiltersOpen(value => !value)} className={cn(control, 'inline-flex items-center gap-2', (filtersOpen || activeFilters) && 'border-[#1784a6] bg-[#eaf4f8]')}><Filter size={15}/> Фильтры{activeFilters ? ` · ${activeFilters}` : ''}</button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#e3edf1] pt-4">
          <div className="inline-flex rounded-xl bg-[#eef4f7] p-1">
            {([['active','В работе'],['won','Успешно реализовано'],['lost','Не реализовано']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => { setView(value); setStageId('') }} className={cn('rounded-lg px-3 py-2 text-xs font-semibold transition', view === value ? value === 'won' ? 'bg-emerald-600 text-white shadow-sm' : value === 'lost' ? 'bg-red-500 text-white shadow-sm' : 'bg-white text-[#075a78] shadow-sm' : 'text-slate-500 hover:text-[#17364c]')}>{label}</button>)}
          </div>
          {canManageStages && <details className="relative"><summary className="cursor-pointer list-none rounded-xl border border-[#cddde5] bg-white px-3 py-2 text-xs font-semibold text-[#075a78] hover:bg-[#eef7fa]">Подсказки этапов</summary><div className="absolute left-0 top-10 z-30 w-72 rounded-xl border border-[#cddde5] bg-white p-2 shadow-xl"><p className="px-2 py-1 text-[10px] font-bold uppercase tracking-[.12em] text-slate-400">{pipeline?.name}</p>{pipelineStages.map(stage => <button key={stage.id} type="button" onClick={() => void editStageGuidance(stage)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-[#17364c] hover:bg-[#eef7fa]"><span className="size-2 rounded-full" style={{ backgroundColor: stage.color }}/><span className="flex-1 truncate">{stage.name}</span><span className="text-[#1784a6]">Изм.</span></button>)}</div></details>}
        </div>
        {filtersOpen && <div className="mt-4 grid gap-2 rounded-2xl border border-[#dbe8ee] bg-[#f8fbfc] p-3 sm:grid-cols-2 lg:grid-cols-5">
          <select className={control} value={sort} onChange={e => setSort(e.target.value as DealSort)} aria-label="Сортировка сделок"><option value="updated-desc">Сортировка: сначала активные</option><option value="created-desc">Сортировка: сначала новые</option><option value="amount-desc">Сортировка: сумма по убыванию</option><option value="amount-asc">Сортировка: сумма по возрастанию</option><option value="task-asc">Сортировка: ближайшая задача</option></select>
          <select className={control} value={assignment} onChange={e => setAssignment(e.target.value as typeof assignment)}><option value="all">Все ответственные</option><option value="mine">Мои</option><option value="unassigned">Без ответственного</option></select>
          <select className={control} value={employeeId} onChange={e => setEmployeeId(e.target.value)}><option value="">Любой сотрудник</option>{employees.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <select className={control} value={stageId} onChange={e => setStageId(e.target.value)}><option value="">Любой этап</option>{pipelineStages.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <select className={control} value={tagId} onChange={e => setTagId(e.target.value)}><option value="">Любой тег</option>{tags.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <select className={control} value={source} onChange={e => setSource(e.target.value)}><option value="">Любой источник</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="telegram">Telegram</option><option value="site">Сайт</option><option value="manual">Вручную</option></select>
          <select className={control} value={attention} onChange={e => setAttention(e.target.value as typeof attention)}><option value="all">Любая важность</option><option value="urgent">Срочные</option><option value="attention">Требуют внимания</option></select>
          <select className={control} value={deadline} onChange={e => setDeadline(e.target.value as typeof deadline)}><option value="all">Любой срок</option><option value="overdue">Просроченные</option><option value="current">Непросроченные</option></select>
          <select className={control} value={taskMode} onChange={e => setTaskMode(e.target.value as typeof taskMode)}><option value="all">Любые задачи</option><option value="with">С задачами</option><option value="without">Без задач</option><option value="without-next">Без следующей задачи</option></select>
          <select className={control} value={city} onChange={e => setCity(e.target.value)}><option value="">Любой город</option>{cities.map(x => <option key={x} value={x}>{x}</option>)}</select>
          <div className="flex gap-1"><input type="date" title="Создано от" value={createdFrom} onChange={e => setCreatedFrom(e.target.value)} className={`${control} min-w-0 flex-1 px-2`}/><input type="date" title="Создано до" value={createdTo} onChange={e => setCreatedTo(e.target.value)} className={`${control} min-w-0 flex-1 px-2`}/></div>
          <button onClick={resetFilters} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl text-xs font-semibold text-slate-500 hover:bg-white"><X size={14}/> Сбросить</button>
        </div>}
      </header>

      <div className="flex items-center justify-end gap-1 px-6 pt-3"><button type="button" onClick={() => boardRef.current?.scrollBy({ left: -620, behavior: 'smooth' })} className="grid size-9 place-items-center rounded-lg border border-[#cddde5] bg-white text-[#075a78]" aria-label="Предыдущие этапы"><ChevronLeft size={18}/></button><button type="button" onClick={() => boardRef.current?.scrollBy({ left: 620, behavior: 'smooth' })} className="grid size-9 place-items-center rounded-lg border border-[#cddde5] bg-white text-[#075a78]" aria-label="Следующие этапы"><ChevronRight size={18}/></button></div>
      <main ref={boardRef} onWheel={event => { if (Math.abs(event.deltaX) > 0) event.preventDefault() }} className="scroll-hidden flex flex-1 gap-4 overflow-x-auto p-6 pt-2" style={{ overscrollBehaviorX: 'none', scrollbarWidth: 'none' }}>
        {loadingInitial && <div className="grid min-h-[320px] w-full place-items-center text-sm text-slate-500">Загружаю сделки…</div>}
        {!loadingInitial && loadError && <div role="alert" className="flex min-h-[320px] w-full flex-col items-center justify-center gap-3 text-sm text-slate-500"><p>Не удалось загрузить сделки. Попробуйте ещё раз.</p><button type="button" className={control} onClick={() => setLoadingInitial(true)}>Повторить загрузку</button></div>}
        {visibleStages.map(stage => {
          const list = byStage.get(stage.id) ?? []
          const visible = search || expanded.has(stage.id) ? list : list.slice(0, INITIAL_COLUMN_LIMIT)
          const total = list.reduce((sum, deal) => sum + Number(deal.amount ?? 0), 0)
          return <section key={stage.id} onDragOver={event => { if (dragId) { event.preventDefault(); setOverStage(stage.id) } }} onDrop={event => { event.preventDefault(); void drop(stage.id) }} className={cn('flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl border bg-[#eef4f7] transition', overStage === stage.id ? 'border-[#1784a6] ring-2 ring-[#1784a6]/15' : 'border-[#dbe8ee]')}>
            <div className="border-t-4 bg-white px-3.5 py-3" style={{ borderTopColor: stage.color }}><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }}/><h2 className="min-w-0 flex-1 truncate text-[13px] font-bold text-[#17364c]">{stage.name === 'Пердоплата' ? 'Предоплата' : stage.name}</h2><span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: stageSoft(stage.color), color: '#17364c' }}>{list.length}</span></div><p className="mt-1 pl-[18px] text-[11px] text-slate-400">{new Intl.NumberFormat('ru-RU').format(total)} сом</p></div>
            <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">{stageGuidance(stage) && <p className="rounded-xl border border-[#dbe8ee] bg-white/65 px-3 py-2.5 text-[10px] leading-relaxed text-[#526a79]">{stageGuidance(stage)}</p>}{visible.map(deal => { const target = dealOpenTarget(deal); const openDeal = () => target ? router.push(target) : setSelected(deal); return <DealCard key={deal.id} deal={deal} color={stage.color} responsible={employees.find(employee => employee.id === deal.responsible_employee_id)} dragging={dragId === deal.id} highlighted={highlighted === deal.id} onOpen={openDeal} onEdit={openDeal} onDragStart={() => { dragIdRef.current = deal.id; setDragId(deal.id) }} onDragEnd={() => { dragIdRef.current = null; setDragId(null); setOverStage(null) }}/> })}{visible.length === 0 && <div className="rounded-xl border border-dashed border-[#c5d7df] p-5 text-center text-xs text-slate-400">{view === 'active' ? 'Перетащите сюда сделку или создайте новую' : view === 'won' ? 'Здесь появятся успешно завершённые сделки' : 'Здесь появятся сделки, закрытые без продажи'}</div>}{!search && list.length > INITIAL_COLUMN_LIMIT && !expanded.has(stage.id) && <button onClick={() => setExpanded(current => new Set(current).add(stage.id))} className="rounded-xl border border-[#cddde5] bg-white py-2 text-xs font-semibold text-[#075a78]">Показать ещё {list.length - INITIAL_COLUMN_LIMIT}</button>}</div>
          </section>
        })}
      </main>
      {dragId && view === 'active' && <div className="fixed inset-x-0 bottom-5 z-40 mx-auto grid w-[min(680px,calc(100%-32px))] grid-cols-2 gap-2 rounded-2xl border border-white/15 bg-[#0c2136]/95 p-2 shadow-2xl backdrop-blur" aria-live="polite">
        {([['won', CheckCircle2, 'Успешно реализовано', '#15803d'], ['lost', XCircle, 'Не реализовано', '#dc2626']] as const).map(([kind, Icon, label, activeColor]) => { const target = pipelineStages.find(stage => stage.kind === kind); const active = overStage === target?.id; return <button key={kind} type="button" disabled={!target} onDragOver={event => { if (target) { event.preventDefault(); setOverStage(target.id) } }} onDragLeave={() => setOverStage(null)} onDrop={event => { event.preventDefault(); if (target) void drop(target.id) }} className={cn('flex h-16 items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-bold transition disabled:opacity-60', active && 'scale-[1.02]')} style={{ backgroundColor: active ? activeColor : '#16435a', borderColor: active ? '#ffffff' : 'rgba(255,255,255,0.45)', color: '#ffffff', WebkitTextFillColor: '#ffffff' }}><Icon size={20}/> {label}</button> })}
        <p className="col-span-2 text-center text-[11px]" style={{ color: '#cbd5e1', WebkitTextFillColor: '#cbd5e1' }}>Отпустите карточку в нужной зоне — этап сохранится автоматически</p>
      </div>}
      <DealSheet deal={selected === 'new' ? null : selected} isNew={selected === 'new'} stages={pipelineStages} employees={employees} open={selected !== null} onClose={() => setSelected(null)} onSaved={async () => { await refresh(); setSelected(null) }}/>
    </div>
  )
}
