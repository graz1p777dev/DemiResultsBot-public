'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollText, Download, Pause, Play } from 'lucide-react'
import type { LogResponse } from '@/types/server-status'

const navy = '#0c2136'
const steel = '#8a97a5'

const SOURCES = [
  { id: 'bot', label: 'Бот' },
  { id: 'worker', label: 'Воркер' },
  { id: 'beat', label: 'Планировщик' },
  { id: 'kong', label: 'Supabase Kong' },
  { id: 'db', label: 'Postgres' },
  { id: 'auth', label: 'Auth' },
  { id: 'realtime', label: 'Realtime' },
]

const WINDOWS = [
  { id: '15m', label: '15 мин' },
  { id: '1h', label: '1 час' },
  { id: '6h', label: '6 часов' },
  { id: '24h', label: '24 часа' },
]

const POLL_MS = 3000

export function LogsPanel() {
  const [source, setSource] = useState('bot')
  const [win, setWin] = useState('15m')
  const [lines, setLines] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const tick = useCallback(async (src: string, w: string) => {
    try {
      const res = await fetch(`/api/server/logs?source=${src}&since=${w}`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const data: LogResponse = await res.json()
      setLines(data.lines)
      setError(null)
    } catch {
      setError('Не удалось прочитать логи')
    }
  }, [])

  useEffect(() => {
    // Первый фетч + опрос — тот же паттерн, что и на странице server-status.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void tick(source, win)
    if (paused) return
    const id = setInterval(() => void tick(source, win), POLL_MS)
    return () => clearInterval(id)
  }, [source, win, paused, tick])

  useEffect(() => {
    if (stick.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  const onScroll = () => {
    const b = boxRef.current
    if (b) stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40
  }

  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 font-semibold text-sm" style={{ color: navy }}>
          <ScrollText size={16} color="#0c4d6c" /> Логи в реальном времени
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPaused((p) => !p)} className="rounded-lg p-1.5" style={{ backgroundColor: '#f5f6f8' }} title={paused ? 'Продолжить' : 'Пауза'}>
            {paused ? <Play size={13} color={navy} /> : <Pause size={13} color={navy} />}
          </button>
          <a
            href={`/api/server/logs?source=${source}&since=${win}&download=1`}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
            style={{ backgroundColor: '#0c4d6c' }}
          >
            <Download size={13} /> Скачать за {WINDOWS.find((w) => w.id === win)?.label}
          </a>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            onClick={() => setSource(s.id)}
            className="rounded-lg px-2.5 py-1 text-[11px]"
            style={source === s.id ? { backgroundColor: '#0c4d6c', color: '#fff' } : { backgroundColor: '#f5f6f8', color: '#5b6b7a' }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWin(w.id)}
            className="rounded-lg px-2.5 py-1 text-[11px]"
            style={win === w.id ? { backgroundColor: '#eef4f8', color: '#0c4d6c' } : { backgroundColor: '#f9fafb', color: steel }}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm mb-2" style={{ color: '#dc2626' }}>{error}</p>}

      <div
        ref={boxRef}
        onScroll={onScroll}
        className="overflow-auto font-mono text-[11px] leading-relaxed px-3 py-2.5 rounded-xl"
        style={{ backgroundColor: '#0c1f33', color: '#d6e0e8', minHeight: 260, maxHeight: 460, whiteSpace: 'pre' }}
      >
        {lines.length === 0 ? (
          <span style={{ color: '#5b6b7a' }}>Строк за выбранный период нет</span>
        ) : (
          lines.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </div>
  )
}
