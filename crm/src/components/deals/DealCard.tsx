'use client'

import { AlertTriangle, Bot, Clock, GripVertical, Phone } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Deal, DealEmployee } from '@/types'
import { colorAlpha, employeeColor, initials } from '@/lib/employee-colors'
import { DEAL_SOURCE, formatStageAge } from './deal-config'

export default function DealCard({
  deal,
  color,
  responsible,
  dragging,
  highlighted,
  onDragStart,
  onDragEnd,
  onOpen,
  onEdit,
}: {
  deal: Deal
  color: string
  responsible?: DealEmployee
  dragging: boolean
  highlighted: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
  onEdit: () => void
}) {
  const source = DEAL_SOURCE[deal.source] ?? DEAL_SOURCE.amocrm
  const SourceIcon = source.icon
  const dialogHref = deal.amocrm_lead_id !== null
    ? `/dashboard/dialogs?lead=${encodeURIComponent(String(deal.amocrm_lead_id))}`
    : deal.client_id ? `/dashboard/dialogs?client=${encodeURIComponent(deal.client_id)}` : null
  const overdue = Boolean(deal.next_task_at && new Date(deal.next_task_at.length === 10 ? `${deal.next_task_at}T23:59:59` : deal.next_task_at).getTime() < Date.now())
  const employeeTone = responsible ? employeeColor(responsible.name) : null
  return (
    <article
      data-deal-id={deal.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', deal.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onEdit() }}
      className={cn(
        'group cursor-grab select-none rounded-2xl border border-slate-200 p-3 shadow-[0_8px_24px_rgba(9,42,66,0.06)] transition duration-150 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(9,42,66,0.11)] active:cursor-grabbing',
        dragging && 'rotate-1 opacity-40', overdue && 'border-red-300', highlighted && 'animate-pulse ring-4 ring-red-500 ring-offset-2',
      )}
      style={{ borderLeft: `4px solid ${color}`, backgroundColor: overdue ? '#fff7f7' : employeeTone ? colorAlpha(employeeTone, 0.10) : '#fff' }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-[#092a42]">{deal.title}</p>
          {deal.customer_name && deal.customer_name !== deal.title && (
            dialogHref ? (
              <Link href={dialogHref} onClick={event => event.stopPropagation()} className="mt-1 block truncate text-left text-xs text-slate-500 underline-offset-2 hover:text-[#075a78] hover:underline" title="Открыть диалог и карточку клиента">
                {deal.customer_name}
              </Link>
            ) : <p className="mt-1 truncate text-xs text-slate-500">{deal.customer_name}</p>
          )}
        </div>
        <button type="button" draggable={false} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onEdit() }} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Открыть диалог и карточку клиента" aria-label="Открыть диалог и карточку клиента"><GripVertical size={16}/></button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {deal.ai_approval_status && <span className="inline-flex items-center gap-1 rounded-lg bg-violet-100 px-2 py-1 text-[10px] font-semibold text-violet-800" title="Ответ ИИ ждёт решения менеджера">
          <Bot size={11} /> {deal.ai_approval_status === 'edited' ? 'ИИ-ответ изменён' : 'ИИ-ответ готов'}
        </span>}
        {(deal.tags ?? []).slice(0, 2).map(tag => <span key={tag.id} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-white" style={{ backgroundColor: tag.color }}>{tag.name}</span>)}
        {responsible && employeeTone && <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/70 px-1.5 py-1 text-[10px] font-semibold text-[#17364c]" title={`Ответственный: ${responsible.name}`}>
          <span className="grid size-4 place-items-center rounded-full text-[7px] font-bold text-white" style={{ backgroundColor: employeeTone }}>{initials(responsible.name)}</span>
          <span className="max-w-24 truncate">{responsible.name}</span>
        </span>}
        <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold" style={{ color: source.color, background: source.bg }}>
          <SourceIcon size={11} /> {source.label}
        </span>
        {deal.amount !== null && Number(deal.amount) > 0 && (
          <span className="rounded-lg bg-[#eaf4f8] px-2 py-1 text-[10px] font-semibold text-[#075a78]">
            {new Intl.NumberFormat('ru-RU').format(Number(deal.amount))} сом
          </span>
        )}
        {deal.customer_phone && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] text-slate-600">
            <Phone size={10} /> {deal.customer_phone}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-400">
        <span className="inline-flex items-center gap-1"><Clock size={11} />{formatStageAge(deal.stage_changed_at)}</span>
        {overdue && <span className="inline-flex items-center gap-1 font-bold text-red-600"><AlertTriangle size={11}/> Просрочено</span>}
        <span>{deal.has_open_tasks ? 'Есть задача' : 'Без задач'}</span>
      </div>
    </article>
  )
}
