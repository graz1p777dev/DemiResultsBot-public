'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, Send, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePathname } from 'next/navigation'
import { botJson } from '@/lib/bot-api'

type ChatMessage = { id: number | string; role: 'user' | 'assistant'; content: string; buttons?: { label: string; href: string }[] }

function collectPageContext(path: string) {
  // Conversations contain customer names, messages and contact details.
  // Never send that page's DOM to the assistant, even if a future component
  // adds semantic buttons inside the chat.
  if (path.startsWith('/dashboard/dialogs') || path.startsWith('/chat/')) {
    return { path, title: document.title, extra: { page_elements: [] } }
  }
  const elements = Array.from(document.querySelectorAll('h1,h2,h3,h4,button,a,label,[role="button"]'))
    .filter(el => !el.closest('[data-private], [aria-label="private"], input, textarea, [contenteditable="true"]'))
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(text => text.length > 1 && text.length < 180)
  const main = document.querySelector('main')?.cloneNode(true) as HTMLElement | null
  main?.querySelectorAll('input,textarea,[contenteditable="true"],[data-private]').forEach(node => node.remove())
  const pageText = (main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000)
  return { path, title: document.title, extra: { page_elements: [...new Set(elements)].slice(0, 120), page_text: pageText } }
}

export default function CopilotDrawer() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [launcherPosition, setLauncherPosition] = useState<{ x: number; y: number } | null>(null)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number; startX: number; startY: number; moved: boolean } | null>(null)
  const suppressOpenRef = useRef(false)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('copilot-launcher-position')
      if (!saved) return
      const value = JSON.parse(saved)
      if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) setLauncherPosition(value)
    } catch { /* position is optional */ }
  }, [])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const x = Math.min(Math.max(112, event.clientX - drag.offsetX), window.innerWidth - 112)
      const y = Math.min(Math.max(30, event.clientY - drag.offsetY), window.innerHeight - 30)
      if (Math.abs(event.clientX - drag.startX) > 4 || Math.abs(event.clientY - drag.startY) > 4) drag.moved = true
      setLauncherPosition({ x, y })
    }
    const end = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      dragRef.current = null
      if (drag.moved) {
        suppressOpenRef.current = true
        setLauncherPosition(position => {
          if (position) window.localStorage.setItem('copilot-launcher-position', JSON.stringify(position))
          return position
        })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
  }, [])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages, sending])

  useEffect(() => {
    const openFromTopbar = (event: Event) => {
      setInput((event as CustomEvent<{ message?: string }>).detail?.message || '')
      setOpen(true)
    }
    window.addEventListener('copilot:open', openFromTopbar)
    return () => window.removeEventListener('copilot:open', openFromTopbar)
  }, [])

  const send = useCallback(async (value: string) => {
    const text = value.trim()
    if (!text || sending) return
    setInput(''); setSending(true)
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text }])
    try {
      const result = await botJson<{ conversation_id: number; message: ChatMessage }>('/copilot/chat', 'POST', {
        message: text,
        conversation_id: conversationId,
        page_context: collectPageContext(pathname),
      })
      setConversationId(result.conversation_id)
      setMessages(prev => [...prev, result.message])
    } catch {
      setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'assistant', content: 'Не удалось получить ответ. Проверьте подключение ИИ.' }])
    } finally { setSending(false) }
  }, [conversationId, pathname, sending])

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/20 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed right-0 top-0 z-50 flex h-screen w-full max-w-[420px] flex-col border-l border-[#cfdee5] bg-[#f7fbfd] shadow-2xl transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between border-b border-[#cfdee5] bg-[#0c4d6c] px-4 py-3 text-white">
          <div className="flex items-center gap-2"><Bot size={18} /><span className="font-semibold">ИИ‑помощник</span></div>
          <button onClick={() => setOpen(false)} aria-label="Закрыть помощника" className="rounded-lg p-1.5 hover:bg-white/10"><X size={18} /></button>
        </div>
        <div className="border-b border-[#cfdee5] bg-[#eef7fa] px-4 py-2 text-[11px] text-[#526b78]">Контекст страницы передаётся без содержимого чатов и полей ввода.</div>
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 && <div className="mt-10 text-center text-sm text-[#78909f]"><Sparkles className="mx-auto mb-3 text-[#0c4d6c]" size={30} /><p>Спросите, что делает эта страница или куда перейти.</p></div>}
          {messages.map(message => <div key={message.id} className={`flex flex-col gap-1 ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
            <span className="text-[10px] text-[#78909f]">{message.role === 'user' ? 'Вы' : 'ИИ‑помощник'}</span>
            <div className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm [&_p]:m-0 [&_p+p]:mt-2 ${message.role === 'user' ? 'rounded-br-sm bg-[#dceef5] text-[#0c2136]' : 'rounded-bl-sm bg-[#0c4d6c] text-white'}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
            {!!message.buttons?.length && <div className="flex flex-wrap gap-1.5">{message.buttons.map(button => <a key={button.href} href={button.href} className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-[#0c4d6c] shadow-sm">{button.label}<ChevronRight size={12} /></a>)}</div>}
          </div>)}
          {sending && <div className="rounded-2xl rounded-bl-sm bg-[#0c4d6c] px-3 py-2 text-white">…</div>}
        </div>
        <div className="flex gap-2 border-t border-[#cfdee5] bg-white p-3">
          <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input) } }} rows={1} placeholder="Спросите про эту страницу…" className="flex-1 resize-none rounded-xl border border-[#b9d7e4] bg-[#f5fafd] px-3 py-2 text-sm text-[#0c2136] outline-none" />
          <button onClick={() => void send(input)} disabled={sending || !input.trim()} className="self-end rounded-xl bg-[#0c4d6c] p-2.5 text-white disabled:opacity-50"><Send size={16} /></button>
        </div>
      </aside>
      <button
        onPointerDown={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false }
        }}
        onClick={() => {
          if (suppressOpenRef.current) {
            suppressOpenRef.current = false
            return
          }
          setOpen(true)
        }}
        aria-label="Открыть или переместить ИИ‑помощника"
        title="ИИ‑помощник — перетащите, если кнопка мешает"
        className="fixed z-30 flex touch-none select-none items-center gap-2 rounded-full bg-[#0c4d6c] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-[#086080]"
        style={launcherPosition ? { left: launcherPosition.x, top: launcherPosition.y, transform: 'translate(-50%, -50%)' } : { bottom: 20, right: 20 }}
      ><Sparkles size={16} /> ИИ‑помощник</button>
    </>
  )
}
