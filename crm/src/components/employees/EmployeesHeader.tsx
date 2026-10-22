'use client'

import { Users, ChevronLeft, ChevronRight } from 'lucide-react'
import { MONTHS } from './employees-utils'

interface Props {
  year:    number
  month:   number
  onPrev:  () => void
  onNext:  () => void
}

export default function EmployeesHeader({ year, month, onPrev, onNext }: Props) {
  return (
    <div
      className="flex items-center justify-between px-5 py-4"
      style={{ backgroundColor: '#0c2136' }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl" style={{ backgroundColor: '#0c4d6c' }}>
          <Users size={18} color="#ffffff" />
        </div>
        <div>
          <div className="text-white font-semibold text-base leading-tight">Сотрудники</div>
          <div className="text-xs" style={{ color: '#a2b4c0' }}>KPI и зарплата за период</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
          style={{ backgroundColor: '#0c4d6c' }}
        >
          <ChevronLeft size={16} color="#ffffff" />
        </button>
        <div className="text-white font-medium text-sm min-w-[120px] text-center">
          {MONTHS[month]} {year}
        </div>
        <button
          onClick={onNext}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
          style={{ backgroundColor: '#0c4d6c' }}
        >
          <ChevronRight size={16} color="#ffffff" />
        </button>
      </div>
    </div>
  )
}
