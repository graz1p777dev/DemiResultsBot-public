'use client'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useMemo, useSyncExternalStore } from 'react'
import { Bell, Menu } from 'lucide-react'
import Link from 'next/link'
import { useAuth } from '@/contexts/AuthContext'
import { NAV_GROUPS } from '@/config/nav'
import { createClient } from '@/lib/supabase/client'
import { getInitials, formatDateFull } from '@/lib/formatters'
import { ROLE_LABELS } from '@/lib/constants'
import type { UserRole } from '@/types'
import { ProfileDialog } from '@/components/profile/ProfileDialog'
import ThemeToggle from './ThemeToggle'
import PageHelp from './PageHelp'

const STATIC_PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Рабочий стол',
  '/dashboard/consultations': 'Консультации',
  '/dashboard/decomposition': 'Декомпозиция',
  '/dashboard/salary': 'Зарплата',
  '/dashboard/finance': 'Финансы',
  '/dashboard/marketing': 'Маркетинг',
  '/dashboard/employees': 'Сотрудники',
  '/dashboard/calendar': 'Рабочий календарь',
  '/dashboard/notifications': 'Уведомления',
  '/dashboard/documents': 'Документы',
  '/dashboard/settings': 'Настройки',
}

const PAGE_TITLES: Record<string, string> = NAV_GROUPS
  .flatMap(group => group.items)
  .reduce<Record<string, string>>((acc, item) => {
    acc[item.href] = item.label
    return acc
  }, { ...STATIC_PAGE_TITLES })

function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname]
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length >= 3) {
    const base = '/' + segments.slice(0, 3).join('/')
    return PAGE_TITLES[base] ? PAGE_TITLES[base] + ' / Детали' : 'Страница'
  }
  return 'Страница'
}

const emptySubscribe = () => () => {}

export default function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname()
  const { user } = useAuth()
  const [unreadCount, setUnreadCount] = useState(0)
  const [profileOpen, setProfileOpen] = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const role = user?.role as UserRole | undefined
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false)
  const today = isClient ? formatDateFull(new Date().toISOString()) : ''

  useEffect(() => {
    if (!user?.id) return

    const fetchUnread = async () => {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('employee_id', user.id)
        .eq('is_read', false)
      setUnreadCount(count ?? 0)
    }

    fetchUnread()

    const channel = supabase
      .channel('topbar-notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `employee_id=eq.${user.id}`,
        },
        () => fetchUnread()
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [user?.id, supabase])

  return (
    <header
      className="dr-topbar flex shrink-0 items-center gap-4 px-5"
    >
      {/* Гамбургер — только мобильный */}
      <button
        onClick={onMenuClick}
        className="md:hidden flex items-center justify-center rounded-md flex-shrink-0"
        style={{ width: 36, height: 36, color: '#0c2136' }}
        title="Меню"
        aria-label="Открыть меню"
      >
        <Menu style={{ width: 19, height: 19 }} />
      </button>

      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold text-[#0c2136] dark:text-slate-100">{getPageTitle(pathname)}</h1></div>

      {/* Правая часть */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <PageHelp />
        <ThemeToggle />
        {/* Текущая страница */}

        {/* Дата */}
        {today && (
          <span
            className="hidden sm:block"
            style={{ fontSize: 12, color: '#a2b4c0' }}
          >
            {today}
          </span>
        )}

        {/* Колокол */}
        <Link
          href="/dashboard/notifications"
          className="relative flex items-center justify-center rounded-md"
          style={{ width: 36, height: 36, color: '#536b7b' }}
          title="Уведомления"
        >
          <Bell style={{ width: 16, height: 16 }} />
          {unreadCount > 0 && (
            <span
              className="absolute flex items-center justify-center text-white font-bold"
              style={{
                top: 4, right: 4,
                minWidth: 14, height: 14,
                backgroundColor: '#dc2626',
                borderRadius: 7,
                fontSize: 9,
                lineHeight: 1,
                padding: '0 3px',
              }}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Link>

        {/* Аватар пользователя — открывает профиль */}
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className="flex items-center gap-2 rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-[#e5f1f6] dark:hover:bg-[#102b40]"
          title={role ? `${ROLE_LABELS[role]} · открыть профиль` : 'Открыть профиль'}
        >
          <div
            className="dr-mark flex shrink-0 items-center justify-center rounded-full text-white font-semibold"
            style={{
              width: 28, height: 28,
              fontSize: 10,
            }}
          >
            {user?.name ? getInitials(user.name) : '??'}
          </div>
          <span
            className="hidden md:block font-medium"
            style={{ fontSize: 12, color: '#0c2136', maxWidth: 100 }}
          >
            {user?.name?.split(' ')[0] ?? ''}
          </span>
        </button>
      </div>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </header>
  )
}
