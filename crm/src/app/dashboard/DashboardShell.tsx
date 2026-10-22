'use client'
import { useEffect, useState, useTransition } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import Sidebar from '@/components/Sidebar'
import Topbar from '@/components/layout/Topbar'
import AttendanceWidget from '@/components/attendance/AttendanceWidget'
import { stopImpersonation } from '@/actions/auth'
import CopilotDrawer from '@/components/layout/CopilotDrawer'

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, impersonating } = useAuth()
  const [pending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)

  // Сессия истекла прямо во время работы пользователя — перенаправляем на логин.
  // При первом рендере user всегда установлен (данные пришли с сервера),
  // поэтому это срабатывает только при реальном logout/expiry.
  useEffect(() => {
    if (!user) {
      window.location.href = '/auth/login'
    }
  }, [user])

  if (!user) return null

  const handleExitImpersonation = () => {
    startTransition(async () => {
      await stopImpersonation()
      window.location.href = '/dashboard/employees'
    })
  }

  return (
    <div className="dr-app-shell flex min-h-screen">

      {/* Затемнение под мобильным drawer */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#0c2136]/45 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {impersonating && (
          <div className="flex shrink-0 items-center justify-between bg-amber-300 px-4 py-2 text-sm font-medium text-amber-950">
            <span>
              👤 Вы просматриваете систему от имени <strong>{impersonating.name}</strong> ({impersonating.role})
            </span>
            <button
              onClick={handleExitImpersonation}
              disabled={pending}
              className="ml-4 rounded-lg bg-black/10 px-3 py-1 text-xs font-semibold hover:bg-black/15"
            >
              {pending ? '...' : '← Выйти в свой аккаунт'}
            </button>
          </div>
        )}
        <Topbar onMenuClick={() => setMenuOpen(true)} />
        <AttendanceWidget />
        <main className="flex-1 min-w-0">
          {children}
        </main>
        <CopilotDrawer />
      </div>
    </div>
  )
}
