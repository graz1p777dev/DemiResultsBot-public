'use client'

import { ShieldCheck } from 'lucide-react'
import { SettingsSubpageHeader } from '@/components/settings/BackToSettings'
import { AccessControlPanel } from '@/components/settings/AccessControlPanel'
import { RolesPanel } from '@/components/settings/RolesPanel'

export default function RolesAndAccessPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <SettingsSubpageHeader
        icon={<ShieldCheck size={18} color="#ffffff" />}
        title="Роли и доступы"
        subtitle="Кто что может видеть, создавать, менять и удалять"
      />
      <div className="p-5 space-y-5 max-w-3xl">
        <AccessControlPanel />
        <RolesPanel />
      </div>
    </div>
  )
}
