'use client'

import { Building2 } from 'lucide-react'
import { SettingsSubpageHeader } from '@/components/settings/BackToSettings'
import { DepartmentsPanel } from '@/components/settings/DepartmentsPanel'

export default function DepartmentsSettingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <SettingsSubpageHeader
        icon={<Building2 size={18} color="#ffffff" />}
        title="Отделы"
        subtitle="Структура компании, руководители отделов"
      />
      <div className="p-5 max-w-2xl">
        <DepartmentsPanel />
      </div>
    </div>
  )
}
