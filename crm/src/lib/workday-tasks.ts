import type { SupabaseClient } from '@supabase/supabase-js'

export interface WorkdayTask {
  id: string
  title: string
  due_date: string
  priority: string
  status: string
}

export interface WorkdayTaskSummary {
  today: number
  overdue: number
  tasks: WorkdayTask[]
}

export function workdayDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bishkek', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

// Use the signed-in user's RLS client, never a service-role client.
export async function getWorkdayTasks(supabase: SupabaseClient, employeeId: string, today: string): Promise<WorkdayTaskSummary> {
  const companyId = '00000000-0000-0000-0000-000000000001'
  const [dueToday, overdue, nextTasks] = await Promise.all([
    supabase.from('tasks').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('assignee_id', employeeId)
      .in('status', ['todo', 'in_progress']).eq('due_date', today),
    supabase.from('tasks').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('assignee_id', employeeId)
      .in('status', ['todo', 'in_progress']).lt('due_date', today),
    supabase.from('tasks').select('id, title, due_date, priority, status')
      .eq('company_id', companyId).eq('assignee_id', employeeId)
      .in('status', ['todo', 'in_progress']).lte('due_date', today)
      .order('due_date').order('created_at').limit(6),
  ])
  if (dueToday.error || overdue.error || nextTasks.error) throw new Error('Не удалось загрузить задачи рабочего стола')
  return { today: dueToday.count ?? 0, overdue: overdue.count ?? 0, tasks: (nextTasks.data ?? []) as WorkdayTask[] }
}
