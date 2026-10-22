'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react'
import { botGet, botJson } from '@/lib/bot-api'

type Approval = {
  id: number
  status: string
  client_message: string
  ai_reply: string
  edited_reply: string | null
  suggested_reply: string
  reject_reason: string | null
  conversation_summary: string | null
  client_message_translation: string | null
  ai_reply_translation: string | null
  ai_reasoning: string | null
  stage_name: string | null
  created_at: string
  is_purchase: boolean
  is_stop_word: boolean
  lead: { id: number; amocrm_lead_id: string; ai_enabled: boolean }
  client: { id: number | null; name: string | null; phone: string | null; source: string | null }
}

type ApprovalResponse = { items: Approval[]; total: number }
type QueueView = 'active' | 'processed'

const ACTIVE_STATUSES = 'pending,edited'
const PROCESSED_STATUSES = 'sent,rejected,failed,answered_external,saved'

function formatDate(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ageLabel(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} ч`
  return `${Math.floor(minutes / 1_440)} дн`
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Ждёт решения',
    edited: 'Отредактировано',
    sent: 'Отправлено',
    rejected: 'Отклонено',
    failed: 'Ошибка отправки',
    answered_external: 'Ответили вне CRM',
    saved: 'Сохранено',
  }
  return labels[status] || status
}

export default function ApprovalsPage() {
  const [view, setView] = useState<QueueView>('active')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Approval[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [showReject, setShowReject] = useState(false)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [total, setTotal] = useState(0)
  const selectedIdRef = useRef<number | null>(null)

  const selected = useMemo(
    () => items.find(item => item.id === selectedId) ?? null,
    [items, selectedId],
  )

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const params = new URLSearchParams({
        status: view === 'active' ? ACTIVE_STATUSES : PROCESSED_STATUSES,
        limit: '150',
      })
      if (query.trim()) params.set('q', query.trim())
      const result = await botGet<ApprovalResponse>(`/admin/approvals?${params}`)
      setItems(result.items)
      setTotal(result.total)
      const current = selectedIdRef.current
      const next = current && result.items.some(item => item.id === current) ? current : result.items[0]?.id ?? null
      if (next !== current) {
        selectedIdRef.current = next
        setSelectedId(next)
        const item = result.items.find(entry => entry.id === next)
        setDraft(item?.suggested_reply ?? '')
        setRejectReason('')
        setShowReject(false)
      }
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить очередь')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [query, view])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250)
    return () => clearTimeout(timer)
  }, [load])

  useEffect(() => {
    const timer = setInterval(() => void load(true), 20_000)
    return () => clearInterval(timer)
  }, [load])

  const chooseApproval = (item: Approval | null) => {
    selectedIdRef.current = item?.id ?? null
    setSelectedId(item?.id ?? null)
    setDraft(item?.suggested_reply ?? '')
    setRejectReason('')
    setShowReject(false)
  }

  const complete = async (action: 'approve' | 'reject') => {
    if (!selected || working) return
    if (action === 'approve' && !draft.trim()) {
      setError('Перед отправкой заполните ответ клиенту')
      return
    }
    if (action === 'reject' && !rejectReason.trim()) {
      setError('Укажите причину отклонения — она нужна для обучения бота')
      return
    }
    setWorking(action)
    setError('')
    try {
      if (action === 'approve') {
        if (draft.trim() !== selected.ai_reply.trim() || selected.is_purchase) {
          await botJson(`/admin/approvals/${selected.id}`, 'PATCH', { reply: draft.trim() })
        }
        await botJson(`/admin/approvals/${selected.id}/approve`, 'POST')
      } else {
        await botJson(`/admin/approvals/${selected.id}/reject`, 'POST', { reason: rejectReason.trim() })
      }
      await load(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Действие не выполнено')
    } finally {
      setWorking('')
    }
  }

  return (
    <div className="box-border h-[calc(100dvh-52px)] min-h-0 p-3 md:p-5">
      <div className="grid h-full min-h-0 overflow-hidden rounded-[22px] border border-[#dce5ea] bg-white shadow-[0_18px_60px_rgba(12,33,54,0.08)] lg:grid-cols-[330px_minmax(0,1fr)_360px]">
        <aside className={`min-h-0 min-w-0 border-r border-[#e4eaee] bg-[#f8fafb] ${selected ? 'hidden lg:flex' : 'flex'} flex-col`}>
          <div className="border-b border-[#e4eaee] px-4 pb-4 pt-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#5c7485]">AI control room</p>
                <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0c2136]">Согласования</h1>
              </div>
              <button onClick={() => void load()} className="rounded-xl border border-[#dce5ea] bg-white p-2 text-[#35566b] hover:bg-[#eef5f8]" title="Обновить">
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="grid grid-cols-2 rounded-xl bg-[#e9eff2] p-1 text-xs font-semibold">
              <button onClick={() => setView('active')} className={`rounded-lg px-2 py-2 ${view === 'active' ? 'bg-white text-[#0c4d6c] shadow-sm' : 'text-[#6c7f8c]'}`}>
                В работе
              </button>
              <button onClick={() => setView('processed')} className={`rounded-lg px-2 py-2 ${view === 'processed' ? 'bg-white text-[#0c4d6c] shadow-sm' : 'text-[#6c7f8c]'}`}>
                История
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#dce5ea] bg-white px-3 py-2.5">
              <Search size={14} className="text-[#78909f]" />
              <input value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-[#0c2136] outline-none" placeholder="Клиент, телефон, сообщение" />
            </div>
          </div>

          <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-2 [scrollbar-gutter:stable]">
            <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#78909f]">
              {total} карточек
            </div>
            {!loading && items.length === 0 && (
              <div className="m-2 rounded-2xl border border-dashed border-[#ccd8df] bg-white p-6 text-center">
                <CheckCircle2 className="mx-auto text-[#2d8a65]" size={28} />
                <p className="mt-3 text-sm font-semibold text-[#0c2136]">Очередь разобрана</p>
                <p className="mt-1 text-xs leading-5 text-[#78909f]">Новые ответы AI появятся здесь автоматически.</p>
              </div>
            )}
            {items.map(item => (
              <button key={item.id} onClick={() => chooseApproval(item)} className={`mb-1.5 w-full rounded-2xl border p-3 text-left transition ${selectedId === item.id ? 'border-[#73a6bd] bg-white shadow-[0_8px_24px_rgba(12,77,108,0.10)]' : 'border-transparent hover:border-[#dce5ea] hover:bg-white'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-[#0c2136]">{item.client.name || item.client.phone || `Lead ${item.lead.amocrm_lead_id}`}</span>
                  <span className="shrink-0 text-[10px] font-semibold text-[#8a9ca8]">{ageLabel(item.created_at)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#5f7482]">{item.client_message}</p>
                <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold">
                  <span className={`rounded-full px-2 py-1 ${item.is_purchase ? 'bg-[#fff0cf] text-[#8a5a00]' : item.is_stop_word ? 'bg-[#fee2e2] text-[#a52a2a]' : 'bg-[#e4f1f6] text-[#0c4d6c]'}`}>
                    {item.is_purchase ? 'Покупка' : item.is_stop_word ? 'Стоп-слово' : statusLabel(item.status)}
                  </span>
                  <span className="truncate text-[#8a9ca8]">{item.stage_name || 'Без этапа'}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className={`${selected ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-col overflow-hidden bg-[#f3f6f7]`}>
          {!selected ? (
            <div className="m-auto text-center text-[#78909f]"><MessageSquareText className="mx-auto mb-3" size={34} /><p className="text-sm">Выберите карточку</p></div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-[#dce5ea] bg-white px-4 py-3 lg:px-6">
                <button className="text-sm font-semibold text-[#0c4d6c] lg:hidden" onClick={() => chooseApproval(null)}>← Очередь</button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#0c2136]">{selected.client.name || 'Клиент без имени'}</p>
                  <p className="truncate text-xs text-[#78909f]">{selected.client.phone || 'Телефон не указан'} · {selected.client.source || 'канал не определён'}</p>
                </div>
                <a href={`/dashboard/dialogs?lead=${selected.lead.amocrm_lead_id}`} className="flex items-center gap-1.5 rounded-xl border border-[#dce5ea] px-3 py-2 text-xs font-semibold text-[#0c4d6c] hover:bg-[#eef5f8]">
                  Диалог <ExternalLink size={12} />
                </a>
              </div>

              <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-4 [scrollbar-gutter:stable] md:p-7">
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {selected.conversation_summary && (
                    <div className="rounded-2xl border border-[#d8e3e8] bg-white px-4 py-3">
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#78909f]">Контекст диалога</p>
                      <p className="text-sm leading-6 text-[#3e5665]">{selected.conversation_summary}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    <div className="flex flex-col items-center"><div className="grid h-7 w-7 place-items-center rounded-full bg-[#dcecf3] text-[#0c4d6c]"><UserRound size={13} /></div><div className="mt-2 w-px flex-1 bg-[#bfcfd7]" /></div>
                    <div className="pb-5">
                      <div className="mb-1 flex items-center justify-between"><span className="text-xs font-bold text-[#0c2136]">Клиент</span><span className="text-[10px] text-[#8a9ca8]">{formatDate(selected.created_at)}</span></div>
                      <div className="rounded-2xl rounded-tl-md border border-[#d8e3e8] bg-white p-4 text-sm leading-6 text-[#243d4d] shadow-sm">{selected.client_message}</div>
                      {selected.client_message_translation && <p className="mt-2 rounded-xl bg-[#e9eff2] px-3 py-2 text-xs italic text-[#5f7482]">{selected.client_message_translation}</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    <div className="flex flex-col items-center"><div className="grid h-7 w-7 place-items-center rounded-full bg-[#0c4d6c] text-white"><Bot size={13} /></div><div className="mt-2 w-px flex-1 bg-[#bfcfd7]" /></div>
                    <div className="pb-5">
                      <div className="mb-1 flex items-center justify-between"><span className="text-xs font-bold text-[#0c2136]">AI подготовил ответ</span><span className="text-[10px] font-semibold text-[#b06b00]">не отправлен</span></div>
                      <div className="rounded-2xl rounded-tl-md bg-[#0c334a] p-4 text-sm leading-6 text-white shadow-sm">{selected.suggested_reply || 'AI не подготовил текст — нужен ответ менеджера.'}</div>
                      {selected.ai_reasoning && <details className="mt-2 rounded-xl border border-[#d8e3e8] bg-white px-3 py-2 text-xs text-[#5f7482]"><summary className="cursor-pointer font-semibold text-[#35566b]">Почему AI предложил этот ответ</summary><p className="mt-2 leading-5">{selected.ai_reasoning}</p></details>}
                    </div>
                  </div>

                  <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    <div className="grid h-7 w-7 place-items-center rounded-full bg-[#e6f3ec] text-[#237354]"><ShieldCheck size={13} /></div>
                    <div>
                      <div className="mb-1 flex items-center justify-between"><span className="text-xs font-bold text-[#0c2136]">Решение менеджера</span><span className="text-[10px] text-[#8a9ca8]">проверьте перед отправкой</span></div>
                      <textarea value={draft} onChange={event => setDraft(event.target.value)} disabled={view === 'processed'} rows={7} className="w-full resize-y rounded-2xl border border-[#bfcfd7] bg-white p-4 text-sm leading-6 text-[#0c2136] outline-none transition focus:border-[#4f8faa] focus:ring-4 focus:ring-[#dcecf3] disabled:bg-[#eef2f4]" placeholder="Напишите ответ клиенту..." />
                    </div>
                  </div>
                </div>
              </div>
              {view === 'active' && (
                <div className="border-t border-[#dce5ea] bg-white p-3 lg:hidden">
                  {error && <p className="mb-2 rounded-xl bg-[#fff1f2] p-2 text-xs text-[#a52a2a]">{error}</p>}
                  {showReject && <textarea value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={2} className="mb-2 w-full rounded-xl border border-[#e8b9b9] p-3 text-sm outline-none" placeholder="Причина отклонения" />}
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => void complete('approve')} disabled={Boolean(working)} className="rounded-xl bg-[#237354] px-3 py-3 text-sm font-semibold text-white disabled:opacity-50">Принять</button>
                    <button onClick={() => showReject ? void complete('reject') : setShowReject(true)} disabled={Boolean(working)} className="rounded-xl border border-[#e0b7b7] px-3 py-3 text-sm font-semibold text-[#9a3838] disabled:opacity-50">Отклонить</button>
                  </div>
                </div>
              )}
            </>
          )}
        </main>

        <aside className={`${selected ? 'hidden lg:flex' : 'hidden'} min-h-0 flex-col overflow-hidden border-l border-[#e4eaee] bg-white`}>
          {selected && (
            <>
              <div className="border-b border-[#e4eaee] p-5">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#78909f]">Карточка №{String(selected.id).padStart(7, '0')}</p>
                <h2 className="mt-2 text-lg font-semibold text-[#0c2136]">{selected.is_purchase ? 'Клиент готов купить' : selected.is_stop_word ? 'Нужен человек' : 'Проверка ответа'}</h2>
              </div>
              <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-5 [scrollbar-gutter:stable]">
                <dl className="space-y-4 text-sm">
                  <div><dt className="text-xs text-[#78909f]">Этап сделки</dt><dd className="mt-1 font-semibold text-[#0c2136]">{selected.stage_name || 'Не определён'}</dd></div>
                  <div><dt className="text-xs text-[#78909f]">ID диалога</dt><dd className="mt-1 font-mono text-xs text-[#35566b]">{selected.lead.amocrm_lead_id}</dd></div>
                  <div><dt className="text-xs text-[#78909f]">AI в диалоге</dt><dd className={`mt-1 font-semibold ${selected.lead.ai_enabled ? 'text-[#237354]' : 'text-[#a52a2a]'}`}>{selected.lead.ai_enabled ? 'Включён' : 'Отключён'}</dd></div>
                  <div><dt className="text-xs text-[#78909f]">Статус</dt><dd className="mt-1 font-semibold text-[#0c2136]">{statusLabel(selected.status)}</dd></div>
                </dl>
                {error && <div className="mt-5 rounded-xl border border-[#fecaca] bg-[#fff1f2] p-3 text-xs leading-5 text-[#a52a2a]">{error}</div>}
                {view === 'active' && showReject && (
                  <div className="mt-5 rounded-2xl border border-[#f1c9c9] bg-[#fff8f7] p-3">
                    <label className="text-xs font-semibold text-[#7f3131]">Почему ответ не подходит?</label>
                    <textarea value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={4} className="mt-2 w-full resize-none rounded-xl border border-[#e8b9b9] bg-white p-3 text-sm text-[#0c2136] outline-none focus:border-[#b95454]" placeholder="Например: неверная цена, слишком длинно..." />
                  </div>
                )}
              </div>
              {view === 'active' && (
                <div className="space-y-2 border-t border-[#e4eaee] p-4">
                  <button onClick={() => void complete('approve')} disabled={Boolean(working)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#237354] px-4 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(35,115,84,0.22)] transition hover:bg-[#1c6549] disabled:opacity-50">
                    <Check size={16} /> {working === 'approve' ? 'Отправляем...' : 'Принять и отправить'}
                  </button>
                  {!showReject ? (
                    <button onClick={() => setShowReject(true)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#e0b7b7] px-4 py-2.5 text-sm font-semibold text-[#9a3838] hover:bg-[#fff5f5]"><X size={15} /> Отклонить</button>
                  ) : (
                    <button onClick={() => void complete('reject')} disabled={Boolean(working)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#a53d3d] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><X size={15} /> {working === 'reject' ? 'Сохраняем...' : 'Подтвердить отклонение'}</button>
                  )}
                  <p className="flex items-center justify-center gap-1.5 pt-1 text-[10px] text-[#8a9ca8]"><Clock3 size={11} /> Решение сохраняется в истории обучения AI</p>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
