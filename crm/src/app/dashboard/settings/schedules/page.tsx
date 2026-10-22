'use client'

import { CalendarDays } from 'lucide-react'
import { SettingsSubpageHeader } from '@/components/settings/BackToSettings'
import { WorkSchedulesPanel } from '@/components/settings/WorkSchedulesPanel'

export default function SchedulesSettingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <SettingsSubpageHeader
        icon={<CalendarDays size={18} color="#ffffff" />}
        title="Графики работы"
        subtitle="Справочник рабочих графиков сотрудников"
      />
      <div className="p-5 max-w-2xl">
        <WorkSchedulesPanel />
      </div>
    </div>
  )
}
