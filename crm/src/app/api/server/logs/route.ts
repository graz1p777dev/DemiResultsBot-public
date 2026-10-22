import { execSync } from 'node:child_process'
import { NextRequest, NextResponse } from 'next/server'
import { isOwnerRequest } from '@/lib/server-monitor-auth'
import type { LogResponse } from '@/types/server-status'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Только docker-контейнеры: их логи читаются от alihan (группа docker). Логи CRM
// (systemd) и nginx под root:adm — недоступны без добавления alihan в journal/adm.
// Ключ — имя контейнера, поэтому в shell подставляется не пользовательский ввод,
// а строго значение из этого белого списка.
const SOURCES: Record<string, string> = {
  bot: 'demi-bot-backend-1',
  worker: 'demi-bot-worker-1',
  beat: 'demi-bot-beat-1',
  kong: 'supabase-kong',
  db: 'supabase-db',
  auth: 'supabase-auth',
  realtime: 'realtime-dev.supabase-realtime',
}

// Разрешённые окна для выгрузки — не пускаем произвольную строку в --since.
const SINCE: Record<string, string> = {
  '15m': '15m',
  '1h': '60m',
  '6h': '360m',
  '24h': '1440m',
}

function dockerLogs(container: string, since: string, tail: number): string {
  // --since ограничивает окно, --tail — потолок строк, чтобы ответ не распух.
  return execSync(`docker logs --since ${since} --tail ${tail} ${container} 2>&1`, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

export async function GET(request: NextRequest) {
  if (!(await isOwnerRequest())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = request.nextUrl.searchParams
  const sourceId = params.get('source') ?? 'bot'
  const container = SOURCES[sourceId]
  if (!container) {
    return NextResponse.json({ error: 'Unknown source' }, { status: 400 })
  }
  const sinceKey = params.get('since') ?? '15m'
  const since = SINCE[sinceKey] ?? SINCE['15m']
  const download = params.get('download') === '1'

  let raw: string
  try {
    // Для просмотра — последние 400 строк; для выгрузки — весь период (до 50к).
    raw = dockerLogs(container, since, download ? 50000 : 400)
  } catch {
    return NextResponse.json({ error: 'Не удалось прочитать логи' }, { status: 502 })
  }

  if (download) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    return new NextResponse(raw, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${sourceId}-${sinceKey}-${stamp}.log"`,
      },
    })
  }

  const body: LogResponse = {
    source: sourceId,
    lines: raw.split('\n').filter(Boolean).slice(-400),
    generatedAt: new Date().toISOString(),
  }
  return NextResponse.json(body)
}
