'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  Gauge,
  Wifi,
  Globe,
  RotateCw,
  ShieldAlert,
  ArrowDown,
  ArrowUp,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import type { ServerStatusResponse } from '@/types/server-status'
import { MetricCard, MetricCardSkeleton } from '@/components/server-status/MetricCard'
import { ServicesPanel, ServicesPanelSkeleton } from '@/components/server-status/ServicesPanel'
import { ProcessTable, ProcessTableSkeleton } from '@/components/server-status/ProcessTable'
import {
  CpuHistoryChart,
  RamHistoryChart,
  NetworkHistoryChart,
  ChartCardSkeleton,
} from '@/components/server-status/ServerCharts'
import { formatBytes, formatBytesPerSec, formatUptime } from '@/components/server-status/format'
import {
  VersionsPanel,
  ContainersPanel,
  DatabasePanel,
  BackupsPanel,
} from '@/components/server-status/ServerInfoPanels'
import { SecurityPanel } from '@/components/server-status/SecurityPanel'
import { LogsPanel } from '@/components/server-status/LogsPanel'
import { WatchdogPanel } from '@/components/server-status/WatchdogPanel'
import Link from 'next/link'
import { Package } from 'lucide-react'

const POLL_INTERVAL_MS = 5000

function AccessDenied() {
  return (
    <div className="p-4 md:p-8">
      <div className="rounded-2xl bg-white p-10 flex flex-col items-center text-center gap-3 max-w-md mx-auto">
        <div
          className="flex items-center justify-center w-12 h-12 rounded-2xl"
          style={{ background: 'linear-gradient(135deg,#ef4444 0%,#7c2d12 100%)' }}
        >
          <ShieldAlert size={22} color="#fff" />
        </div>
        <h1 className="font-semibold text-base" style={{ color: '#0c2136' }}>
          Доступ ограничен
        </h1>
        <p className="text-sm" style={{ color: '#8a97a5' }}>
          Мониторинг сервера доступен только владельцу аккаунта.
        </p>
      </div>
    </div>
  )
}

export default function ServerStatusPage() {
  const { user } = useAuth()

  // TODO: если появятся более гранулярные роли (например, отдельный
  // "sysadmin"), заменить это на проверку через них — сейчас в системе
  // максимальный уровень доступа только 'owner' (см. src/types UserRole).
  const isOwner = user?.role === 'owner'

  const [data, setData] = useState<ServerStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true)
    try {
      const res = await fetch('/api/server/status', { cache: 'no-store' })
      if (res.status === 403) {
        setError('Доступ запрещён')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ServerStatusResponse = await res.json()
      setData(json)
      setError(null)
    } catch {
      setError('Не удалось получить данные сервера')
    } finally {
      setLoading(false)
      if (isManual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!isOwner) return
    // Fetch-on-mount + polling — намеренное исключение из
    // react-hooks/set-state-in-effect, тот же паттерн, что и в остальных
    // дашборд-страницах (см. bot-analytics/page.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    timerRef.current = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner])

  if (!isOwner) return <AccessDenied />

  const lastUpdated = data ? new Date(data.generatedAt).toLocaleTimeString('ru-RU') : null

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5">
      {/* Заголовок */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-bold text-xl" style={{ color: '#0c2136' }}>
            Состояние сервера
          </h1>
          <p className="text-sm mt-0.5" style={{ color: '#8a97a5' }}>
            {lastUpdated ? `Последнее обновление: ${lastUpdated}` : 'Собираем данные...'}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60 transition-opacity"
          style={{ backgroundColor: '#0c4d6c' }}
        >
          <RotateCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Обновить сейчас
        </button>
      </div>

      {error && (
        <div
          className="rounded-2xl px-5 py-3.5 text-sm font-medium flex items-center gap-2.5"
          style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}
        >
          <ShieldAlert size={16} />
          {error}
        </div>
      )}

      {loading && !data ? (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            {Array.from({ length: 7 }).map((_, i) => (
              <MetricCardSkeleton key={i} />
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCardSkeleton />
            <ChartCardSkeleton />
          </div>
          <ChartCardSkeleton />
          <div className="grid gap-5 lg:grid-cols-2">
            <ServicesPanelSkeleton />
            <ProcessTableSkeleton />
          </div>
        </>
      ) : data ? (
        <>
          {/* KPI-карточки */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            <MetricCard
              icon={Cpu}
              iconBg="linear-gradient(135deg,#2563eb 0%,#0c4d6c 100%)"
              label="Загрузка CPU"
              value={data.cpu.percent !== null ? `${data.cpu.percent}%` : '—'}
              progress={data.cpu.percent}
              progressColor="#2563eb"
            />
            <MetricCard
              icon={MemoryStick}
              iconBg="linear-gradient(135deg,#7c3aed 0%,#2563eb 100%)"
              label="RAM"
              value={`${data.ram.percent}%`}
              sublabel={`${formatBytes(data.ram.used)} / ${formatBytes(data.ram.total)}`}
              progress={data.ram.percent}
              progressColor="#7c3aed"
            />
            <MetricCard
              icon={HardDrive}
              iconBg="linear-gradient(135deg,#0f766e 0%,#14b8a6 100%)"
              label="Диск"
              value={data.disk.percent !== null ? `${data.disk.percent}%` : '—'}
              sublabel={
                data.disk.free !== null
                  ? `${formatBytes(data.disk.free)} свободно`
                  : data.disk.total !== null
                    ? `${formatBytes(data.disk.used)} / ${formatBytes(data.disk.total)}`
                    : 'недоступно'
              }
              progress={data.disk.percent}
              progressColor="#0f766e"
            />
            <MetricCard
              icon={HardDrive}
              iconBg="linear-gradient(135deg,#334155 0%,#0f766e 100%)"
              label="Диск I/O"
              value=""
              extra={
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#15803d' }}>
                    <ArrowDown size={14} /> {formatBytesPerSec(data.disk.readBytesPerSec)}
                  </div>
                  <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#c2410c' }}>
                    <ArrowUp size={14} /> {formatBytesPerSec(data.disk.writeBytesPerSec)}
                  </div>
                </div>
              }
            />
            <MetricCard
              icon={Clock}
              iconBg="linear-gradient(135deg,#16a34a 0%,#0c4d6c 100%)"
              label="Uptime"
              value={formatUptime(data.uptimeSeconds)}
            />
            <MetricCard
              icon={Gauge}
              iconBg="linear-gradient(135deg,#db2777 0%,#7c3aed 100%)"
              label="Load average"
              value={data.loadAverage.map((v) => v.toFixed(2)).join(' / ')}
              sublabel="1 / 5 / 15 мин"
            />
            <MetricCard
              icon={Wifi}
              iconBg="linear-gradient(135deg,#0891b2 0%,#2563eb 100%)"
              label="Сеть"
              value=""
              extra={
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#15803d' }}>
                    <ArrowDown size={14} /> {formatBytesPerSec(data.network.inBytesPerSec)}
                  </div>
                  <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#c2410c' }}>
                    <ArrowUp size={14} /> {formatBytesPerSec(data.network.outBytesPerSec)}
                  </div>
                </div>
              }
            />
            <MetricCard
              icon={Globe}
              iconBg="linear-gradient(135deg,#64748b 0%,#0c2136 100%)"
              label="IP-адрес"
              value=""
              extra={
                <div className="flex flex-col gap-0.5 text-sm font-mono">
                  <div style={{ color: '#0c2136' }}>
                    <span style={{ color: '#b3bcc5', fontFamily: 'inherit' }}>внеш: </span>
                    {data.ip.public ?? '—'}
                  </div>
                  <div style={{ color: '#0c2136' }}>
                    <span style={{ color: '#b3bcc5', fontFamily: 'inherit' }}>локал: </span>
                    {data.ip.local ?? '—'}
                  </div>
                </div>
              }
            />
          </div>

          {/* Графики */}
          <div className="grid gap-5 lg:grid-cols-2">
            <CpuHistoryChart data={data.history.cpu} />
            <RamHistoryChart data={data.history.ram} />
          </div>
          <NetworkHistoryChart data={data.history.network} />

          {/* Контейнеры — на всю ширину */}
          <ContainersPanel containers={data.containers} />

          {/* Версии + база + бэкапы */}
          <div className="grid gap-5 lg:grid-cols-3 items-start">
            <VersionsPanel v={data.versions} />
            <DatabasePanel db={data.database} />
            <BackupsPanel b={data.backups} />
          </div>

          {/* Безопасность + сервисы */}
          <div className="grid gap-5 lg:grid-cols-2 items-start">
            <SecurityPanel />
            <ServicesPanel services={data.services} />
          </div>

          <WatchdogPanel />

          {/* Логи в реальном времени */}
          <LogsPanel />

          {/* Процессы + ссылка на зависимости */}
          <ProcessTable processes={data.processes} />

          <Link
            href="/dashboard/server-status/dependencies"
            className="inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-4 text-sm font-medium w-fit"
            style={{ color: '#0c4d6c' }}
          >
            <Package size={16} /> Все зависимости и версии пакетов →
          </Link>
        </>
      ) : null}
    </div>
  )
}
