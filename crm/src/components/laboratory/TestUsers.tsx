'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { UserPlus, Send, Trash2, Beaker, RefreshCw, Mic, ExternalLink } from 'lucide-react'
import { botDelete, botGet, botJson } from '@/lib/bot-api'
import type { BotChatMessage, BotTestUser } from '@/types'

// Тестовый клиент использует тот же буфер и ИИ, но остаётся внутри CRM.
// Ни WhatsApp, ни Instagram, ни реальный клиент не получают тестовые сообщения.
const CHAT_POLL_MS = 3000

const btn = 'rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50'
const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none'
const inputStyle = { backgroundColor: '#f5f6f8', color: '#0c2136' } as const
const muted = { color: '#8a97a5' }

function roleLabel(role: string): string {
  if (role === 'user') return 'Клиент'
  if (role === 'assistant') return 'Бот'
  return 'Менеджер'
}

export default function TestUsers() {
  const [users, setUsers] = useState<BotTestUser[]>([])
  const [selected, setSelected] = useState<BotTestUser | null>(null)
  const [messages, setMessages] = useState<BotChatMessage[]>([])
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const chatRef = useRef<HTMLDivElement>(null)
  const voiceRef = useRef<HTMLInputElement>(null)

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await botGet<BotTestUser[]>('/admin/lab/test-users'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить тестовых пользователей')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    botGet<BotTestUser[]>('/admin/lab/test-users')
      .then((list) => {
        if (!cancelled) setUsers(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить тестовых пользователей')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // История чата тянется по amocrm_lead_id — тем же роутом, что и у живых лидов,
  // поэтому ссылка «Открыть в CRM» из карточки Telegram тоже работает.
  useEffect(() => {
    if (!selected) return
    let cancelled = false

    async function tick() {
      try {
        const data = await botGet<{ messages: BotChatMessage[] }>(`/admin/chat/${selected!.amocrm_lead_id}`)
        if (!cancelled) setMessages(data.messages ?? [])
      } catch {
        /* сеть моргнула — покажем на следующем тике */
      }
    }

    tick()
    const id = setInterval(tick, CHAT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selected])

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages])

  async function createUser() {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const user = await botJson<BotTestUser>('/admin/lab/test-users', 'POST', {
        name: name.trim(),
        contact: contact.trim() || null,
      })
      setName('')
      setContact('')
      setUsers((prev) => [user, ...prev])
      setSelected(user)
      setMessages([])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать тестового пользователя')
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage() {
    if (!selected || !draft.trim() || busy) return
    setBusy(true)
    try {
      const res = await botJson<{ delay_seconds: number }>(
        `/admin/lab/test-users/${selected.id}/messages`,
        'POST',
        { text: draft.trim() }
      )
      setDraft('')
      setError(null)
      // Бот копит сообщения в буфере, прежде чем позвать модель — иначе он
      // отвечал бы на каждую строчку отдельно. Пользователь не должен думать,
      // что ничего не произошло.
      setNotice(`Бот думает — ответ появится примерно через ${res.delay_seconds} с`)
      setTimeout(() => setNotice(null), (res.delay_seconds + 20) * 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить сообщение')
    } finally {
      setBusy(false)
    }
  }

  async function sendVoice(file: File) {
    if (!selected || busy) return
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(`/api/backend/admin/lab/test-users/${selected.id}/voice`, { method: 'POST', body: form })
      const result = await response.json() as { delay_seconds?: number; transcript?: string; detail?: string }
      if (!response.ok) throw new Error(result.detail || 'Не удалось добавить голосовое')
      setError(null)
      setNotice(result.transcript
        ? `Голосовое добавлено в CRM. Расшифровка: «${result.transcript}». Черновик ИИ появится примерно через ${result.delay_seconds ?? 0} с.`
        : `Голосовое добавлено в CRM. Распознавание не удалось — это тоже проверка: менеджер увидит важное сообщение.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить голосовое')
    } finally {
      setBusy(false)
      if (voiceRef.current) voiceRef.current.value = ''
    }
  }

  async function removeUser(user: BotTestUser) {
    if (busy) return
    setBusy(true)
    try {
      await botDelete(`/admin/lab/test-users/${user.id}`)
      setUsers((prev) => prev.filter((u) => u.id !== user.id))
      if (selected?.id === user.id) {
        setSelected(null)
        setMessages([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить тестового пользователя')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl overflow-hidden bg-white">
      <div className="flex items-center justify-between gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg p-1.5" style={{ backgroundColor: '#0c4d6c' }}>
            <Beaker size={15} color="#fff" />
          </div>
          <span className="text-sm font-medium" style={{ color: '#0c2136' }}>
            Тестовые пользователи
          </span>
        </div>
        <button onClick={loadUsers} className="rounded-lg p-1.5" style={{ backgroundColor: '#f5f6f8' }} title="Обновить">
          <RefreshCw size={14} color="#0c2136" />
        </button>
      </div>

      <div className="px-5 py-4 text-xs" style={{ backgroundColor: '#fff7ed', color: '#92400e' }}>
        Тестовый клиент создаёт сообщения прямо в разделе «Диалоги» CRM: те же плеер, расшифровка и черновик ИИ.
        Это безопасная песочница — наружу, в WhatsApp, Instagram и реальным клиентам ничего не уходит.
      </div>

      <div className="grid" style={{ gridTemplateColumns: '300px 1fr' }}>
        {/* Список и создание */}
        <div className="p-4 flex flex-col gap-3" style={{ borderRight: '1px solid #ebebee' }}>
          <div className="flex flex-col gap-2">
            <input
              className={input}
              style={inputStyle}
              placeholder="Имя клиента"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className={input}
              style={inputStyle}
              placeholder="Телефон (необязательно)"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
            <button
              onClick={createUser}
              disabled={!name.trim() || busy}
              className={`${btn} flex items-center justify-center gap-2 text-white`}
              style={{ backgroundColor: '#0c4d6c' }}
            >
              <UserPlus size={14} /> Создать
            </button>
          </div>

          <div className="flex flex-col gap-1.5 mt-1">
            {users.length === 0 && <p className="text-xs" style={muted}>Пока никого нет</p>}
            {users.map((u) => (
              <div
                key={u.id}
                className="rounded-xl px-3 py-2 flex items-start justify-between gap-2 cursor-pointer"
                style={{ backgroundColor: selected?.id === u.id ? '#eef4f8' : '#f9fafb' }}
                onClick={() => {
                  setSelected(u)
                  setMessages([])
                }}
              >
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: '#0c2136' }}>{u.name}</p>
                  <p className="text-[11px] truncate" style={muted}>
                    {u.pending_approvals > 0 ? `${u.pending_approvals} на согласовании` : (u.last_message ?? 'нет сообщений')}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeUser(u)
                  }}
                  title="Удалить вместе с перепиской"
                  className="shrink-0 p-1 rounded-lg"
                >
                  <Trash2 size={13} color="#a2b4c0" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Чат */}
        <div className="p-4 flex flex-col gap-3">
          {!selected && (
            <p className="text-sm text-center mt-20" style={muted}>
              Выберите тестового пользователя или создайте нового
            </p>
          )}

          {selected && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium" style={{ color: '#0c2136' }}>{selected.name}</p>
                  <p className="text-xs" style={muted}>🧪 тестовый клиент</p>
                </div>
                <a
                  href={`/dashboard/dialogs?lead=${encodeURIComponent(selected.amocrm_lead_id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold"
                  style={{ backgroundColor: '#e0f2fe', color: '#075985' }}
                >
                  <ExternalLink size={13} /> Открыть в CRM
                </a>
              </div>
              <div
                ref={chatRef}
                className="rounded-xl p-3 flex flex-col gap-2 overflow-y-auto"
                style={{ backgroundColor: '#f9fafb', minHeight: 280, maxHeight: 420 }}
              >
                {messages.length === 0 && (
                  <p className="text-sm text-center mt-16" style={muted}>
                    Напишите от лица клиента — бот ответит и пришлёт карточку менеджеру
                  </p>
                )}
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-xl px-3 py-2 max-w-[80%]"
                    style={{
                      alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                      backgroundColor: m.role === 'user' ? '#0c4d6c' : '#fff',
                      color: m.role === 'user' ? '#fff' : '#0c2136',
                    }}
                    >
                      <p className="text-[10px] mb-0.5 opacity-70">{roleLabel(m.role)}</p>
                    {m.message_type === 'voice' && m.media_url && <audio src={m.media_url} controls className="mb-2 max-w-full" />}
                    <p className="text-sm whitespace-pre-wrap">{m.text.replace(/^\[voice\]\s*https?:\/\/\S+\s*/i, '') || (m.message_type === 'voice' ? 'Голосовое сообщение' : '')}</p>
                  </div>
                ))}
              </div>

              {notice && <p className="text-xs" style={{ color: '#059669' }}>{notice}</p>}
              {error && <p className="text-xs" style={{ color: '#dc2626' }}>{error}</p>}

              <div className="flex gap-2">
                <input
                  ref={voiceRef}
                  type="file"
                  accept="audio/ogg,audio/opus,audio/webm,audio/mpeg,audio/mp4,audio/aiff,.ogg,.opus,.webm,.mp3,.m4a,.aiff"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void sendVoice(file)
                  }}
                />
                <button
                  onClick={() => voiceRef.current?.click()}
                  disabled={busy}
                  title="Отправить голосовое от тестового клиента"
                  className="rounded-xl px-3 disabled:opacity-50"
                  style={{ backgroundColor: '#e0f2fe', color: '#075985' }}
                >
                  <Mic size={16} />
                </button>
                <input
                  className={input}
                  style={inputStyle}
                  placeholder="Сообщение от лица клиента…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      sendMessage()
                    }
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!draft.trim() || busy}
                  className={`${btn} flex items-center gap-2 text-white shrink-0`}
                  style={{ backgroundColor: '#0c4d6c' }}
                >
                  <Send size={14} /> Отправить
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
