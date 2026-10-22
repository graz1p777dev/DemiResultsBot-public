'use client'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export function SettingsSubpageHeader({ icon, title, subtitle }: {
  icon: React.ReactNode
  title: string
  subtitle: string
}) {
  return (
    <div
      className="flex items-center gap-3 px-6 py-4"
      style={{ backgroundColor: '#0c2136' }}
    >
      <Link
        href="/dashboard/settings"
        className="flex items-center justify-center w-8 h-8 rounded-xl transition-colors"
        style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
        title="Назад к настройкам"
      >
        <ArrowLeft size={16} color="#a2b4c0" />
      </Link>
      <div
        className="flex items-center justify-center w-9 h-9 rounded-xl"
        style={{ backgroundColor: '#0c4d6c' }}
      >
        {icon}
      </div>
      <div>
        <div className="text-white font-semibold text-base leading-tight">{title}</div>
        <div className="text-xs" style={{ color: '#a2b4c0' }}>{subtitle}</div>
      </div>
    </div>
  )
}
