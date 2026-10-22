'use client'

import { use, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { botGet } from '@/lib/bot-api'
import { Bot, User, Headset, ArrowLeft } from 'lucide-react'

// Открывается по ссылке «История чата» из Telegram-карточки бота
// (backend/app/services/telegram.py → chat_history_url).

type ChatMessage = {
  id: number | string
  role: string
  text: string
  status: string
  created_at: string | null
  media_url: string | null
  message_type: string | null
}
type ChatData = {
  lead_id: string
  client_name: string | null
  client_phone: string | null
  amocrm_url: string
  messages: ChatMessage[]
}

function fmt(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const VOICE_MARKER_RE = /^\[(?:voice|audio)\]\s*https?:\/\/\S+\s*/

// Статус ответа бота. Раньше «принятым» (зелёным) показывалось всё, кроме
// pending_review — поэтому не доставленный в amoCRM ответ (send_failed) выглядел
// как успешно отправленный. Теперь каждый статус подписан честно.
function botTag(status: string): { label: string; color: string } {
  switch (status) {
    case 'pending_review': return { label: '#на модерации', color: '#d97706' }
    case 'send_failed':    return { label: '#не доставлено',  color: '#dc2626' }
    case 'queued':         return { label: '#отправляется',   color: '#8a97a5' }
    case 'sent':
    default:               return { label: '#принято',        color: '#16a34a' }
  }
}

// Голосовые сообщения хранятся как `[voice] <amoCRM-ссылка> <расшифровка>` — та же
// разметка, что использует backend/app/services/telegram.py для карточек в Telegram.
function renderMessageBody(m: ChatMessage, leadId: string) {
  const isVoice = m.message_type === 'voice' || m.message_type === 'audio'
  if (isVoice && m.media_url) {
    const transcript = m.text.replace(VOICE_MARKER_RE, '').trim()
    return (
      <div className="flex flex-col gap-1.5">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls src={`/api/backend/admin/attachment/${m.id}?leadId=${encodeURIComponent(leadId)}`} style={{ height: 32, maxWidth: '100%' }} />
        {transcript && <span>{transcript}</span>}
      </div>
    )
  }
  return m.text
}

export default function ChatHistoryPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = use(params)

  const [chat, setChat] = useState<ChatData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    botGet<ChatData>(`/admin/chat/${leadId}`)
      .then(data => { setChat(data); setNotFound(false) })
      .catch(() => { setChat(null); setNotFound(true) })
      .finally(() => setLoading(false))
  }, [leadId])

  useEffect(() => { bottomRef.current?.scrollIntoView() }, [chat])

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#f5f6f8' }}>
      <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0" style={{ backgroundColor: '#0c2136' }}>
        <Link
          href="/dashboard/dialogs"
          className="flex items-center justify-center rounded-lg flex-shrink-0"
          style={{ width: 32, height: 32, backgroundColor: '#0c4d6c' }}
          title="Ко всем диалогам"
        >
          <ArrowLeft size={16} color="#ffffff" />
        </Link>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate text-white">
            {chat?.client_name || 'Без имени'}
          </p>
          <p className="text-xs truncate" style={{ color: '#a2b4c0' }}>
            {chat?.client_phone || `Диалог ${leadId}`}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {loading && <p className="text-sm text-center" style={{ color: '#8a97a5' }}>Загрузка чата...</p>}

        {!loading && notFound && (
          <div className="flex flex-col items-center justify-center gap-2 mt-16" style={{ color: '#8a97a5' }}>
            <Bot size={36} />
            <p className="text-sm">Диалог {leadId} не найден</p>
            <Link href="/dashboard/dialogs" className="text-sm font-medium" style={{ color: '#0c4d6c' }}>
              Ко всем диалогам
            </Link>
          </div>
        )}

        {!loading && chat?.messages.length === 0 && (
          <p className="text-sm text-center mt-8" style={{ color: '#8a97a5' }}>Сообщений нет</p>
        )}

        {chat?.messages.map(m => {
          const isClient = m.role === 'user'
          const isManager = m.role === 'manager'
          const isBot = !isClient && !isManager
          return (
            <div key={m.id} className={`flex flex-col max-w-[80%] ${isClient ? 'items-start self-start' : 'items-end self-end'}`}>
              <div className="flex items-center gap-1 text-[10px] mb-0.5" style={{ color: isManager ? '#16a34a' : '#8a97a5' }}>
                {isClient ? <><User size={9} /> Клиент</> : isManager ? <><Headset size={9} /> Консультант</> : <><Bot size={9} /> ИИ бот</>}
                <span style={{ color: '#b3bcc5' }}>{fmt(m.created_at)}</span>
              </div>
              <div
                className="px-3.5 py-2 text-sm whitespace-pre-wrap break-words rounded-2xl"
                style={isClient
                  ? { backgroundColor: '#ffffff', border: '1px solid #e5e7eb', color: '#0c2136', borderBottomLeftRadius: 4 }
                  : isManager
                    ? { backgroundColor: '#dcfce7', border: '1px solid #bbf7d0', color: '#14532d', borderBottomRightRadius: 4 }
                    : { backgroundColor: '#0c4d6c', color: '#ffffff', borderBottomRightRadius: 4 }}
              >
                {renderMessageBody(m, leadId)}
              </div>
              {isBot && (() => {
                const tag = botTag(m.status)
                return (
                  <span className="mt-0.5 text-[10px] font-semibold" style={{ color: tag.color }}>
                    {tag.label}
                  </span>
                )
              })()}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
