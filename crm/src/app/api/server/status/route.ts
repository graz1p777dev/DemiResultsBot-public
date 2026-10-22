import os from 'node:os'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { NextResponse } from 'next/server'
import { isOwnerRequest } from '@/lib/server-monitor-auth'
import { notify } from '@/lib/notifications/notify'
import type {
  ServerStatusResponse,
  ServiceStatusItem,
  ProcessRow,
  HistoryPoint,
  NetworkHistoryPoint,
  VersionsInfo,
  ContainerInfo,
  DatabaseInfo,
  BackupInfo,
} from '@/types/server-status'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ─── История в памяти процесса ──────────────────────────────────────────────
// Ring-buffer на уровне модуля: живёт, пока жив Node-процесс (Railway не
// перезапускает контейнер между запросами), поэтому графики "за последние
// измерения" копятся сами по себе без базы данных.
const HISTORY_LIMIT = 60 // ~5 минут при опросе раз в 5 секунд

const cpuHistory: HistoryPoint[] = []
const ramHistory: HistoryPoint[] = []
const networkHistory: NetworkHistoryPoint[] = []

function pushHistory(cpuPercent: number, ramPercent: number, netIn: number, netOut: number) {
  const time = new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  cpuHistory.push({ time, value: cpuPercent })
  ramHistory.push({ time, value: ramPercent })
  networkHistory.push({ time, in: netIn, out: netOut })
  if (cpuHistory.length > HISTORY_LIMIT) cpuHistory.shift()
  if (ramHistory.length > HISTORY_LIMIT) ramHistory.shift()
  if (networkHistory.length > HISTORY_LIMIT) networkHistory.shift()
}

// ─── Уведомление о высокой нагрузке ─────────────────────────────────────────
// Страница опрашивает этот роут раз в 5 с — без cooldown каждый спайк CPU
// породил бы уведомление на каждый запрос. lastLoadNotifyAt переживает
// запросы (тот же модуль-процесс), но не рестарт — этого достаточно, задача
// не «ни разу не продублировать», а «не заспамить».
const LOAD_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000
const CPU_THRESHOLD = 90
const RAM_THRESHOLD = 90
let lastLoadNotifyAt = 0

function maybeNotifyHighLoad(cpuPercent: number, ramPercent: number, loadAverage: [number, number, number]) {
  const loadPerCore = loadAverage[0] / Math.max(1, os.cpus().length)
  const isHigh = cpuPercent >= CPU_THRESHOLD || ramPercent >= RAM_THRESHOLD || loadPerCore >= 1.5
  if (!isHigh) return

  const now = Date.now()
  if (now - lastLoadNotifyAt < LOAD_NOTIFY_COOLDOWN_MS) return
  lastLoadNotifyAt = now

  void notify({
    type: 'server_load',
    title: 'Высокая нагрузка на сервер',
    body: `CPU ${cpuPercent}% · RAM ${ramPercent}% · Load average ${loadAverage[0].toFixed(2)}`,
    actionUrl: '/dashboard/server-status',
    isImportant: true,
  })
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

function cpuSnapshot() {
  return os.cpus().map((c) => ({
    idle: c.times.idle,
    total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
  }))
}

async function getCpuPercent(sampleMs = 200): Promise<number> {
  const start = cpuSnapshot()
  await new Promise((r) => setTimeout(r, sampleMs))
  const end = cpuSnapshot()

  let idleDiff = 0
  let totalDiff = 0
  for (let i = 0; i < start.length; i++) {
    idleDiff += end[i].idle - start[i].idle
    totalDiff += end[i].total - start[i].total
  }
  if (totalDiff <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)))
}

function getCpuTemperature(): number | null {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')
    const milliC = Number(raw.trim())
    if (!Number.isFinite(milliC)) return null
    return Math.round(milliC / 1000)
  } catch {
    // Контейнеры обычно не видят термодатчики хоста — это ожидаемо, не ошибка.
    return null
  }
}

// ─── Диск ────────────────────────────────────────────────────────────────────

function getDiskSpace(): { total: number | null; used: number | null; free: number | null; percent: number | null } {
  try {
    const out = execSync('df -k /', { encoding: 'utf8', timeout: 3000 })
    const line = out.trim().split('\n')[1]
    const parts = line.split(/\s+/)
    const totalKb = Number(parts[1])
    const usedKb = Number(parts[2])
    const availKb = Number(parts[3])
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) {
      return { total: null, used: null, free: null, percent: null }
    }
    const total = totalKb * 1024
    const used = usedKb * 1024
    return {
      total,
      used,
      free: Number.isFinite(availKb) ? availKb * 1024 : total - used,
      percent: Math.round((used / total) * 100),
    }
  } catch {
    return { total: null, used: null, free: null, percent: null }
  }
}

function readDiskIoSectors(): { read: number; write: number } | null {
  try {
    const raw = fs.readFileSync('/proc/diskstats', 'utf8')
    let read = 0
    let write = 0
    for (const line of raw.split('\n')) {
      const f = line.trim().split(/\s+/)
      // Поля: major minor name ... [5]=reads-completed [8]=sectors-read [11]=writes [13]? →
      // сектора чтения в поле индекса 5, записи — 9 (0-based после name сдвиг).
      const name = f[2]
      // Только физические диски (vda, sda...), не разделы и не loop.
      if (!name || !/^[sv]d[a-z]$|^nvme\d+n\d+$/.test(name)) continue
      read += Number(f[5]) || 0
      write += Number(f[9]) || 0
    }
    return { read, write }
  } catch {
    return null
  }
}

async function getDiskIo(sampleMs = 500): Promise<{ readBytesPerSec: number | null; writeBytesPerSec: number | null }> {
  const start = readDiskIoSectors()
  if (!start) return { readBytesPerSec: null, writeBytesPerSec: null }
  await new Promise((r) => setTimeout(r, sampleMs))
  const end = readDiskIoSectors()
  if (!end) return { readBytesPerSec: null, writeBytesPerSec: null }
  // Сектор в Linux — 512 байт.
  const perSec = (a: number, b: number) => Math.max(0, Math.round(((b - a) * 512) / (sampleMs / 1000)))
  return {
    readBytesPerSec: perSec(start.read, end.read),
    writeBytesPerSec: perSec(start.write, end.write),
  }
}

// ─── Сеть ────────────────────────────────────────────────────────────────────

function readNetTotals(): { rx: number; tx: number } {
  const raw = fs.readFileSync('/proc/net/dev', 'utf8')
  const lines = raw.split('\n').slice(2)
  let rx = 0
  let tx = 0
  for (const line of lines) {
    const [ifacePart, rest] = line.split(':')
    if (!rest) continue
    if (ifacePart.trim() === 'lo') continue
    const fields = rest.trim().split(/\s+/).map(Number)
    rx += fields[0] || 0
    tx += fields[8] || 0
  }
  return { rx, tx }
}

async function getNetworkRates(
  sampleMs = 500
): Promise<{ inBytesPerSec: number | null; outBytesPerSec: number | null }> {
  try {
    const start = readNetTotals()
    await new Promise((r) => setTimeout(r, sampleMs))
    const end = readNetTotals()
    return {
      inBytesPerSec: Math.max(0, Math.round((end.rx - start.rx) / (sampleMs / 1000))),
      outBytesPerSec: Math.max(0, Math.round((end.tx - start.tx) / (sampleMs / 1000))),
    }
  } catch {
    // /proc/net/dev недоступен вне Linux/контейнера — не считаем это ошибкой сервиса.
    return { inBytesPerSec: null, outBytesPerSec: null }
  }
}

// ─── Процессы ────────────────────────────────────────────────────────────────

function mapProcessStat(stat: string): string {
  switch (stat[0]) {
    case 'R':
      return 'running'
    case 'S':
      return 'sleeping'
    case 'D':
      return 'waiting'
    case 'Z':
      return 'zombie'
    case 'T':
      return 'stopped'
    default:
      return 'unknown'
  }
}

function getProcesses(): ProcessRow[] {
  try {
    const out = execSync('ps -eo pid,comm,%cpu,%mem,stat --sort=-%cpu', {
      encoding: 'utf8',
      timeout: 3000,
    })
    const lines = out.trim().split('\n').slice(1, 11)
    return lines
      .map((line): ProcessRow | null => {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)$/)
        if (!match) return null
        const [, pid, name, cpu, ram, stat] = match
        return {
          pid: Number(pid),
          name,
          cpu: Number(cpu),
          ram: Number(ram),
          status: mapProcessStat(stat),
        }
      })
      .filter((p): p is ProcessRow => p !== null)
  } catch {
    // `ps` может отсутствовать в минимальном образе — пустой список, не ошибка.
    return []
  }
}

// ─── IP ──────────────────────────────────────────────────────────────────────

function getLocalIp(): string | null {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return null
}

let cachedPublicIp: { ip: string | null; fetchedAt: number } = { ip: null, fetchedAt: 0 }
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000

async function getPublicIp(): Promise<string | null> {
  const now = Date.now()
  if (now - cachedPublicIp.fetchedAt < PUBLIC_IP_TTL_MS) return cachedPublicIp.ip
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: { ip?: string } = await res.json()
    cachedPublicIp = { ip: data.ip ?? null, fetchedAt: now }
  } catch {
    // Оставляем последний известный IP, просто не обновляем метку времени успеха.
    cachedPublicIp = { ip: cachedPublicIp.ip, fetchedAt: now }
  }
  return cachedPublicIp.ip
}

// ─── Версии окружения ────────────────────────────────────────────────────────
// Роут теперь работает на самом VPS (systemd-юнит demiresults-crm, пользователь
// alihan в группе docker), поэтому всё читается с реального хоста, а не из
// контейнера Railway, как было раньше.

const APP_DIR = process.cwd()

function sh(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 4000 }).trim() || null
  } catch {
    return null
  }
}

let cachedVersions: { data: VersionsInfo; at: number } | null = null
const VERSIONS_TTL_MS = 60 * 1000

function getVersions(): VersionsInfo {
  // Версии и коммит меняются только при деплое — незачем дёргать подпроцессы
  // на каждый опрос страницы (раз в 5 с).
  if (cachedVersions && Date.now() - cachedVersions.at < VERSIONS_TTL_MS) {
    return cachedVersions.data
  }

  let osName: string | null = null
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8')
    osName = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null
  } catch {
    osName = null
  }

  let nextVersion: string | null = null
  try {
    const pkg = JSON.parse(fs.readFileSync(`${APP_DIR}/package.json`, 'utf8'))
    nextVersion = pkg.dependencies?.next ?? null
  } catch {
    nextVersion = null
  }

  // Время последней сборки = mtime каталога .next. Деплой-скрипт делает
  // `next build`, поэтому это и есть момент выката текущей версии.
  let deployedAt: string | null = null
  try {
    deployedAt = fs.statSync(`${APP_DIR}/.next`).mtime.toISOString()
  } catch {
    deployedAt = null
  }

  const data: VersionsInfo = {
    os: osName,
    kernel: sh('uname -r'),
    node: process.version,
    next: nextVersion,
    docker: sh('docker --version')?.replace(/^Docker version /, '').replace(/,.*$/, '') ?? null,
    gitCommit: sh(`git -C ${APP_DIR} rev-parse --short HEAD`),
    gitBranch: sh(`git -C ${APP_DIR} rev-parse --abbrev-ref HEAD`),
    deployedAt,
  }
  cachedVersions = { data, at: Date.now() }
  return data
}

// ─── Docker-контейнеры ───────────────────────────────────────────────────────

// docker stats --no-stream — самый медленный вызов (~1.3 с). Страница опрашивает
// роут раз в 5 с, поэтому короткий кэш не даёт запросам наслаиваться.
let cachedContainers: { data: ContainerInfo[]; at: number } | null = null
const CONTAINERS_TTL_MS = 4000

function getContainersCached(): ContainerInfo[] {
  if (cachedContainers && Date.now() - cachedContainers.at < CONTAINERS_TTL_MS) {
    return cachedContainers.data
  }
  const data = getContainers()
  cachedContainers = { data, at: Date.now() }
  return data
}

function getContainers(): ContainerInfo[] {
  // Один вызов docker ps даёт имя, health/статус и uptime; restart count —
  // только через inspect, а живые CPU/RAM — через stats. Всё в трёх вызовах,
  // потому что докер не отдаёт их одним запросом.
  const ps = sh(`docker ps -a --format '{{.Names}}\t{{.Status}}'`)
  if (!ps) return []

  const rows: ContainerInfo[] = []
  for (const line of ps.split('\n')) {
    const [name, statusRaw = ''] = line.split('\t')
    if (!name) continue
    // "Up 24 hours (healthy)" → status=healthy, uptime="24 hours"
    const health = statusRaw.match(/\((healthy|unhealthy|health: starting)\)/)?.[1]
    const up = statusRaw.match(/^Up\s+(.+?)(?:\s+\(|$)/)?.[1]
    const exited = statusRaw.startsWith('Exited')
    rows.push({
      name,
      status: exited ? 'exited' : (health ?? (statusRaw.startsWith('Up') ? 'running' : 'unknown')),
      uptime: ruUptime(up),
      restarts: 0,
      cpuPercent: null,
      memBytes: null,
    })
  }

  const inspect = sh(`docker inspect --format '{{.Name}}\t{{.RestartCount}}' ${rows.map((r) => r.name).join(' ')}`)
  if (inspect) {
    const restartByName = new Map<string, number>()
    for (const line of inspect.split('\n')) {
      const [rawName, count] = line.split('\t')
      if (rawName) restartByName.set(rawName.replace(/^\//, ''), Number(count) || 0)
    }
    for (const r of rows) r.restarts = restartByName.get(r.name) ?? 0
  }

  const stats = sh(`docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`)
  if (stats) {
    const byName = new Map<string, { cpu: number; mem: number }>()
    for (const line of stats.split('\n')) {
      const [n, cpu = '', mem = ''] = line.split('\t')
      if (n) byName.set(n, { cpu: parseFloat(cpu) || 0, mem: parseMemUsage(mem) })
    }
    for (const r of rows) {
      const s = byName.get(r.name)
      if (s) {
        r.cpuPercent = s.cpu
        r.memBytes = s.mem
      }
    }
  }
  return rows
}

function parseMemUsage(usage: string): number {
  // "680MiB / 15.62GiB" → байты первой величины
  const m = usage.split('/')[0].trim().match(/([\d.]+)\s*([KMGT]?i?B)/i)
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  const mult: Record<string, number> = {
    B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
  }
  return Math.round(value * (mult[unit] ?? 1))
}

function ruUptime(raw: string | undefined): string {
  if (!raw) return '—'
  // Docker отдаёт "About a minute", "24 hours", "2 days" — переводим коротко.
  const num = parseInt(raw, 10)
  if (raw.includes('day')) return `${num}д`
  if (raw.includes('hour')) return `${num}ч`
  if (raw.includes('minute') || raw.includes('About a minute')) return `${Number.isFinite(num) ? num : 1}м`
  if (raw.includes('second')) return '<1м'
  return raw
}

// ─── Состояние базы (self-hosted Supabase Postgres) ──────────────────────────

let cachedDb: { data: DatabaseInfo; at: number } | null = null
const DB_TTL_MS = 4000

function getDatabaseCached(): DatabaseInfo {
  if (cachedDb && Date.now() - cachedDb.at < DB_TTL_MS) return cachedDb.data
  const data = getDatabase()
  cachedDb = { data, at: Date.now() }
  return data
}

function getDatabase(): DatabaseInfo {
  const empty: DatabaseInfo = { connections: null, maxConnections: null, sizeBytes: null, slowQueries: null }
  // psql внутри контейнера supabase-db — прямого клиента на хосте нет, а пароль
  // светить не нужно: docker exec заходит локальным сокетом под postgres.
  const q = (sql: string) =>
    sh(`docker exec supabase-db psql -U postgres -d postgres -tAc "${sql.replace(/"/g, '\\"')}"`)

  const conn = q('select numbackends, (select setting::int from pg_settings where name=\'max_connections\') from pg_stat_database where datname=current_database()')
  const size = q('select pg_database_size(current_database())')
  // Медленные запросы: активные, что выполняются дольше 1 секунды прямо сейчас.
  const slow = q("select count(*) from pg_stat_activity where state='active' and now()-query_start > interval '1 second' and query not ilike '%pg_stat_activity%'")

  if (conn) {
    const [numbackends, maxConn] = conn.split('|')
    empty.connections = Number(numbackends) || 0
    empty.maxConnections = Number(maxConn) || null
  }
  if (size) empty.sizeBytes = Number(size) || null
  if (slow) empty.slowQueries = Number(slow) || 0
  return empty
}

// ─── Бэкапы ──────────────────────────────────────────────────────────────────

function getBackups(): BackupInfo {
  const info: BackupInfo = { lastAt: null, lastSizeBytes: null, ok: null, nextAt: null }
  try {
    const log = fs.readFileSync('/srv/production/backups/backup.log', 'utf8').trim()
    const last = log.split('\n').filter(Boolean).at(-1)
    if (last) {
      // "2026-07-11T03:30:02+00:00 OK: supabase_....dump (644K)"
      const ts = last.match(/^(\S+)\s/)?.[1]
      info.lastAt = ts ? new Date(ts).toISOString() : null
      info.ok = /\bOK:/.test(last)
    }
  } catch {
    /* лога нет — оставляем null */
  }

  const latestDump = sh('ls -t /srv/production/backups/supabase/*.dump 2>/dev/null | head -1')
  if (latestDump) {
    try {
      info.lastSizeBytes = fs.statSync(/* turbopackIgnore: true */ latestDump).size
    } catch {
      /* файл исчез между ls и stat */
    }
  }

  // Cron бэкапа стоит на 03:30 — следующая копия завтра в это же время.
  if (info.lastAt) {
    const next = new Date(info.lastAt)
    next.setUTCDate(next.getUTCDate() + 1)
    info.nextAt = next.toISOString()
  }
  return info
}

// ─── Проверки сервисов ───────────────────────────────────────────────────────

function checkDocker(): ServiceStatusItem {
  const out = sh('docker info --format "{{.ServerVersion}}"')
  return out
    ? { name: 'Docker', status: 'online', description: `Демон отвечает, версия ${out}` }
    : { name: 'Docker', status: 'offline', description: 'Демон недоступен' }
}

function checkNginx(): ServiceStatusItem {
  const active = sh('systemctl is-active nginx')
  if (active === 'active') return { name: 'Nginx', status: 'online', description: 'Активен' }
  if (active === null) return { name: 'Nginx', status: 'unknown', description: 'Статус недоступен' }
  return { name: 'Nginx', status: 'offline', description: active }
}

function checkRedis(): ServiceStatusItem {
  const out = sh('docker exec demi-bot-redis-1 redis-cli ping')
  return out === 'PONG'
    ? { name: 'Redis', status: 'online', description: 'PONG' }
    : { name: 'Redis', status: 'offline', description: 'Не отвечает' }
}

async function checkSupabase(): Promise<ServiceStatusItem> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const name = 'PostgreSQL (Supabase)'
  if (!url || !key) {
    return { name, status: 'unknown', description: 'Переменные окружения не заданы' }
  }
  try {
    const start = Date.now()
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    const ms = Date.now() - start
    if (res.ok || res.status === 404) {
      return { name, status: ms > 1500 ? 'warning' : 'online', description: `Отвечает за ${ms} мс` }
    }
    return { name, status: 'warning', description: `HTTP ${res.status}` }
  } catch {
    return { name, status: 'offline', description: 'Нет ответа' }
  }
}

async function checkBotBackend(): Promise<ServiceStatusItem> {
  const base = process.env.BOT_BACKEND_API_URL
  const name = 'AI Бот'
  if (!base) {
    return { name, status: 'unknown', description: 'BOT_BACKEND_API_URL не задан' }
  }
  try {
    const start = Date.now()
    const res = await fetch(`${base.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    const ms = Date.now() - start
    if (res.ok) {
      return { name, status: ms > 1500 ? 'warning' : 'online', description: `Отвечает за ${ms} мс` }
    }
    return { name, status: 'warning', description: `HTTP ${res.status}` }
  } catch {
    return { name, status: 'offline', description: 'Бэкенд недоступен' }
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function GET() {
  if (!(await isOwnerRequest())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [cpuPercent, netRates, diskIo, supabaseCheck, botCheck, publicIp] = await Promise.all([
    getCpuPercent(),
    getNetworkRates(),
    getDiskIo(),
    checkSupabase(),
    checkBotBackend(),
    getPublicIp(),
  ])

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const ramPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0

  pushHistory(cpuPercent, ramPercent, netRates.inBytesPerSec ?? 0, netRates.outBytesPerSec ?? 0)

  const loadAverage = os.loadavg() as [number, number, number]
  maybeNotifyHighLoad(cpuPercent, ramPercent, loadAverage)

  const diskSpace = getDiskSpace()

  const services: ServiceStatusItem[] = [
    { name: 'Backend/API', status: 'online', description: 'Next.js сервер отвечает' },
    supabaseCheck,
    checkRedis(),
    checkNginx(),
    checkDocker(),
    botCheck,
  ]

  const body: ServerStatusResponse = {
    cpu: { percent: cpuPercent, temperature: getCpuTemperature() },
    ram: { total: totalMem, used: usedMem, percent: ramPercent },
    disk: {
      total: diskSpace.total,
      used: diskSpace.used,
      free: diskSpace.free,
      percent: diskSpace.percent,
      readBytesPerSec: diskIo.readBytesPerSec,
      writeBytesPerSec: diskIo.writeBytesPerSec,
    },
    uptimeSeconds: Math.round(os.uptime()),
    loadAverage,
    network: netRates,
    ip: { public: publicIp, local: getLocalIp() },
    versions: getVersions(),
    containers: getContainersCached(),
    database: getDatabaseCached(),
    backups: getBackups(),
    services,
    processes: getProcesses(),
    history: { cpu: cpuHistory, ram: ramHistory, network: networkHistory },
    generatedAt: new Date().toISOString(),
  }

  return NextResponse.json(body)
}
