import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { execSync } from 'node:child_process'
import { NextResponse } from 'next/server'
import { isOwnerRequest } from '@/lib/server-monitor-auth'
import type { SecurityInfo } from '@/types/server-status'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SSL_DOMAINS = ['crm.example.invalid', 'api-crm.example.invalid']
const SECURITY_FILE = '/srv/production/monitoring/security.json'

function sh(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 6000 }).trim() || null
  } catch {
    return null
  }
}

// SSH: разрешён ли вход root. Файл sshd_config читается без root.
function sshRootLogin(): 'yes' | 'no' | 'unknown' {
  try {
    const conf = fs.readFileSync('/etc/ssh/sshd_config', 'utf8')
    const m = conf.match(/^\s*PermitRootLogin\s+(\S+)/im)
    if (!m) return 'unknown'
    // prohibit-password / without-password / forced-commands-only — root по паролю нельзя.
    return m[1].toLowerCase() === 'yes' ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

// apt-check печатает "обновления;security" в stderr, root не требуется.
function updates(): { total: number | null; security: number | null } {
  const out = sh('/usr/lib/update-notifier/apt-check 2>&1')
  if (!out) return { total: null, security: null }
  const m = out.match(/(\d+);(\d+)/)
  if (!m) return { total: null, security: null }
  return { total: Number(m[1]), security: Number(m[2]) }
}

// Дни до истечения сертификата — по сети, без чтения файла (root не нужен).
function sslDaysLeft(domain: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = net.connect(443, domain)
    socket.setTimeout(6000)
    const done = (v: number | null) => {
      socket.destroy()
      resolve(v)
    }
    socket.on('timeout', () => done(null))
    socket.on('error', () => done(null))
    socket.on('connect', () => {
      const secure = tls.connect({ socket, servername: domain, rejectUnauthorized: false }, () => {
        const cert = secure.getPeerCertificate()
        secure.destroy()
        if (!cert || !cert.valid_to) return done(null)
        const days = Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
        done(Number.isFinite(days) ? days : null)
      })
      secure.on('error', () => done(null))
      secure.setTimeout(6000, () => done(null))
    })
  })
}

// ufw и fail2ban требуют root — их пишет security-collect.sh в читаемый файл.
function fromCollector(): { ufwStatus: 'on' | 'off' | 'unknown'; f2bActive: boolean | null; banned: number | null; stale: boolean } {
  try {
    const raw = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'))
    const collectedAt = new Date(raw.collected_at).getTime()
    // Старше часа — сборщик, вероятно, не запущен; данным не доверяем.
    const stale = !Number.isFinite(collectedAt) || Date.now() - collectedAt > 3600_000
    return {
      ufwStatus: raw.ufw ?? 'unknown',
      f2bActive: raw.fail2ban_active ?? null,
      banned: raw.fail2ban_banned ?? null,
      stale,
    }
  } catch {
    return { ufwStatus: 'unknown', f2bActive: null, banned: null, stale: true }
  }
}

export async function GET() {
  if (!(await isOwnerRequest())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const ssl = await Promise.all(
    SSL_DOMAINS.map(async (domain) => ({ domain, daysLeft: await sslDaysLeft(domain) }))
  )
  const collector = fromCollector()
  const noRootNote = collector.stale
    ? 'нужен root-сбор — установите cron security-collect.sh'
    : 'по данным root-сборщика'

  const body: SecurityInfo = {
    ufw: {
      status: collector.stale ? 'unknown' : collector.ufwStatus,
      note: collector.stale ? noRootNote : collector.ufwStatus === 'on' ? 'включён' : 'выключен',
    },
    fail2ban: {
      active: collector.stale ? null : collector.f2bActive,
      bannedIps: collector.stale ? null : collector.banned,
      note: noRootNote,
    },
    sshRootLogin: sshRootLogin(),
    updates: updates(),
    ssl,
    collectedAt: new Date().toISOString(),
  }
  return NextResponse.json(body)
}
