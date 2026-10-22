'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Package, ShieldAlert } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import type { DependenciesInfo, DependencyItem } from '@/types/server-status'

const navy = '#0c2136'
const steel = '#8a97a5'

function DepTable({ title, items, count }: { title: string; items: DependencyItem[]; count?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex items-center gap-2 font-semibold text-sm mb-3" style={{ color: navy }}>
        <Package size={15} color="#0c4d6c" /> {title}
        {count && <span className="text-xs font-normal" style={{ color: steel }}>({items.length})</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-sm" style={{ color: steel }}>Нет данных</p>
      ) : (
        <div className="overflow-x-auto" style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="w-full text-sm">
            <tbody>
              {items.map((d) => (
                <tr key={d.name} style={{ borderBottom: '1px solid #f1f2f4' }}>
                  <td className="py-1.5 pr-3 font-mono" style={{ color: navy }}>{d.name}</td>
                  <td className="py-1.5 text-right font-mono" style={{ color: steel }}>{d.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function DependenciesClient() {
  const { user } = useAuth()
  const isOwner = user?.role === 'owner'
  const [data, setData] = useState<DependenciesInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOwner) return
    let alive = true
    fetch('/api/server/dependencies', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: DependenciesInfo) => alive && setData(d))
      .catch(() => alive && setError('Не удалось загрузить зависимости'))
    return () => {
      alive = false
    }
  }, [isOwner])

  if (!isOwner) {
    return (
      <div className="p-4 md:p-8">
        <div className="rounded-2xl bg-white p-10 flex flex-col items-center text-center gap-3 max-w-md mx-auto">
          <ShieldAlert size={22} color="#dc2626" />
          <p className="text-sm" style={{ color: steel }}>Доступно только владельцу.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5">
      <div>
        <Link href="/dashboard/server-status" className="inline-flex items-center gap-1.5 text-sm mb-2" style={{ color: '#0c4d6c' }}>
          <ArrowLeft size={14} /> К состоянию сервера
        </Link>
        <h1 className="font-bold text-xl" style={{ color: navy }}>Зависимости</h1>
        <p className="text-sm mt-0.5" style={{ color: steel }}>
          Полный список пакетов и образов на сервере
        </p>
      </div>

      {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
      {!data && !error && <p className="text-sm" style={{ color: steel }}>Загружаем…</p>}

      {data && (
        <div className="grid gap-5 lg:grid-cols-2 items-start">
          <DepTable title="CRM — зависимости" items={data.crm} count />
          <DepTable title="CRM — dev-зависимости" items={data.crmDev} count />
          <DepTable title="Бот (Python)" items={data.bot} count />
          <DepTable title="Docker-образы" items={data.images} count />
        </div>
      )}
    </div>
  )
}
