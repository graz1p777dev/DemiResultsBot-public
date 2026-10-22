import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getEmployeeByUserId } from '@/lib/identity'
import { getDayGreeting } from '@/lib/formatters'
import LeftPanel from '@/components/dashboard/LeftPanel'
import LeftPanelSkeleton from '@/components/dashboard/LeftPanelSkeleton'
import RightPanel from '@/components/dashboard/RightPanel'
import RightPanelSkeleton from '@/components/dashboard/RightPanelSkeleton'
import CrmLiveSummary from '@/components/dashboard/CrmLiveSummary'
import TopConfirmers from '@/components/dashboard/TopConfirmers'
import WorkdayTasks, { WorkdayTasksView } from '@/components/dashboard/WorkdayTasks'
import { workdayDate } from '@/lib/workday-tasks'
import styles from './SamatDashboard.module.css'

export const metadata = { title: 'Рабочий стол — Demi Results' }

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { session } } = await supabase.auth.getSession()

  // access_token передаётся в LeftPanel/RightPanel как строка (serializable),
  // чтобы они не вызывали cookies() внутри Suspense во время стриминга.
  const accessToken = session?.access_token ?? null

  let role = 'mp'
  let permissionLevel = 'employee'
  let employeeId: string | undefined
  let departmentId: string | null = null

  if (session?.user) {
    // employees берётся из мемоизированного на запрос чтения (см. src/lib/identity.ts) —
    // ту же строку уже прочитали RootLayout и DashboardLayout, сеть не задействуется.
    const [emp, { data: permLevel }] = await Promise.all([
      getEmployeeByUserId(session.user.id),
      // get_my_permission_level() — SECURITY DEFINER функция из migration 025
      supabase.rpc('get_my_permission_level'),
    ])

    if (emp) {
      role = emp.role as string
      employeeId = emp.id as string
      departmentId = emp.department_id as string | null
    }
    if (permLevel) {
      permissionLevel = permLevel as string
    } else {
      // Фолбэк для системных ролей (если миграция ещё не применена)
      const SYSTEM_LEVELS: Record<string, string> = {
        owner: 'owner', rop: 'department_head',
        mp: 'employee', lmai: 'employee', accountant: 'accountant',
      }
      permissionLevel = SYSTEM_LEVELS[role] ?? 'employee'
    }
  }

  // Бухгалтер видит только финансы
  if (permissionLevel === 'accountant') redirect('/dashboard/finance')

  // Нет сессии — middleware должен поймать раньше, но на всякий случай
  if (!accessToken) redirect('/auth/login')

  const now = new Date()
  const dateStr = workdayDate(now)
  const [year, month] = dateStr.split('-').map(Number)
  const greeting = getDayGreeting()

  const dayLabel = now.toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: 'numeric', month: 'long' })
  const monthLabel = now.toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', month: 'long', year: 'numeric' })

  return (
    <div className={`dr-dashboard ${styles.workspace}`} data-ui="samat-dashboard">
      {/* ── Левая панель: итоги месяца ── */}
      <div
        className={styles.reportSheet}
      >
        <div className={styles.sectionHeading}>
          <div><p>{greeting} · {monthLabel}</p><h2>Итоги месяца</h2></div>
        </div>

        <Suspense fallback={<LeftPanelSkeleton />}>
          <LeftPanel
            year={year}
            month={month}
            employeeId={employeeId}
            role={role}
            permissionLevel={permissionLevel}
            accessToken={accessToken}
          />
        </Suspense>
        <Suspense fallback={null}><CrmLiveSummary /></Suspense>
      </div>

      {/* ── Правая панель: сегодня ── */}
      <div
        className={`${styles.reportSheet} ${styles.todaySheet}`}
      >
        <div className={styles.sectionHeading}>
          <div><p>{dayLabel}</p><h2>Сегодня</h2></div>
        </div>

        <Suspense fallback={<RightPanelSkeleton />}>
          <RightPanel
            dateStr={dateStr}
            role={role}
            permissionLevel={permissionLevel}
            employeeId={employeeId}
            departmentId={departmentId}
            accessToken={accessToken}
          />
        </Suspense>
        <div className={styles.sideTools}>
          <Suspense fallback={<WorkdayTasksView data={null} today={dateStr} />}><WorkdayTasks accessToken={accessToken} today={dateStr} /></Suspense>
          <TopConfirmers />
        </div>
      </div>
    </div>
  )
}
