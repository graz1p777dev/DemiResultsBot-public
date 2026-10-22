'use client'

import { SlidersHorizontal } from 'lucide-react'
import { SettingsSubpageHeader } from '@/components/settings/BackToSettings'
import { SectionCard } from '@/components/settings/SectionCard'

const ENV_LABEL = process.env.NEXT_PUBLIC_ENV_LABEL ?? '—'

export default function GeneralSettingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <SettingsSubpageHeader
        icon={<SlidersHorizontal size={18} color="#ffffff" />}
        title="Общее"
        subtitle="Информация о системе и окружении"
      />
      <div className="p-5 max-w-xl">
        <SectionCard icon={<SlidersHorizontal size={15} color="#ffffff" />} title="О системе">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span style={{ color: '#a2b4c0' }}>Название</span>
              <span className="font-medium" style={{ color: '#0c2136' }}>Demi Results — Business OS</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: '#a2b4c0' }}>Окружение</span>
              <span
                className="font-medium px-2 py-0.5 rounded-md text-xs"
                style={{
                  color: ENV_LABEL === 'PRODUCTION' ? '#dc2626' : '#0c4d6c',
                  backgroundColor: ENV_LABEL === 'PRODUCTION' ? '#fee2e2' : '#dbeafe',
                }}
              >
                {ENV_LABEL}
              </span>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  )
}
