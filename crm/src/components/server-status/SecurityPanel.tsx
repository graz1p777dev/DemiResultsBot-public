'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Lock, RefreshCw } from 'lucide-react'
import type { SecurityInfo } from '@/types/server-status'

const navy = '#0c2136'
const steel = '#8a97a5'

type Tone = 'ok' | 'warn' | 'bad' | 'muted'
const toneColor: Record<Tone, string> = { ok: '#16a34a', warn: '#d97706', bad: '#dc2626', muted: '#8a97a5' }

function Line({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2" style={{ borderBottom: '1px solid #f1f2f4' }}>
      <span className="text-sm" style={{ color: steel }}>{label}</span>
      <span className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: toneColor[tone] }}>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: toneColor[tone] }} />
        {value}
      </span>
    </div>
  )
}

export function SecurityPanel() {
  const [data, setData] = useState<SecurityInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/server/security', { cache: 'no-store' })
      if (!res.ok) throw new Error()
      setData(await res.json())
      setError(null)
    } catch {
      setError('Не удалось получить данные безопасности')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    fetch('/api/server/security', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: SecurityInfo) => alive && setData(d))
      .catch(() => alive && setError('Не удалось получить данные безопасности'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const minSsl = data?.ssl.reduce<number | null>((min, s) => {
    if (s.daysLeft === null) return min
    return min === null ? s.daysLeft : Math.min(min, s.daysLeft)
  }, null)

  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 font-semibold text-sm" style={{ color: navy }}>
          <ShieldCheck size={16} color="#0c4d6c" /> Безопасность
        </div>
        <button onClick={load} className="rounded-lg p-1.5" style={{ backgroundColor: '#f5f6f8' }} title="Обновить">
          <RefreshCw size={13} color={navy} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
      {loading && !data && <p className="text-sm" style={{ color: steel }}>Проверяем…</p>}

      {data && (
        <>
          <Line
            label="UFW (файрвол)"
            value={data.ufw.status === 'on' ? 'включён' : data.ufw.status === 'off' ? 'выключен' : data.ufw.note}
            tone={data.ufw.status === 'on' ? 'ok' : data.ufw.status === 'off' ? 'bad' : 'muted'}
          />
          <Line
            label="Fail2ban"
            value={
              data.fail2ban.active === null
                ? data.fail2ban.note
                : data.fail2ban.active
                  ? `активен · ${data.fail2ban.bannedIps ?? 0} IP заблокировано`
                  : 'выключен'
            }
            tone={data.fail2ban.active === null ? 'muted' : data.fail2ban.active ? 'ok' : 'bad'}
          />
          <Line
            label="Вход root по SSH"
            value={data.sshRootLogin === 'no' ? 'запрещён' : data.sshRootLogin === 'yes' ? 'разрешён' : 'неизвестно'}
            tone={data.sshRootLogin === 'no' ? 'ok' : data.sshRootLogin === 'yes' ? 'bad' : 'muted'}
          />
          <Line
            label="Обновления безопасности"
            value={
              data.updates.security === null
                ? 'неизвестно'
                : data.updates.security === 0
                  ? `нет (всего обновлений: ${data.updates.total ?? '—'})`
                  : `${data.updates.security} важных из ${data.updates.total ?? '—'}`
            }
            tone={data.updates.security === null ? 'muted' : data.updates.security === 0 ? 'ok' : 'warn'}
          />
          <Line
            label="SSL-сертификат"
            value={minSsl == null ? 'недоступно' : `истекает через ${minSsl} дн.`}
            tone={minSsl == null ? 'muted' : minSsl <= 14 ? 'bad' : minSsl <= 30 ? 'warn' : 'ok'}
          />

          {data.sshRootLogin === 'yes' && (
            <div className="mt-3 flex items-start gap-2 text-xs rounded-xl px-3 py-2" style={{ backgroundColor: '#fef2f2', color: '#b91c1c' }}>
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              Вход root по SSH разрешён — стоит запретить (<span className="font-mono">PermitRootLogin prohibit-password</span>).
            </div>
          )}
          {data.ufw.status === 'unknown' && (
            <div className="mt-2 flex items-start gap-2 text-xs rounded-xl px-3 py-2" style={{ backgroundColor: '#f5f6f8', color: steel }}>
              <Lock size={14} className="mt-0.5 shrink-0" />
              UFW и Fail2ban видны только root. Установите cron
              <span className="font-mono"> security-collect.sh</span>, чтобы эти строки заполнились.
            </div>
          )}
        </>
      )}
    </div>
  )
}
