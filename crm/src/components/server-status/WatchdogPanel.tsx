"use client"

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'

type WatchdogEvent = {
  at: string
  check: string
  status: 'failed' | 'recovered'
  failures: number
  detail: string
}

type WatchdogData = { active: WatchdogEvent[]; events: WatchdogEvent[]; generatedAt: string }

const labels: Record<string, string> = {
  crm: 'CRM', inventory: 'Товароучёт', bot_backend: 'Бэкенд бота', bot_worker: 'Очередь бота',
  bot_beat: 'Планировщик бота', supabase_db: 'База Supabase', supabase_auth: 'Авторизация Supabase',
  crm_login: 'Вход CRM', inventory_cashier: 'Касса', bot_api: 'Публичный API бота',
  disk: 'Диск сервера', bot_log_errors: 'Ошибки бота',
}

export function WatchdogPanel() {
  const [data, setData] = useState<WatchdogData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/server/watchdog', { cache: 'no-store' })
      if (!response.ok) return
      setData(await response.json() as WatchdogData)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold" style={{ color: '#0c2136' }}>Watchdog продакшена</h2>
          <p className="mt-1 text-sm" style={{ color: '#8a97a5' }}>Проверка каждые 2 минуты. Ошибка появляется после 3 повторов подряд.</p>
        </div>
        <button onClick={() => void load()} className="rounded-lg p-2 text-[#0c4d6c] hover:bg-slate-100" aria-label="Обновить watchdog"><RefreshCw size={16} /></button>
      </div>
      {loading ? <p className="text-sm text-slate-500">Загружаем историю проверок…</p> : data?.active.length ? (
        <div className="space-y-2">
          {data.active.map((event) => <div key={event.check} className="flex gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><b>{labels[event.check] ?? event.check}</b><p className="mt-0.5">{event.detail} · повторов: {event.failures}</p></div></div>)}
        </div>
      ) : <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="size-4" />Все проверяемые сервисы сейчас в норме.</div>}
      {data?.events.length ? <div className="mt-4 border-t pt-4"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Последние события</p><div className="space-y-2">{data.events.slice(0, 8).map((event, index) => <div key={`${event.at}-${event.check}-${index}`} className="flex items-start gap-2 text-sm"><Clock3 className="mt-0.5 size-3.5 text-slate-400" /><span className={event.status === 'failed' ? 'text-red-700' : 'text-emerald-700'}>{event.status === 'failed' ? 'Сбой' : 'Восстановлено'}: {labels[event.check] ?? event.check}</span><span className="text-slate-500">{new Date(event.at).toLocaleString('ru-RU')}</span></div>)}</div></div> : null}
    </section>
  )
}
