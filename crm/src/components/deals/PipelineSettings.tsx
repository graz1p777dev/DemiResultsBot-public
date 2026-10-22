'use client'

import { ArrowDown, ArrowUp, Save, Settings2 } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { reorderPipelineStages, saveStageConfiguration } from '@/actions/deals'
import type { DealPipeline, DealStage, DealStageClosingRule, DealStageRequiredField } from '@/types'

const FIELDS: Array<{ id: DealStageRequiredField; label: string }> = [
  { id: 'client', label: 'Клиент' }, { id: 'phone', label: 'Телефон' }, { id: 'amount', label: 'Сумма' }, { id: 'note', label: 'Заметка' }, { id: 'responsible', label: 'Ответственный' },
]
const CLOSE_RULES: Array<{ id: DealStageClosingRule; label: string }> = [
  { id: 'amount', label: 'Сумма сделки' }, { id: 'note', label: 'Заметка менеджера' }, { id: 'loss_reason', label: 'Причина отказа' },
]

export default function PipelineSettings({ pipelines, stages }: { pipelines: DealPipeline[]; stages: DealStage[] }) {
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '')
  const [rows, setRows] = useState(stages)
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const visible = useMemo(() => rows.filter(stage => stage.pipeline_id === pipelineId).sort((a, b) => a.sort_order - b.sort_order), [pipelineId, rows])
  const move = (index: number, delta: number) => {
    const next = index + delta
    if (next < 0 || next >= visible.length) return
    const ordered = [...visible]
    ;[ordered[index], ordered[next]] = [ordered[next], ordered[index]]
    setRows(current => [...current.filter(stage => stage.pipeline_id !== pipelineId), ...ordered.map((stage, order) => ({ ...stage, sort_order: (order + 1) * 10 }))])
    startTransition(async () => {
      const result = await reorderPipelineStages(pipelineId, ordered.map(stage => stage.id))
      if (!result.success) { toast.error(result.error); setRows(stages); return }
      toast.success('Порядок этапов сохранён')
    })
  }
  const save = (form: HTMLFormElement, stage: DealStage) => {
    const data = new FormData(form)
    const requiredFields = FIELDS.filter(field => data.get(`required-${field.id}`) === 'on').map(field => field.id)
    const closingRules = CLOSE_RULES.filter(rule => data.get(`closing-${rule.id}`) === 'on').map(rule => rule.id)
    startTransition(async () => {
      const result = await saveStageConfiguration({ id: stage.id, name: String(data.get('name') ?? ''), color: String(data.get('color') ?? ''), guidance: String(data.get('guidance') ?? ''), requiredFields, closingRules })
      if (!result.success) { toast.error(result.error); return }
      setRows(current => current.map(item => item.id === stage.id ? result.data : item))
      setEditing(null); toast.success('Этап сохранён')
    })
  }
  return <div className="min-h-screen bg-[#f4f8fa] p-5 text-[#092a42] dark:bg-slate-950 dark:text-slate-100 sm:p-7">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#1784a6] dark:text-cyan-300">CRM · Настройки</p><h1 className="mt-1 text-2xl font-bold text-[#092a42] dark:text-white">Воронки и этапы</h1><p className="mt-1 text-sm text-[#526a79] dark:text-slate-300">Настройте порядок, подсказки и правила перехода внутри нашей CRM.</p></div><Settings2 className="text-[#1784a6] dark:text-cyan-300" /></header>
    <div className="mb-5 flex flex-wrap gap-2">{pipelines.map(pipeline => <button key={pipeline.id} type="button" onClick={() => { setPipelineId(pipeline.id); setEditing(null) }} className={`rounded-xl px-4 py-2 text-sm font-semibold ${pipeline.id === pipelineId ? 'bg-[#075a78] text-white dark:bg-cyan-700' : 'border border-[#cddde5] bg-white text-[#075a78] dark:border-slate-700 dark:bg-slate-900 dark:text-cyan-200'}`}>{pipeline.name}</button>)}</div>
    <section className="rounded-2xl border border-[#dbe8ee] bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"><div className="mb-3 rounded-xl bg-[#eaf4f8] px-3 py-2 text-xs text-[#526a79] dark:bg-slate-800 dark:text-slate-300">Стрелки меняют порядок только внутри выбранной воронки. Обязательные данные проверяются при любом переносе карточки.</div>{visible.map((stage, index) => <div key={stage.id} className="border-t border-[#e3edf1] py-3 first:border-t-0 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-3"><span className="size-3 rounded-full" style={{ backgroundColor: stage.color }} /><div className="min-w-0 flex-1"><p className="font-semibold text-[#092a42] dark:text-white">{stage.name}</p><p className="text-xs text-[#6c8392] dark:text-slate-400">{stage.kind === 'won' ? 'Успешное закрытие' : stage.kind === 'lost' ? 'Закрытие без продажи' : 'Рабочий этап'}</p></div><div className="flex gap-1"><button type="button" disabled={pending || index === 0} onClick={() => move(index, -1)} className="rounded-lg border border-[#cddde5] p-2 text-[#075a78] disabled:opacity-40 dark:border-slate-600 dark:text-cyan-200" aria-label="Поднять этап"><ArrowUp size={15}/></button><button type="button" disabled={pending || index === visible.length - 1} onClick={() => move(index, 1)} className="rounded-lg border border-[#cddde5] p-2 text-[#075a78] disabled:opacity-40 dark:border-slate-600 dark:text-cyan-200" aria-label="Опустить этап"><ArrowDown size={15}/></button><button type="button" onClick={() => setEditing(editing === stage.id ? null : stage.id)} className="rounded-lg bg-[#eaf4f8] px-3 text-xs font-bold text-[#075a78] dark:bg-slate-800 dark:text-cyan-200">Настроить</button></div></div>
      {editing === stage.id && <form className="mt-3 grid gap-3 rounded-xl bg-[#f8fbfc] p-4 dark:bg-slate-800 md:grid-cols-2" onSubmit={event => { event.preventDefault(); save(event.currentTarget, stage) }}><label className="text-xs font-semibold text-[#526a79] dark:text-slate-300">Название<input name="name" defaultValue={stage.name} maxLength={120} required className="mt-1 h-10 w-full rounded-lg border border-[#cddde5] bg-white px-3 text-sm text-[#092a42] dark:border-slate-600 dark:bg-slate-950 dark:text-white"/></label><label className="text-xs font-semibold text-[#526a79] dark:text-slate-300">Цвет<div className="mt-1 flex gap-2"><input name="color" type="color" defaultValue={stage.color} className="h-10 w-12 rounded border border-[#cddde5] bg-white p-1 dark:border-slate-600 dark:bg-slate-950"/><input defaultValue={stage.color} pattern="#[0-9a-fA-F]{6}" className="h-10 flex-1 rounded-lg border border-[#cddde5] bg-white px-3 text-sm text-[#092a42] dark:border-slate-600 dark:bg-slate-950 dark:text-white" aria-label="HEX цвет" onChange={event => { const input = event.currentTarget.form?.elements.namedItem('color') as HTMLInputElement | null; if (input && /^#[0-9a-f]{6}$/i.test(event.currentTarget.value)) input.value = event.currentTarget.value }} /></div></label><label className="md:col-span-2 text-xs font-semibold text-[#526a79] dark:text-slate-300">Подсказка менеджеру<textarea name="guidance" defaultValue={stage.guidance ?? ''} maxLength={600} placeholder="Что сделать на этом этапе" className="mt-1 min-h-20 w-full rounded-lg border border-[#cddde5] bg-white p-3 text-sm text-[#092a42] dark:border-slate-600 dark:bg-slate-950 dark:text-white"/></label><fieldset><legend className="text-xs font-semibold text-[#526a79] dark:text-slate-300">Обязательные данные перед переходом</legend><div className="mt-2 flex flex-wrap gap-3">{FIELDS.map(field => <label key={field.id} className="flex items-center gap-1.5 text-xs text-[#17364c] dark:text-slate-200"><input name={`required-${field.id}`} type="checkbox" defaultChecked={stage.required_fields?.includes(field.id)} />{field.label}</label>)}</div></fieldset>{stage.kind !== 'normal' && <fieldset><legend className="text-xs font-semibold text-[#526a79] dark:text-slate-300">Перед закрытием</legend><div className="mt-2 flex flex-wrap gap-3">{CLOSE_RULES.filter(rule => stage.kind === 'lost' || rule.id !== 'loss_reason').map(rule => <label key={rule.id} className="flex items-center gap-1.5 text-xs text-[#17364c] dark:text-slate-200"><input name={`closing-${rule.id}`} type="checkbox" defaultChecked={stage.closing_rules?.includes(rule.id)} />{rule.label}</label>)}</div></fieldset>}<div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-2 text-xs font-bold text-[#526a79] dark:text-slate-300">Отмена</button><button disabled={pending} className="inline-flex items-center gap-1 rounded-lg bg-[#075a78] px-3 py-2 text-xs font-bold text-white disabled:opacity-60 dark:bg-cyan-700"><Save size={14}/>{pending ? 'Сохраняем…' : 'Сохранить'}</button></div></form>}</div>)}</section>
  </div>
}
