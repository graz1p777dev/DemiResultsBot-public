'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { botGet, botJson } from '@/lib/bot-api'
import { moveDeal } from '@/actions/deals'
import DialogClientPanel from '@/components/dialogs/DialogClientPanel'
import { BOT_COLOR, colorAlpha, employeeColor, initials } from '@/lib/employee-colors'
import { Bot, BriefcaseBusiness, Camera, Check, Headset, ImagePlus, LoaderCircle, MessageCircle, Mic, Pin, PinOff, Power, PowerOff, RefreshCw, Search, Send, Square, User, UserCheck, X } from 'lucide-react'

type DialogMeta = {
  leadId: string; dealId: string; clientId: string | null; stageId: string; responsibleEmployeeId: string | null
  responsibleName: string | null; source: string; urgent: boolean; attention: boolean; overdue: boolean
  hasTasks: boolean; nextTaskAt: string | null; city: string | null; phone: string | null
  instagramUsername: string | null; fullName: string | null; tags: Array<{ id: string; name: string; color: string }>
}
type DialogStage = { id: string; name: string; color: string }

type Conversation = {
  id: number
  amocrm_lead_id: string
  chat_id: string | null
  contact_id: string | null
  ai_enabled: boolean
  last_message_at: string | null
  client: string | null
  phone: string | null
  source: string | null
  unread_count: number
  pinned_at: string | null
  draft_text: string
  responsible_manager: string | null
  preview_text: string | null
  meta?: DialogMeta
}

type ChatMessage = {
  id: number | string
  approval_id?: number
  role: string
  speaker?: 'client' | 'bot' | 'manager' | null
  author_name?: string | null
  text: string
  status: string
  created_at: string | null
  media_url?: string | null
  message_type?: string | null
}
type ChatData = {
  lead_id: string
  client_name: string | null
  client_phone: string | null
  amocrm_url: string
  client_card?: Record<string, string>
  messages: ChatMessage[]
}
type ReplyOption = { approach: string; text: string }

function fmt(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function mediaHref(message: ChatMessage): string | null {
  if (message.media_url) return message.media_url
  const match = message.text.match(/https?:\/\/\S+/)
  return match?.[0] ?? null
}

function displayParts(text: string) {
  const parts = text.split(/\s*<NEXT_MESSAGE>\s*/gi).map(part => part.trim()).filter(Boolean)
  return parts.length ? parts : [text]
}

function previewLabel(text: string | null) {
  if (!text) return ''
  return /^\s*\[(?:picture|image|photo)\]\s*/i.test(text) ? 'Изображение' : text
}

const PAGE_SIZE = 30

export default function DialogsPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requestedLead = searchParams.get('lead')
  const requestedClient = searchParams.get('client')
  const requestedConversation = searchParams.get('conversation')
  const requestedQuery = searchParams.get('q') ?? ''
  const [convs, setConvs] = useState<Conversation[]>([])
  const [query, setQuery] = useState(requestedQuery)
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [chat, setChat] = useState<ChatData | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [decidingApprovalId, setDecidingApprovalId] = useState<number | null>(null)
  const [decisionKind, setDecisionKind] = useState<'approve' | 'reject' | null>(null)
  const [aiEditingId, setAiEditingId] = useState<number | null>(null)
  const [aiPromptApprovalId, setAiPromptApprovalId] = useState<number | null>(null)
  const [aiEditPrompt, setAiEditPrompt] = useState('')
  const [generatingReply, setGeneratingReply] = useState(false)
  const [generationStatus, setGenerationStatus] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [clientCardOpen, setClientCardOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantInstruction, setAssistantInstruction] = useState('')
  const [assistantLoading, setAssistantLoading] = useState(false)
  const [replyOptionCount, setReplyOptionCount] = useState(3)
  const [replyOptions, setReplyOptions] = useState<ReplyOption[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [source, setSource] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [deadlineFilter, setDeadlineFilter] = useState<'all' | 'overdue' | 'current'>('all')
  const [responsibleFilter, setResponsibleFilter] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [taskFilter, setTaskFilter] = useState<'all' | 'with' | 'without'>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dialogStages, setDialogStages] = useState<DialogStage[]>([])
  const [dialogEmployees, setDialogEmployees] = useState<Array<{ id: string; name: string }>>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const [recording, setRecording] = useState(false)
  const dictationRecorderRef = useRef<MediaRecorder | null>(null)
  const dictationChunksRef = useRef<Blob[]>([])
  const dictationTargetRef = useRef<string | null>(null)
  const [dictationTarget, setDictationTarget] = useState<string | null>(null)
  const [transcribingTarget, setTranscribingTarget] = useState<string | null>(null)
  // Latest search term available inside IntersectionObserver / fetch closures
  const queryRef = useRef('')

  useEffect(() => {
    setQuery(requestedQuery)
    queryRef.current = requestedQuery
  }, [requestedQuery])

  // Fetch one page. reset=true replaces the list (new search / first load).
  const fetchPage = async (reset: boolean, searchTerm: string) => {
    if (reset) { setLoading(true) } else { setLoadingMore(true) }
    const offset = reset ? 0 : convs.length
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (searchTerm.trim()) params.set('q', searchTerm.trim())
    if (unreadOnly) params.set('unread', 'true')
    if (responsibleFilter === 'mine') params.set('mine', 'true')
    if (source) params.set('source', source)
    try {
      const page = await botGet<Conversation[]>(`/admin/conversations?${params.toString()}`)
      let enriched = page
      if (page.length) {
        const metaResponse = await fetch(`/api/crm/dialogs/meta?leads=${page.map(item => item.amocrm_lead_id).join(',')}`, { cache: 'no-store' })
        if (metaResponse.ok) {
          const payload = await metaResponse.json() as { items: DialogMeta[]; stages: DialogStage[]; employees: Array<{ id: string; name: string }> }
          const byLead = new Map(payload.items.map(item => [item.leadId, item]))
          enriched = page.map(item => ({ ...item, meta: byLead.get(String(item.amocrm_lead_id)) }))
          setDialogStages(payload.stages); setDialogEmployees(payload.employees)
        }
      }
      setHasMore(page.length === PAGE_SIZE)
      setConvs(prev => reset ? enriched : [...prev, ...enriched])
    } catch {
      if (reset) setConvs([])
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  const reload = () => fetchPage(true, queryRef.current)

  // First load
  useEffect(() => {
    const timer = setTimeout(() => {
      queryRef.current = requestedQuery
      void fetchPage(true, requestedQuery)
    }, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedQuery])

  // Debounced search
  useEffect(() => {
    queryRef.current = query
    const t = setTimeout(() => { fetchPage(true, query) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, unreadOnly, source, responsibleFilter])

  // Infinite scroll via IntersectionObserver on the sentinel
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
        fetchPage(false, queryRef.current)
      }
    }, { root: listRef.current, rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loading, loadingMore, convs.length])

  const openChat = (c: Conversation) => {
    const params = new URLSearchParams(searchParams.toString())
    if (c.meta?.clientId) params.set('client', c.meta.clientId)
    else params.set('conversation', String(c.id))
    params.delete('lead')
    if (c.meta?.clientId) params.delete('conversation')
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    setSelected(c)
    setDraft(c.draft_text || '')
    setConvs(prev => prev.map(item => item.id === c.id ? { ...item, unread_count: 0 } : item))
    setChatLoading(true)
    botGet<ChatData>(`/admin/chat/${c.amocrm_lead_id}`)
      .then(setChat)
      .catch(() => setChat(null))
      .finally(() => setChatLoading(false))
  }

  const closeChat = () => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('lead')
    params.delete('client')
    params.delete('conversation')
    const suffix = params.toString()
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false })
    setSelected(null)
    setChat(null)
  }

  // Deals link here with ?lead=… so the manager lands in the full Inbox chat,
  // rather than opening the compact deal sheet over Kanban.
  useEffect(() => {
    if (!requestedLead || selected) return
    const loaded = convs.find(item => item.amocrm_lead_id === requestedLead)
    if (loaded) {
      openChat(loaded)
      return
    }
    // Resolve by the exact bot lead, not by the displayed phone number or a
    // filtered Inbox search. This opens a deal even when its chat is not in
    // the first page or is temporarily hidden by an Inbox filter.
    void botGet<Conversation>(`/admin/conversations/by-lead/${encodeURIComponent(requestedLead)}`)
      .then(openChat)
      .catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedLead, convs, selected])

  useEffect(() => {
    if (!requestedClient || selected) return
    const loaded = convs.find(item => item.meta?.clientId === requestedClient)
    if (loaded) { openChat(loaded); return }
    void fetch(`/api/crm/dialogs/resolve?client=${encodeURIComponent(requestedClient)}`, { cache: 'no-store' })
      .then(async response => response.ok ? response.json() as Promise<{ botLeadId: string }> : Promise.reject())
      .then(async ({ botLeadId }) => {
        const conversation = await botGet<Conversation>(`/admin/conversations/by-lead/${encodeURIComponent(botLeadId)}`)
        const metaResponse = await fetch(`/api/crm/dialogs/meta?leads=${encodeURIComponent(botLeadId)}`, { cache: 'no-store' })
        const metaPayload = metaResponse.ok ? await metaResponse.json() as { items: DialogMeta[] } : { items: [] }
        openChat({ ...conversation, meta: metaPayload.items[0] })
      }).catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedClient, convs, selected])

  useEffect(() => {
    if (!requestedConversation || loading || selected) return
    const match = convs.find(item => String(item.id) === requestedConversation)
    if (match) openChat(match)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedConversation, loading, convs, selected])

  useEffect(() => { bottomRef.current?.scrollIntoView() }, [chat])

  // The approval is created asynchronously by the worker. Keep the open
  // conversation fresh so a generated/edited card cannot disappear merely
  // because one immediate refresh happened before the worker finished.
  useEffect(() => {
    if (!selected) return
    const refreshChat = () => {
      void botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`).then(setChat).catch(() => undefined)
    }
    const timer = window.setInterval(refreshChat, 3000)
    return () => window.clearInterval(timer)
  }, [selected?.id, selected?.amocrm_lead_id])

  useEffect(() => {
    if (!selected) return
    const timer = setTimeout(() => {
      void botJson(`/admin/leads/${selected.id}/inbox`, 'PATCH', { draft_text: draft })
    }, 600)
    return () => clearTimeout(timer)
  }, [draft, selected])

  const updateInboxState = async (c: Conversation, patch: { pinned?: boolean; claim?: boolean }) => {
    if (patch.claim !== undefined) {
      const claimResponse = await fetch('/api/crm/dialogs/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: c.amocrm_lead_id, claimed: patch.claim }) })
      if (!claimResponse.ok) throw new Error((await claimResponse.json().catch(() => null))?.error || 'Не удалось назначить ответственного')
    }
    const result = await botJson<{ pinned_at: string | null; responsible_manager: string | null }>(`/admin/leads/${c.id}/inbox`, 'PATCH', patch)
    const next = { ...c, pinned_at: result.pinned_at, responsible_manager: result.responsible_manager }
    setConvs(prev => prev.map(item => item.id === c.id ? next : item))
    if (selected?.id === c.id) setSelected(next)
  }

  const toggleAi = async (c: Conversation) => {
    try {
      await botJson(`/admin/leads/${c.id}/ai`, 'PATCH', { enabled: !c.ai_enabled })
      setConvs(prev => prev.map(x => x.id === c.id ? { ...x, ai_enabled: !c.ai_enabled } : x))
      if (selected?.id === c.id) setSelected({ ...c, ai_enabled: !c.ai_enabled })
    } catch { /* noop */ }
  }

  const refreshAfterManagerSend = (conversation: Conversation) => {
    const next = { ...conversation, ai_enabled: false }
    setConvs(current => current.map(item => item.id === conversation.id ? next : item))
    if (conversation.ai_enabled) setActionStatus('ИИ-бот отключён, так как вы начали общение с клиентом.')
    openChat(next)
  }

  const sendManual = async () => {
    if (!selected || !draft.trim() || sending) return
    setSending(true)
    try {
      await botJson(`/admin/leads/${selected.id}/messages`, 'POST', { text: draft.trim() })
      setDraft('')
      refreshAfterManagerSend(selected)
    } catch {
      alert('Не удалось отправить')
    } finally {
      setSending(false)
    }
  }

  const generateReply = async () => {
    if (!selected || generatingReply) return
    setGeneratingReply(true)
    setGenerationStatus('Запрос принят. ИИ анализирует переписку…')
    try {
      await botJson(`/admin/leads/${selected.id}/generate-reply`, 'POST')
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1200))
        const refreshed = await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`)
        setChat(refreshed)
        if (refreshed.messages.some(message => message.status === 'pending_review' && message.approval_id)) {
          setGenerationStatus('Ответ готов. Проверьте его ниже и примите или отмените.')
          return
        }
        if (attempt === 5) setGenerationStatus('ИИ всё ещё готовит ответ. Это может занять немного времени…')
      }
      setGenerationStatus('Ответ всё ещё готовится. Оставьте диалог открытым — карточка появится автоматически.')
    } catch (error) {
      // A double click or a slow first request can return 409 while the
      // approval already exists. Load it instead of showing a dead-end error.
      try {
        const refreshed = await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`)
        setChat(refreshed)
        if (refreshed.messages.some(message => message.status === 'pending_review' && message.approval_id)) {
          setGenerationStatus('Ответ уже готов к согласованию. Проверьте его ниже и примите или отмените.')
        } else {
          setGenerationStatus(error instanceof Error ? error.message : 'Не удалось подготовить ответ ИИ')
        }
      } catch {
        setGenerationStatus(error instanceof Error ? error.message : 'Не удалось подготовить ответ ИИ')
      }
    } finally {
      setGeneratingReply(false)
    }
  }

  const getReplyOptions = async () => {
    if (!selected || assistantLoading) return
    setAssistantLoading(true)
    try {
      const result = await botJson<{ options: ReplyOption[] }>(`/admin/leads/${selected.id}/reply-options`, 'POST', { instruction: assistantInstruction, count: replyOptionCount })
      setReplyOptions(result.options)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Не удалось подготовить варианты')
    } finally { setAssistantLoading(false) }
  }

  const sendSuggested = async (text: string) => {
    if (!selected || sending) return
    setSending(true)
    try {
      await botJson(`/admin/leads/${selected.id}/messages`, 'POST', { text })
      setReplyOptions(null)
      refreshAfterManagerSend(selected)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Не удалось отправить сообщение')
    } finally { setSending(false) }
  }

  const sendMedia = async (file: File) => {
    if (!selected || sending) return
    setSending(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(`/api/backend/admin/leads/${selected.id}/media`, { method: 'POST', body: form })
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Не удалось отправить файл')
      refreshAfterManagerSend(selected)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Не удалось отправить файл')
    } finally { setSending(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const toggleRecording = async () => {
    if (dictationTarget) {
      alert('Сначала остановите диктовку текста')
      return
    }
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderChunksRef.current = []
      recorder.ondataavailable = event => { if (event.data.size) recorderChunksRef.current.push(event.data) }
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop())
        setRecording(false)
        const recordedType = (recorder.mimeType || 'audio/webm').split(';')[0]
        const extension = recordedType === 'audio/mp4' ? 'm4a' : recordedType === 'audio/ogg' ? 'ogg' : 'webm'
        const blob = new Blob(recorderChunksRef.current, { type: recordedType })
        void sendMedia(new File([blob], `voice-${Date.now()}.${extension}`, { type: recordedType }))
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch { alert('Не удалось получить доступ к микрофону') }
  }

  const appendDictation = (target: string, text: string) => {
    if (target === 'draft') setDraft(current => `${current} ${text}`.trim())
    if (target === 'assistant') setAssistantInstruction(current => `${current} ${text}`.trim())
    if (target.startsWith('approval:')) {
      setAiPromptApprovalId(Number(target.slice('approval:'.length)))
      setAiEditPrompt(current => `${current} ${text}`.trim())
    }
  }

  const toggleDictation = async (target: string) => {
    if (dictationTarget) {
      if (dictationTarget === target) dictationRecorderRef.current?.stop()
      return
    }
    if (recording) {
      alert('Сначала остановите голосовое сообщение')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      dictationChunksRef.current = []
      dictationTargetRef.current = target
      recorder.ondataavailable = event => { if (event.data.size) dictationChunksRef.current.push(event.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop())
        const stoppedTarget = dictationTargetRef.current
        dictationTargetRef.current = null
        setDictationTarget(null)
        if (!stoppedTarget) return
        const recordedType = (recorder.mimeType || 'audio/webm').split(';')[0]
        const extension = recordedType === 'audio/mp4' ? 'm4a' : recordedType === 'audio/ogg' ? 'ogg' : 'webm'
        const blob = new Blob(dictationChunksRef.current, { type: recordedType })
        if (!blob.size) return
        setTranscribingTarget(stoppedTarget)
        try {
          const form = new FormData()
          form.set('file', new File([blob], `dictation-${Date.now()}.${extension}`, { type: recordedType }))
          const response = await fetch('/api/backend/admin/transcribe', { method: 'POST', body: form })
          const payload = await response.json().catch(() => null) as { text?: string; detail?: string } | null
          if (!response.ok || !payload?.text) throw new Error(payload?.detail || 'Не удалось распознать запись')
          appendDictation(stoppedTarget, payload.text)
        } catch (error) {
          alert(error instanceof Error ? error.message : 'Не удалось распознать запись')
        } finally {
          setTranscribingTarget(null)
        }
      }
      dictationRecorderRef.current = recorder
      recorder.start()
      setDictationTarget(target)
    } catch {
      alert('Не удалось получить доступ к микрофону')
    }
  }

  const dictationButton = (target: string, title = 'Надиктовать текст') => {
    const active = dictationTarget === target
    const loadingTarget = transcribingTarget === target
    return <button
      type="button"
      onClick={() => void toggleDictation(target)}
      disabled={Boolean(transcribingTarget) || (Boolean(dictationTarget) && !active)}
      title={active ? 'Остановить и распознать' : title}
      aria-label={active ? 'Остановить и распознать' : title}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors disabled:opacity-40 ${active ? 'animate-pulse border-red-200 bg-red-50 text-red-700' : 'border-[#dbe8ee] bg-[#eef5f9] text-[#0c4d6c] hover:bg-[#dcecf3]'}`}
    >{loadingTarget ? <LoaderCircle size={14} className="animate-spin" /> : active ? <Square size={12} /> : <Mic size={14} />}</button>
  }

  const decideApproval = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    if (!selected || !message.approval_id || decidingApprovalId) return
    setDecidingApprovalId(message.approval_id)
    setDecisionKind(decision)
    setActionStatus(decision === 'approve' ? 'Отправляем ответ клиенту…' : 'Отменяем черновик — клиенту ничего не будет отправлено…')
    try {
      if (decision === 'approve') {
        await botJson(`/admin/approvals/${message.approval_id}/approve`, 'POST', { reply: message.text })
      } else {
        await botJson(`/admin/approvals/${message.approval_id}/reject`, 'POST', { reason: 'Отклонено менеджером в диалоге' })
      }
      setActionStatus(decision === 'approve' ? 'Ответ отправлен клиенту.' : 'Черновик отменён. Клиенту ничего не отправлялось.')
      await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`).then(setChat)
    } catch (error) {
      // Refresh anyway: a network response can be lost after the backend has
      // already completed the action. The fresh state is more trustworthy
      // than an alert that leaves an old approval card on screen.
      await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`).then(setChat).catch(() => undefined)
      setActionStatus(error instanceof Error ? error.message : 'Не удалось выполнить действие. Диалог обновлён — проверьте текущий статус.')
    } finally {
      setDecidingApprovalId(null)
      setDecisionKind(null)
    }
  }

  const editApprovalWithAi = async (message: ChatMessage) => {
    if (!selected || !message.approval_id || aiEditingId || !aiEditPrompt.trim()) return
    setAiEditingId(message.approval_id)
    setActionStatus('ИИ улучшает ответ…')
    try {
      await botJson(`/admin/approvals/${message.approval_id}/ai-edit`, 'POST', { prompt: aiEditPrompt.trim() })
      setAiEditPrompt('')
      setAiPromptApprovalId(null)
      await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`).then(setChat)
      setActionStatus('Ответ ИИ обновлён. Проверьте его и примите или отмените.')
    } catch (error) {
      await botGet<ChatData>(`/admin/chat/${selected.amocrm_lead_id}`).then(setChat).catch(() => undefined)
      setActionStatus(error instanceof Error ? error.message : 'Не удалось улучшить ответ. Диалог обновлён — проверьте текущий статус.')
    } finally {
      setAiEditingId(null)
    }
  }

  const dialogTags = useMemo(() => Array.from(new Map(convs.flatMap(item => item.meta?.tags ?? []).map(tag => [tag.id, tag])).values()), [convs])
  const dialogCities = useMemo(() => Array.from(new Set(convs.map(item => item.meta?.city).filter(Boolean) as string[])).sort(), [convs])
  const displayedConvs = useMemo(() => convs.filter(item => {
    const meta = item.meta
    if (responsibleFilter === 'unassigned' && (meta?.responsibleEmployeeId || item.responsible_manager)) return false
    if (employeeFilter && meta?.responsibleEmployeeId !== employeeFilter) return false
    if (stageFilter && meta?.stageId !== stageFilter) return false
    if (tagFilter && !meta?.tags.some(tag => tag.id === tagFilter)) return false
    if (cityFilter && meta?.city !== cityFilter) return false
    if (deadlineFilter === 'overdue' && !meta?.overdue) return false
    if (deadlineFilter === 'current' && meta?.overdue) return false
    if (urgentOnly && !meta?.urgent) return false
    if (attentionOnly && !meta?.attention) return false
    if (taskFilter === 'with' && !meta?.hasTasks) return false
    if (taskFilter === 'without' && meta?.hasTasks) return false
    return true
  }), [attentionOnly, cityFilter, convs, deadlineFilter, employeeFilter, responsibleFilter, stageFilter, tagFilter, taskFilter, urgentOnly])

  const changeStage = async (conversation: Conversation, nextStageId: string) => {
    if (!conversation.meta?.dealId) return
    const result = await moveDeal(conversation.meta.dealId, nextStageId)
    if (!result.success) { setActionStatus(result.error); return }
    setConvs(current => current.map(item => item.id === conversation.id && item.meta ? { ...item, meta: { ...item.meta, stageId: nextStageId } } : item))
    setSelected(current => current?.id === conversation.id && current.meta ? { ...current, meta: { ...current.meta, stageId: nextStageId } } : current)
    setActionStatus('Этап сделки изменён.')
  }

  return (
    <div className="p-4 md:p-6 h-[calc(100vh-52px)] flex gap-4">
      {/* Список диалогов */}
      <div className={`flex flex-col rounded-2xl bg-white overflow-hidden w-full md:w-80 md:flex-shrink-0 ${selected ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-3" style={{ borderBottom: '1px solid #ebebee' }}>
          <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: '#f5f6f8' }}>
            <Search size={14} color="#8a97a5" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Имя, телефон, ID клиента..."
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: '#0c2136' }}
            />
            <button onClick={reload} title="Обновить"><RefreshCw size={13} color="#8a97a5" /></button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button onClick={() => setUnreadOnly(value => !value)} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${unreadOnly ? 'bg-[#0c4d6c] text-white' : 'bg-[#f5f6f8] text-[#617786]'}`}>Непрочитанные</button>
            <button onClick={() => setResponsibleFilter(value => value === 'mine' ? 'all' : 'mine')} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${responsibleFilter === 'mine' ? 'bg-[#0c4d6c] text-white' : 'bg-[#f5f6f8] text-[#617786]'}`}>Мои</button>
            <select value={source} onChange={event => setSource(event.target.value)} className="rounded-lg bg-[#f5f6f8] px-2 py-1 text-[11px] text-[#617786] outline-none">
              <option value="">Все каналы</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option>
            </select>
            <button onClick={() => setFiltersOpen(value => !value)} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${filtersOpen ? 'bg-[#dbeafe] text-[#075a78]' : 'bg-[#f5f6f8] text-[#617786]'}`}>Фильтры</button>
          </div>
          {filtersOpen && <div className="mt-2 grid gap-1.5">
            <select value={responsibleFilter} onChange={e => setResponsibleFilter(e.target.value as typeof responsibleFilter)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="all">Все ответственные</option><option value="mine">Мои</option><option value="unassigned">Без ответственного</option></select>
            <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="">Любой сотрудник</option>{dialogEmployees.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="">Любой этап</option>{dialogStages.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="">Любой тег</option>{dialogTags.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <select value={cityFilter} onChange={e => setCityFilter(e.target.value)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="">Любой город</option>{dialogCities.map(x => <option key={x} value={x}>{x}</option>)}</select>
            <div className="grid grid-cols-2 gap-1.5"><select value={deadlineFilter} onChange={e => setDeadlineFilter(e.target.value as typeof deadlineFilter)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="all">Любой срок</option><option value="overdue">Просроченные</option><option value="current">Непросроченные</option></select><select value={taskFilter} onChange={e => setTaskFilter(e.target.value as typeof taskFilter)} className="rounded-lg border border-[#dbe8ee] bg-white px-2 py-1.5 text-[11px] text-[#17364c]"><option value="all">Любые задачи</option><option value="with">С задачами</option><option value="without">Без задач</option></select></div>
            <div className="flex gap-1.5"><button onClick={() => setUrgentOnly(v => !v)} className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${urgentOnly ? 'bg-red-50 text-red-700' : 'bg-[#f5f6f8] text-slate-500'}`}>Срочные</button><button onClick={() => setAttentionOnly(v => !v)} className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${attentionOnly ? 'bg-amber-50 text-amber-700' : 'bg-[#f5f6f8] text-slate-500'}`}>Внимание</button></div>
          </div>}
        </div>
        <div ref={listRef} data-private className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm" style={{ color: '#8a97a5' }}>Загрузка...</p>}
          {!loading && displayedConvs.length === 0 && <p className="p-4 text-sm" style={{ color: '#8a97a5' }}>Диалогов нет</p>}
          {displayedConvs.map(c => {
            const stage = dialogStages.find(item => item.id === c.meta?.stageId)
            const rawSource = (c.meta?.source || c.source || '').toLowerCase()
            const isInstagram = rawSource.includes('instagram')
            const ChannelIcon = isInstagram ? Camera : MessageCircle
            return (
            <button
              key={c.id}
              onClick={() => openChat(c)}
              className="w-full text-left px-4 py-3 transition-colors"
              style={{
                borderBottom: '1px solid #f1f2f4',
                borderLeft: `4px solid ${stage?.color || '#dbe8ee'}`,
                backgroundColor: selected?.id === c.id ? '#eef5f9' : 'transparent',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`font-medium text-sm truncate ${c.unread_count ? 'font-bold' : ''}`} style={{ color: '#0c2136' }}>
                  {c.meta?.fullName || c.client || c.meta?.phone || c.phone || 'Клиент без имени'}
                </span>
                <span className="flex items-center gap-1.5">
                {c.pinned_at && <Pin size={11} color="#0c4d6c" />}
                {c.unread_count > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-[#0c4d6c] px-1 text-[10px] font-bold text-white">{c.unread_count}</span>}
                <span
                  className="flex-shrink-0 rounded-full"
                  title={c.ai_enabled ? 'ИИ включён' : 'ИИ выключен'}
                  style={{ width: 8, height: 8, backgroundColor: c.ai_enabled ? '#16a34a' : '#d1d5db' }}
                />
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1 text-xs" style={{ color: isInstagram ? '#a21caf' : '#15803d' }}><ChannelIcon size={12}/>{isInstagram ? 'Instagram' : 'WhatsApp'}{stage && <span className="truncate text-slate-500">· {stage.name}</span>}</span>
                <span className="text-xs flex-shrink-0" style={{ color: '#b3bcc5' }}>{fmt(c.last_message_at)}</span>
              </div>
              {c.preview_text && <p className="mt-1 truncate text-xs text-slate-500">{previewLabel(c.preview_text)}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-1">{c.meta?.responsibleName && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">{c.meta.responsibleName}</span>}{c.meta?.tags.slice(0, 2).map(tag => <span key={tag.id} className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold text-white" style={{ backgroundColor: tag.color }}>{tag.name}</span>)}{c.meta?.urgent && <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700">Срочно</span>}{c.meta?.overdue && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">Просрочено</span>}{c.meta && !c.meta.overdue && <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">Не просрочено</span>}</div>
            </button>
          )})}
          {/* Сентинел для догрузки при прокрутке */}
          {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
          {loadingMore && <p className="p-3 text-xs text-center" style={{ color: '#b3bcc5' }}>Загрузка ещё...</p>}
        </div>
      </div>

      {/* Чат */}
      <div className={`flex-col rounded-2xl bg-white overflow-hidden flex-1 min-w-0 ${selected ? 'flex' : 'hidden md:flex'}`}>
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: '#b3bcc5' }}>
            <Bot size={36} />
            <p className="text-sm">Выберите диалог слева</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid #ebebee' }}>
              <button className="md:hidden text-sm" style={{ color: '#0c4d6c' }} onClick={closeChat}>←</button>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate" style={{ color: '#0c2136' }}>
                  {chat?.client_name || selected.client || 'Без имени'}
                </p>
                <p className="text-xs truncate" style={{ color: '#8a97a5' }}>
                  {chat?.client_phone || selected.meta?.phone || selected.phone || ''}
                </p>
              </div>
              {selected.meta && <select value={selected.meta.stageId} onChange={event => void changeStage(selected, event.target.value)} className="hidden h-[30px] max-w-44 rounded-lg border border-[#dbe8ee] bg-white px-2 text-[11px] font-semibold text-[#0c4d6c] lg:block" title="Этап сделки">{dialogStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}
              {selected.meta?.dealId && <button onClick={() => router.push(`/dashboard/deals?highlight=${encodeURIComponent(selected.meta!.dealId)}`)} className="hidden h-[30px] items-center gap-1 rounded-lg bg-[#eef5f9] px-2 text-[11px] font-semibold text-[#0c4d6c] xl:flex"><BriefcaseBusiness size={13}/> В сделках</button>}
              <button
                onClick={() => toggleAi(selected)}
                aria-pressed={selected.ai_enabled}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1784a6]/40 ${selected.ai_enabled
                  ? 'border-[#15803d] bg-[#15803d] text-white shadow-sm'
                  : 'border-[#d9e3e8] bg-[#f3f4f6] text-[#6b7280] hover:border-[#a9bdc8] hover:bg-[#e8eff3]'}`}
              >
                {selected.ai_enabled ? <Power size={12} /> : <PowerOff size={12} />}
                {selected.ai_enabled ? 'ИИ вкл' : 'ИИ выкл'}
              </button>
              <button onClick={() => void generateReply()} disabled={generatingReply} aria-busy={generatingReply} className={`flex h-[30px] items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 disabled:cursor-wait ${generatingReply ? 'border-[#6d28d9] bg-[#6d28d9] text-white shadow-sm' : 'border-[#ddd6fe] bg-[#ede9fe] text-[#5b21b6] hover:border-[#a78bfa] hover:bg-[#ddd6fe]'}`} title="Подготовить ответ и отправить на согласование">
                {generatingReply ? <LoaderCircle size={13} className="animate-spin" /> : <Bot size={13} />}
                {generatingReply ? 'Генерирую…' : 'Сгенерировать'}
              </button>
              <button onClick={() => { setClientCardOpen(value => !value); setAssistantOpen(false) }} aria-pressed={clientCardOpen} className={`hidden h-[30px] items-center rounded-lg border px-2 text-[11px] font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1784a6]/40 md:flex ${clientCardOpen ? 'border-[#075a78] bg-[#075a78] text-white shadow-sm' : 'border-[#dbe8ee] bg-[#eef5f9] text-[#0c4d6c] hover:border-[#8fb7c8] hover:bg-[#dcecf3]'}`}>Карточка</button>
              <button onClick={() => { setAssistantOpen(value => !value); setClientCardOpen(false) }} aria-pressed={assistantOpen} className={`hidden h-[30px] items-center rounded-lg border px-2 text-[11px] font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 md:flex ${assistantOpen ? 'border-[#6d28d9] bg-[#6d28d9] text-white shadow-sm' : 'border-[#ddd6fe] bg-[#ede9fe] text-[#5b21b6] hover:border-[#a78bfa] hover:bg-[#ddd6fe]'}`}>Помощник</button>
              <button onClick={() => void updateInboxState(selected, { claim: !selected.responsible_manager })} aria-pressed={Boolean(selected.responsible_manager)} title={selected.responsible_manager ? `Ответственный: ${selected.responsible_manager}` : 'Взять диалог'} className={`flex h-[30px] items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1784a6]/40 ${selected.responsible_manager ? 'border-[#075a78] bg-[#075a78] text-white shadow-sm' : 'border-[#dbe8ee] bg-[#eef5f9] text-[#0c4d6c] hover:border-[#8fb7c8] hover:bg-[#dcecf3]'}`}><UserCheck size={13} />{selected.responsible_manager || 'Взять'}</button>
              <button onClick={() => void updateInboxState(selected, { pinned: !selected.pinned_at })} aria-pressed={Boolean(selected.pinned_at)} title={selected.pinned_at ? 'Открепить' : 'Закрепить'} className={`grid h-[30px] w-[30px] place-items-center rounded-lg border transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${selected.pinned_at ? 'border-[#d97706] bg-[#d97706] text-white shadow-sm' : 'border-[#d9e3e8] bg-[#f3f4f6] text-[#617786] hover:border-[#b8c7d0] hover:bg-[#e8eff3]'}`}>{selected.pinned_at ? <PinOff size={13} /> : <Pin size={13} />}</button>
            </div>

            <div
              data-private
              onClick={event => { if (event.target === event.currentTarget) setClientCardOpen(false) }}
              className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
              style={{ backgroundColor: '#f9fafb' }}
            >
              {generationStatus && <div className="flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-800">
                {generatingReply && <span className="size-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />}
                <span>{generationStatus}</span>
                {!generatingReply && <button onClick={() => setGenerationStatus(null)} className="ml-auto text-violet-700" aria-label="Закрыть">×</button>}
              </div>}
              {actionStatus && <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
                {(decidingApprovalId || aiEditingId) && <LoaderCircle size={14} className="animate-spin shrink-0" />}
                <span>{actionStatus}</span>
                {!decidingApprovalId && !aiEditingId && <button onClick={() => setActionStatus(null)} className="ml-auto" aria-label="Закрыть">×</button>}
              </div>}
              {chatLoading && <p className="text-sm text-center" style={{ color: '#8a97a5' }}>Загрузка чата...</p>}
              {!chatLoading && chat?.messages.length === 0 && (
                <p className="text-sm text-center mt-8" style={{ color: '#8a97a5' }}>Сообщений нет</p>
              )}
              {chat?.messages.map(m => {
                const isClient = m.speaker === 'client' || m.role === 'user'
                const isManager = m.speaker === 'manager' || m.role === 'manager'
                const isBot = !isClient && !isManager
                const actorName = isManager ? (m.author_name || 'Менеджер') : isBot ? (m.author_name || 'ИИ бот') : 'Клиент'
                const actorColor = isManager ? employeeColor(actorName) : isBot ? BOT_COLOR : '#64748b'
                const pending = m.status === 'pending_review' && !!m.approval_id
                const media = mediaHref(m)
                const isVoice = /voice|audio|голосов/i.test(m.message_type || m.text)
                const isImage = /image|photo|picture|фото/i.test(m.message_type || m.text)
                const mediaLabel = isVoice ? 'Голосовое сообщение' : isImage ? 'Изображение' : null
                const messageParts = displayParts(m.text)
                return (
                  <div key={m.id} className={`flex flex-col max-w-[80%] ${isClient ? 'items-start self-start' : 'items-end self-end'}`}>
                    <div className="flex items-center gap-1.5 text-[10px] mb-0.5" style={{ color: actorColor }}>
                      <span className="grid size-4 place-items-center rounded-full text-[7px] font-bold text-white" style={{ backgroundColor: actorColor }}>{isClient ? 'К' : initials(actorName)}</span>
                      {isClient ? <><User size={9} /> Клиент</> : isManager ? <><Headset size={9} /> {actorName}</> : <><Bot size={9} /> {actorName}</>}
                      <span style={{ color: '#b3bcc5' }}>{fmt(m.created_at)}</span>
                    </div>
                    <div className="flex w-full flex-col gap-1.5">
                      {messageParts.map((part, index) => (
                        <div
                          key={`${m.id}-${index}`}
                          className="px-3.5 py-2 text-sm whitespace-pre-wrap break-words rounded-2xl"
                          style={isClient
                            ? { backgroundColor: '#ffffff', border: '1px solid #e5e7eb', color: '#0c2136', borderBottomLeftRadius: 4 }
                            : isManager
                              ? { backgroundColor: colorAlpha(actorColor, 0.13), border: `1px solid ${colorAlpha(actorColor, 0.28)}`, color: '#17364c', borderBottomRightRadius: 4 }
                              : { backgroundColor: BOT_COLOR, color: '#ffffff', borderBottomRightRadius: 4 }}
                        >
                          {index === 0 && media && isImage && <img src={media} alt="Изображение клиента" className="mb-2 max-h-72 max-w-full rounded-xl object-contain" />}
                          {index === 0 && media && isVoice && <audio src={media} controls className="mb-1 max-w-full" />}
                          {mediaLabel && media ? part.replace(media, '').replace(/^\s*\[[^\]]+\]\s*/, '').trim() || (index === 0 ? mediaLabel : '') : part}
                        </div>
                      ))}
                    </div>
                    {pending ? (
                      <div className="mt-2 flex w-full flex-wrap items-center justify-end gap-1.5">
                        <span className="mr-auto text-[10px] font-semibold text-amber-600">Ожидает подтверждения</span>
                        <div className="flex w-full gap-1.5">
                          <input
                            value={aiPromptApprovalId === m.approval_id ? aiEditPrompt : ''}
                            onChange={event => { setAiPromptApprovalId(m.approval_id!); setAiEditPrompt(event.target.value) }}
                            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void editApprovalWithAi(m) } }}
                            placeholder="Как улучшить ответ?"
                            className="min-w-0 flex-1 rounded-lg border border-[#cbd5e1] bg-white px-2 py-1 text-[11px] text-[#0c2136] outline-none"
                          />
                          {dictationButton(`approval:${m.approval_id}`, 'Надиктовать пожелание для ИИ')}
                          <button
                            onClick={() => void editApprovalWithAi(m)}
                            disabled={!aiEditPrompt.trim() || aiEditingId !== null || decidingApprovalId !== null}
                            className="rounded-lg bg-[#e0e7ff] px-2 py-1 text-[11px] font-semibold text-[#3730a3] disabled:opacity-50"
                          >{aiEditingId === m.approval_id ? <span className="inline-flex items-center gap-1"><LoaderCircle size={11} className="animate-spin" /> Улучшаю…</span> : 'ИИ улучшить'}</button>
                        </div>
                        <button
                          onClick={() => void decideApproval(m, 'reject')}
                          disabled={decidingApprovalId !== null || aiEditingId !== null}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 disabled:opacity-50"
                        >
                          {decidingApprovalId === m.approval_id && decisionKind === 'reject' ? <LoaderCircle size={11} className="animate-spin" /> : <X size={11} />}
                          {decidingApprovalId === m.approval_id && decisionKind === 'reject' ? 'Отменяем…' : 'Отменить'}
                        </button>
                        <button
                          onClick={() => void decideApproval(m, 'approve')}
                          disabled={decidingApprovalId !== null || aiEditingId !== null}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#0c4d6c] px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                        >
                          {decidingApprovalId === m.approval_id && decisionKind === 'approve' ? <LoaderCircle size={11} className="animate-spin" /> : <Check size={11} />}
                          {decidingApprovalId === m.approval_id && decisionKind === 'approve' ? 'Отправляем…' : 'Подтвердить и отправить'}
                        </button>
                      </div>
                    ) : isBot && (
                      <span
                        className="mt-0.5 text-[10px] font-semibold"
                        style={{ color: m.status === 'send_failed' ? '#dc2626' : m.status === 'pending_review' ? '#d97706' : ['sent', 'delivered', 'read'].includes(m.status) ? '#16a34a' : '#8a97a5' }}
                      >
                        {m.status === 'send_failed' ? '#не отправлено' : m.status === 'queued' ? '#отправляется' : m.status === 'pending_review' ? '#на модерации' : m.status === 'delivered' ? '#доставлено' : m.status === 'read' ? '#прочитано' : m.status === 'sent' ? '#отправлено' : '#сохранено'}
                      </span>
                    )}
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <div className="flex gap-2 p-3 flex-shrink-0" style={{ borderTop: '1px solid #ebebee' }}>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void sendMedia(file) }} />
              <div className="flex flex-col justify-end gap-1.5">
                <button onClick={() => fileRef.current?.click()} disabled={sending} title="Отправить фото" className="grid h-9 w-9 place-items-center rounded-xl bg-[#eef5f9] text-[#0c4d6c] disabled:opacity-50"><ImagePlus size={16} /></button>
                <button onClick={() => void toggleRecording()} disabled={sending} title={recording ? 'Остановить и отправить' : 'Записать и отправить голосовое клиенту'} className={`grid h-9 w-9 place-items-center rounded-xl disabled:opacity-50 ${recording ? 'animate-pulse bg-red-100 text-red-700' : 'bg-[#eef5f9] text-[#0c4d6c]'}`}>{recording ? <Square size={14} /> : <Mic size={16} />}</button>
              </div>
              <div className="relative flex-1">
                <textarea
                  rows={2}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) sendManual() }}
                  placeholder="Ответить клиенту вручную... (Ctrl+Enter)"
                  className="h-full w-full resize-none rounded-xl py-2 pl-3 pr-11 text-sm outline-none"
                  style={{ backgroundColor: '#f5f6f8', color: '#0c2136' }}
                />
                <div className="absolute bottom-2 right-2">{dictationButton('draft', 'Надиктовать ответ текстом')}</div>
              </div>
              <button
                onClick={sendManual}
                disabled={sending || !draft.trim()}
                className="self-end flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#0c4d6c' }}
              >
                <Send size={14} /> {sending ? '...' : 'Отправить'}
              </button>
            </div>
          </>
        )}
      </div>
      {selected && <aside className={`hidden shrink-0 overflow-hidden rounded-2xl bg-white transition-[width,opacity,transform] duration-300 ease-out dark:bg-slate-900 md:block ${clientCardOpen ? 'w-[360px] translate-x-0 opacity-100' : 'pointer-events-none w-0 translate-x-4 opacity-0'}`} aria-hidden={!clientCardOpen}>
        <div className="h-full w-[360px] overflow-y-auto p-4">
        <h2 className="text-sm font-bold text-[#0c2136] dark:text-white">Карточка клиента</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-300">Контакты, теги, заметки и задачи — всё редактируется здесь</p>
        <div className="mt-4">{selected.meta?.clientId ? <DialogClientPanel clientId={selected.meta.clientId} dealId={selected.meta.dealId || null} extracted={chat?.client_card} onSaved={value => {
          setSelected(current => current ? { ...current, client: value.fullName || current.client, phone: value.phone || current.phone, meta: current.meta ? { ...current.meta, fullName: value.fullName || null, phone: value.phone || null, city: value.city || null, tags: value.tags, hasTasks: value.hasTasks ?? current.meta.hasTasks } : current.meta } : current)
          setConvs(current => current.map(item => item.id === selected.id ? { ...item, client: value.fullName || item.client, phone: value.phone || item.phone, meta: item.meta ? { ...item.meta, fullName: value.fullName || null, phone: value.phone || null, city: value.city || null, tags: value.tags, hasTasks: value.hasTasks ?? item.meta.hasTasks } : item.meta } : item))
        }}/> : <p className="rounded-xl bg-[#f5f6f8] p-3 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-300">Для этого диалога ещё не создана карточка клиента в CRM.</p>}</div>
        </div>
      </aside>}
      {selected && <aside className={`hidden shrink-0 overflow-hidden rounded-2xl bg-white transition-[width,opacity,transform] duration-300 ease-out md:block ${assistantOpen ? 'w-80 translate-x-0 opacity-100' : 'pointer-events-none w-0 translate-x-4 opacity-0'}`} aria-hidden={!assistantOpen}>
        <div className="w-80 overflow-y-auto p-4">
        <h2 className="text-sm font-bold text-[#0c2136]">ИИ-помощник</h2>
        <p className="mt-1 text-xs text-slate-500">Подготовит несколько разных ответов по последнему сообщению клиента.</p>
        <div className="relative mt-3">
          <textarea value={assistantInstruction} onChange={event => setAssistantInstruction(event.target.value)} placeholder="Что учесть в ответе?" className="min-h-20 w-full resize-none rounded-xl border border-[#dbe8ee] bg-[#f8fbfc] py-2 pl-2 pr-11 text-sm text-[#17364c] outline-none" />
          <div className="absolute bottom-2 right-2">{dictationButton('assistant', 'Надиктовать, что учесть')}</div>
        </div>
        <div className="mt-2 flex items-center justify-between rounded-xl border border-[#e5ddff] bg-[#faf8ff] p-2">
          <label htmlFor="reply-option-count" className="text-xs font-semibold text-[#5b21b6]">Количество вариантов</label>
          <input id="reply-option-count" type="number" min={1} max={6} value={replyOptionCount} onChange={event => setReplyOptionCount(Math.min(6, Math.max(1, Number(event.target.value) || 1)))} className="h-8 w-14 rounded-lg border border-[#c4b5fd] bg-white text-center text-sm font-bold text-[#5b21b6] outline-none" />
        </div>
        <button onClick={() => void getReplyOptions()} disabled={assistantLoading} className="mt-2 w-full rounded-xl bg-[#6d28d9] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{assistantLoading ? 'Готовлю варианты...' : `Предложить ${replyOptionCount} ${replyOptionCount === 1 ? 'вариант' : replyOptionCount < 5 ? 'варианта' : 'вариантов'}`}</button>
        {replyOptions && <div className="mt-4 space-y-3">
          {replyOptions.map(option => <div key={option.approach} className="rounded-xl border border-[#e5ddff] bg-[#faf8ff] p-3"><p className="text-xs font-bold text-[#6d28d9]">{option.approach}</p><p className="mt-1 whitespace-pre-wrap text-sm text-[#17364c]">{option.text}</p><button onClick={() => void sendSuggested(option.text)} disabled={sending} className="mt-2 rounded-lg bg-[#0c4d6c] px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Отправить клиенту</button></div>)}
        </div>}
        </div>
      </aside>}
    </div>
  )
}
