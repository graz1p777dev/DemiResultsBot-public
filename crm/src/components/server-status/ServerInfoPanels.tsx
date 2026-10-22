'use client'

import { Boxes, Database, GitBranch, Archive, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import type { VersionsInfo, ContainerInfo, DatabaseInfo, BackupInfo } from '@/types/server-status'
import { formatBytes, formatRelative } from './format'

const cardCls = 'rounded-2xl bg-white p-5'
const titleCls = 'flex items-center gap-2 font-semibold text-sm mb-4'
const navy = '#0c2136'
const steel = '#8a97a5'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm" style={{ borderBottom: '1px solid #f1f2f4' }}>
      <span style={{ color: steel }}>{label}</span>
      <span className="font-medium text-right" style={{ color: navy }}>{value}</span>
    </div>
  )
}

// ─── Версии окружения ────────────────────────────────────────────────────────
export function VersionsPanel({ v }: { v: VersionsInfo }) {
  return (
    <div className={cardCls}>
      <div className={titleCls} style={{ color: navy }}>
        <GitBranch size={16} color="#0c4d6c" /> Версии окружения
      </div>
      <Row label="ОС" value={v.os ?? '—'} />
      <Row label="Ядро" value={v.kernel ?? '—'} />
      <Row label="Node.js" value={v.node ?? '—'} />
      <Row label="Next.js" value={v.next ?? '—'} />
      <Row label="Docker" value={v.docker ?? '—'} />
      <Row label="Git commit" value={<span className="font-mono">{v.gitCommit ?? '—'}</span>} />
      <Row label="Ветка" value={v.gitBranch ?? '—'} />
      <Row label="Деплой" value={formatRelative(v.deployedAt)} />
    </div>
  )
}

// ─── Docker-контейнеры ───────────────────────────────────────────────────────
function containerColor(status: string): string {
  if (status === 'healthy' || status === 'running') return '#16a34a'
  if (status === 'unhealthy' || status === 'exited') return '#dc2626'
  return '#d97706'
}

export function ContainersPanel({ containers }: { containers: ContainerInfo[] }) {
  return (
    <div className={cardCls}>
      <div className={titleCls} style={{ color: navy }}>
        <Boxes size={16} color="#0c4d6c" /> Контейнеры
        <span className="ml-1 text-xs font-normal" style={{ color: steel }}>({containers.length})</span>
      </div>
      {containers.length === 0 ? (
        <p className="text-sm" style={{ color: steel }}>Контейнеры не обнаружены</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: steel }} className="text-left text-xs">
                <th className="pb-2 font-medium">Контейнер</th>
                <th className="pb-2 font-medium">Статус</th>
                <th className="pb-2 font-medium">Uptime</th>
                <th className="pb-2 font-medium text-right">Рестарты</th>
                <th className="pb-2 font-medium text-right">CPU</th>
                <th className="pb-2 font-medium text-right">RAM</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name} style={{ borderTop: '1px solid #f1f2f4' }}>
                  <td className="py-2 font-medium" style={{ color: navy }}>{c.name}</td>
                  <td className="py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: containerColor(c.status) }} />
                      <span style={{ color: navy }}>{c.status}</span>
                    </span>
                  </td>
                  <td className="py-2" style={{ color: steel }}>{c.uptime}</td>
                  <td className="py-2 text-right" style={{ color: c.restarts > 0 ? '#c2410c' : steel }}>
                    {c.restarts}
                  </td>
                  <td className="py-2 text-right" style={{ color: navy }}>
                    {c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 text-right" style={{ color: navy }}>{formatBytes(c.memBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── База данных ─────────────────────────────────────────────────────────────
export function DatabasePanel({ db }: { db: DatabaseInfo }) {
  const connLabel =
    db.connections !== null && db.maxConnections !== null
      ? `${db.connections} / ${db.maxConnections}`
      : db.connections !== null
        ? String(db.connections)
        : '—'
  const slow = db.slowQueries ?? 0
  return (
    <div className={cardCls}>
      <div className={titleCls} style={{ color: navy }}>
        <Database size={16} color="#0c4d6c" /> База данных
      </div>
      <Row label="Подключения" value={connLabel} />
      <Row label="Размер базы" value={formatBytes(db.sizeBytes)} />
      <Row
        label="Медленные запросы"
        value={<span style={{ color: slow > 0 ? '#c2410c' : navy }}>{db.slowQueries ?? '—'}</span>}
      />
    </div>
  )
}

// ─── Бэкапы ──────────────────────────────────────────────────────────────────
export function BackupsPanel({ b }: { b: BackupInfo }) {
  const StatusIcon = b.ok === true ? CheckCircle2 : b.ok === false ? XCircle : AlertTriangle
  const statusColor = b.ok === true ? '#16a34a' : b.ok === false ? '#dc2626' : '#d97706'
  return (
    <div className={cardCls}>
      <div className={titleCls} style={{ color: navy }}>
        <Archive size={16} color="#0c4d6c" /> Бэкапы
      </div>
      <Row
        label="Последний"
        value={
          b.lastAt
            ? `${new Date(b.lastAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${formatRelative(b.lastAt)}`
            : '—'
        }
      />
      <Row label="Размер" value={formatBytes(b.lastSizeBytes)} />
      <Row
        label="Статус"
        value={
          <span className="inline-flex items-center gap-1.5" style={{ color: statusColor }}>
            <StatusIcon size={14} /> {b.ok === true ? 'успешно' : b.ok === false ? 'ошибка' : 'неизвестно'}
          </span>
        }
      />
      <Row label="Следующий" value={b.nextAt ? formatRelative(b.nextAt) : '—'} />
    </div>
  )
}
