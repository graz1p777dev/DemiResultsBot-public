import Link from 'next/link'
import { ArrowUpRight, CheckCheck, Clock3 } from 'lucide-react'
import { can, getActor } from '@/lib/authz'
import { createTokenClient } from '@/lib/supabase/token-client'
import { getWorkdayTasks, type WorkdayTaskSummary } from '@/lib/workday-tasks'
import styles from './WorkdayTasks.module.css'

export function WorkdayTasksView({ data, today, failed = false }: { data: WorkdayTaskSummary | null; today: string; failed?: boolean }) {
  return <section className={styles.panel} aria-labelledby="workday-tasks-title">
    <header className={styles.header}>
      <div><h2 id="workday-tasks-title">Мои задачи</h2><p>Сначала просроченные, затем задачи на сегодня</p></div>
      <Link className={styles.link} href="/dashboard/tasks/kanban?mine=1">Все мои задачи <ArrowUpRight size={16} aria-hidden /></Link>
    </header>
    {failed ? <p className={styles.empty} role="alert">Задачи временно не загрузились. Обновите страницу или откройте канбан.</p> : data ? <>
      <div className={styles.counters}>
        <Link href="/dashboard/tasks/kanban?mine=1&due=today"><strong>{data.today}</strong><span>На сегодня</span></Link>
        <Link href="/dashboard/tasks/kanban?mine=1&due=overdue" data-urgent={data.overdue > 0}><strong>{data.overdue}</strong><span>Просрочено</span></Link>
      </div>
      {data.tasks.length ? <ul className={styles.list}>{data.tasks.map(task => <li key={task.id}>
        <Link href={`/dashboard/tasks/kanban?task=${encodeURIComponent(task.id)}`}>
          <Clock3 size={18} aria-hidden />
          <div><strong>{task.title}</strong><span>{task.status === 'in_progress' ? 'В работе' : 'К выполнению'}{['urgent', 'high'].includes(task.priority) ? ' · Высокий приоритет' : ''}</span></div>
          <time dateTime={task.due_date} data-overdue={task.due_date < today}>{task.due_date === today ? 'Сегодня' : new Date(`${task.due_date}T12:00:00+06:00`).toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek', day: 'numeric', month: 'short' })}</time>
        </Link>
      </li>)}</ul> : <div className={styles.empty}><CheckCheck size={24} aria-hidden /><p>На сегодня нет незавершённых задач. Можно заняться новыми клиентами.</p></div>}
      {data.today + data.overdue > data.tasks.length && <p className={styles.footnote}>Показаны первые {data.tasks.length} задач. Полный список — в канбане.</p>}
    </> : <p className={styles.empty}>Загружаю задачи…</p>}
  </section>
}

export default async function WorkdayTasks({ accessToken, today }: { accessToken: string; today: string }) {
  const actor = await getActor()
  if (!actor || !await can(actor, 'tasks', 'view')) return null
  let data: WorkdayTaskSummary
  try {
    data = await getWorkdayTasks(createTokenClient(accessToken), actor.employeeId, today)
  } catch {
    return <WorkdayTasksView data={null} today={today} failed />
  }
  return <WorkdayTasksView data={data} today={today} />
}
