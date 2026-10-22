import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { isOwnerRequest } from '@/lib/server-monitor-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const EVENTS_FILE = '/srv/production/monitoring/watchdog-events.jsonl'

type WatchdogEvent = {
  at: string
  check: string
  status: 'failed' | 'recovered'
  failures: number
  detail: string
}

function isWatchdogEvent(value: unknown): value is WatchdogEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.at === 'string'
    && typeof event.check === 'string'
    && (event.status === 'failed' || event.status === 'recovered')
    && typeof event.failures === 'number'
    && typeof event.detail === 'string'
}

export async function GET() {
  if (!await isOwnerRequest()) return NextResponse.json({ error: 'Доступ запрещён' }, { status: 403 })

  let events: WatchdogEvent[] = []
  try {
    const raw = await readFile(EVENTS_FILE, 'utf8')
    events = raw.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value: unknown = JSON.parse(line)
        return isWatchdogEvent(value) ? [value] : []
      } catch {
        return []
      }
    })
  } catch {
    // Первые минуты после установки событий ещё может не быть.
  }

  const active = new Map<string, WatchdogEvent>()
  for (const event of events) {
    if (event.status === 'failed') active.set(event.check, event)
    else active.delete(event.check)
  }

  return NextResponse.json({
    active: [...active.values()],
    events: events.slice(-80).reverse(),
    generatedAt: new Date().toISOString(),
  })
}
