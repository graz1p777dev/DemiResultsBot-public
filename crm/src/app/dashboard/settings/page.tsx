'use client'

import Link from 'next/link'
import { Settings, ShieldCheck, DollarSign, Building2, CalendarDays, SlidersHorizontal, BookOpen, ChevronRight, Users, Workflow } from 'lucide-react'

const CARDS = [
  { href: '/dashboard/employees',       icon: Users,              title: 'Сотрудники и команда', desc: 'Добавление, роли, увольнение и восстановление сотрудников' },
  { href: '/dashboard/settings/roles',       icon: ShieldCheck,        title: 'Роли и доступы',  desc: 'Кто что может видеть, создавать, менять и удалять' },
  { href: '/dashboard/settings/kpi',         icon: DollarSign,         title: 'KPI и оплата',    desc: 'Оклады, бонусы, ступени, KPI-пункты по ролям' },
  { href: '/dashboard/settings/departments', icon: Building2,          title: 'Отделы',          desc: 'Структура компании, руководители отделов' },
  { href: '/dashboard/settings/schedules',   icon: CalendarDays,       title: 'Графики работы',  desc: 'Справочник рабочих графиков сотрудников' },
  { href: '/dashboard/settings/glossary',    icon: BookOpen,           title: 'Словарь терминов', desc: 'Что значат термины системы — простыми словами' },
  { href: '/dashboard/settings/general',     icon: SlidersHorizontal,  title: 'Общее',           desc: 'Информация о системе и окружении' },
  { href: '/dashboard/settings/crm-fields',  icon: SlidersHorizontal,  title: 'Поля CRM',        desc: 'Настраиваемые поля контактов и сделок' },
  { href: '/dashboard/settings/pipelines',   icon: Workflow,          title: 'Воронки и этапы',  desc: 'Этапы, порядок, обязательные данные и правила закрытия' },
]

export default function SettingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#f5f6f8' }}>
      <div
        className="flex items-center gap-3 px-6 py-4"
        style={{ backgroundColor: '#0c2136' }}
      >
        <div
          className="flex items-center justify-center w-9 h-9 rounded-xl"
          style={{ backgroundColor: '#0c4d6c' }}
        >
          <Settings size={18} color="#ffffff" />
        </div>
        <div>
          <div className="text-white font-semibold text-base leading-tight">Настройки</div>
          <div className="text-xs" style={{ color: '#a2b4c0' }}>Управление системой</div>
        </div>
      </div>

      <div className="p-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ href, icon: Icon, title, desc }) => (
          <Link
            key={href}
            href={href}
            className="rounded-2xl p-5 flex flex-col gap-3 transition-shadow hover:shadow-md"
            style={{ backgroundColor: '#ffffff', border: '1px solid #ebebee' }}
          >
            <div className="flex items-center justify-between">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl"
                style={{ backgroundColor: '#e6ebee' }}
              >
                <Icon size={18} color="#0c4d6c" />
              </div>
              <ChevronRight size={16} color="#a2b4c0" />
            </div>
            <div>
              <div className="font-semibold text-sm" style={{ color: '#0c2136' }}>{title}</div>
              <div className="text-xs mt-1" style={{ color: '#a2b4c0' }}>{desc}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
