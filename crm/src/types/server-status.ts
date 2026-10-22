export type ServiceStatus = 'online' | 'warning' | 'offline' | 'unknown'

export interface ServiceStatusItem {
  name: string
  status: ServiceStatus
  description: string
}

export interface ProcessRow {
  pid: number
  name: string
  cpu: number
  ram: number
  status: string
}

export interface HistoryPoint {
  time: string
  value: number
}

export interface NetworkHistoryPoint {
  time: string
  in: number
  out: number
}

// Версии окружения — то, что на сервере реально установлено.
export interface VersionsInfo {
  os: string | null
  kernel: string | null
  node: string | null
  next: string | null
  docker: string | null
  gitCommit: string | null
  gitBranch: string | null
  deployedAt: string | null // ISO, время последней сборки (.next)
}

// Один docker-контейнер.
export interface ContainerInfo {
  name: string
  status: string // healthy | unhealthy | running | exited | ...
  uptime: string // "2д 4ч"
  restarts: number
  cpuPercent: number | null
  memBytes: number | null
}

// Состояние базы CRM (self-hosted Supabase Postgres).
export interface DatabaseInfo {
  connections: number | null
  maxConnections: number | null
  sizeBytes: number | null
  slowQueries: number | null
}

// Резервные копии.
export interface BackupInfo {
  lastAt: string | null // ISO
  lastSizeBytes: number | null
  ok: boolean | null
  nextAt: string | null // ISO, вычисляется из расписания cron
}

// ─── Безопасность ────────────────────────────────────────────────────────────
export interface SecurityInfo {
  ufw: { status: 'on' | 'off' | 'unknown'; note: string }
  fail2ban: { active: boolean | null; bannedIps: number | null; note: string }
  sshRootLogin: 'yes' | 'no' | 'unknown'
  updates: { total: number | null; security: number | null }
  ssl: { domain: string; daysLeft: number | null }[]
  collectedAt: string
}

// ─── Зависимости ─────────────────────────────────────────────────────────────
export interface DependencyItem {
  name: string
  version: string
}
export interface DependenciesInfo {
  crm: DependencyItem[]
  crmDev: DependencyItem[]
  bot: DependencyItem[]
  images: DependencyItem[]
  generatedAt: string
}

// ─── Логи ────────────────────────────────────────────────────────────────────
export interface LogSource {
  id: string
  label: string
}
export interface LogResponse {
  source: string
  lines: string[]
  generatedAt: string
}

export interface ServerStatusResponse {
  cpu: {
    percent: number | null
    temperature: number | null
  }
  ram: {
    total: number
    used: number
    percent: number
  }
  disk: {
    total: number | null
    used: number | null
    free: number | null
    percent: number | null
    readBytesPerSec: number | null
    writeBytesPerSec: number | null
  }
  uptimeSeconds: number
  loadAverage: [number, number, number]
  network: {
    inBytesPerSec: number | null
    outBytesPerSec: number | null
  }
  ip: {
    public: string | null
    local: string | null
  }
  versions: VersionsInfo
  containers: ContainerInfo[]
  database: DatabaseInfo
  backups: BackupInfo
  services: ServiceStatusItem[]
  processes: ProcessRow[]
  history: {
    cpu: HistoryPoint[]
    ram: HistoryPoint[]
    network: NetworkHistoryPoint[]
  }
  generatedAt: string
}
