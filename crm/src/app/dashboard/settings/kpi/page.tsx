'use client'

import { DollarSign } from 'lucide-react'
import { SettingsSubpageHeader } from '@/components/settings/BackToSettings'
import { KpiSettingsPanel } from '@/components/dashboard/KpiSettingsPanel'

export default function KpiSettingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <SettingsSubpageHeader
        icon={<DollarSign size={18} color="#ffffff" />}
        title="KPI и оплата"
        subtitle="Оклады, бонусы, ступени, KPI-пункты по ролям"
      />
      <div className="p-5 max-w-3xl">
        <KpiSettingsPanel />
      </div>
    </div>
  )
}
