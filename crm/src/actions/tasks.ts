'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getViewer, isManager } from '@/lib/decomposition/viewer'
import { can, actorFromViewer } from '@/lib/authz'

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

export type ActionResult = { success: true } | { success: false; error: string }

export type TaskStatus = 'created' | 'done_by_employee' | 'confirmed' | 'rejected'

export interface TaskRow {
  id:               string
  title:            string
  description:      string | null
  assigned_to:      string
  assignee_name:    string
  created_by:       string
  creator_name:     string | null
  deadline:         string
  status:           TaskStatus
  completed_at:     string | null
  confirmed_at:     string | null
  confirmed_by:     string | null
  rejection_reason: string | null
  created_at:       string
}

export interface TasksData {
  role:      string
  isManager: boolean
  myEmployeeId: string
  tasks:     TaskRow[]
}

export interface AssignableEmployee {
  id:   string
  name: string
  role: string
}

function toTaskStatus(status: string, rejectionReason: string | null): TaskStatus {
  if (status === 'review') return 'done_by_employee'
  if (status === 'done') return 'confirmed'
  if (status === 'in_progress' && rejectionReason) return 'rejected'
  return 'created'
}

// ─── Список задач (проекция по роли — RLS дублируется серверной логикой) ──────

export async function getTasks(): Promise<TasksData | null> {
  const viewer = await getViewer()
  if (!viewer) return null
  if (!await can(actorFromViewer(viewer), 'tasks', 'view')) return null

  const admin = createAdminClient()
  const manager = isManager(viewer)

  // Определяем область видимости
  let query = admin
    .from('tasks')
    .select('id, title, description, assignee_id, created_by, due_date, status, completed_at, confirmed_at, confirmed_by, rejection_reason, created_at')
    .order('due_date', { ascending: true })

  if (viewer.role === 'owner') {
    // все задачи
  } else if (viewer.permission_level === 'department_head') {
    // задачи своего отдела ИЛИ созданные им
    const { data: deptEmps } = await admin
      .from('employees')
      .select('id')
      .eq('department_id', await getMyDeptId(admin, viewer.id))
      .is('deleted_at', null)
    const ids = (deptEmps ?? []).map(e => e.id as string)
    query = query.or(`assignee_id.in.(${ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000'}),created_by.eq.${viewer.id}`)
  } else {
    // сотрудник — только свои
    query = query.eq('assignee_id', viewer.id)
  }

  const { data: rows } = await query
  const taskRows = rows ?? []

  // Имена исполнителей и постановщиков
  const empIds = Array.from(new Set(taskRows.flatMap(t => [t.assignee_id as string, t.created_by as string]).filter(Boolean)))
  const nameById = new Map<string, string>()
  if (empIds.length > 0) {
    const { data: emps } = await admin.from('employees').select('id, name').in('id', empIds)
    for (const e of emps ?? []) nameById.set(e.id as string, e.name as string)
  }

  return {
    role:      viewer.role,
    isManager: manager,
    myEmployeeId: viewer.id,
    tasks: taskRows.map(t => ({
      id:               t.id as string,
      title:            t.title as string,
      description:      t.description as string | null,
      assigned_to:      t.assignee_id as string,
      assignee_name:    nameById.get(t.assignee_id as string) ?? '—',
      created_by:       t.created_by as string,
      creator_name:     nameById.get(t.created_by as string) ?? null,
      deadline:         (t.due_date as string | null) ?? (t.created_at as string).slice(0, 10),
      status:           toTaskStatus(t.status as string, t.rejection_reason as string | null),
      completed_at:     t.completed_at as string | null,
      confirmed_at:     t.confirmed_at as string | null,
      confirmed_by:     t.confirmed_by as string | null,
      rejection_reason: t.rejection_reason as string | null,
      created_at:       t.created_at as string,
    })),
  }
}

async function getMyDeptId(admin: ReturnType<typeof createAdminClient>, employeeId: string): Promise<string> {
  const { data } = await admin.from('employees').select('department_id').eq('id', employeeId).maybeSingle()
  return (data?.department_id as string) ?? '00000000-0000-0000-0000-000000000000'
}

// ─── Сотрудники для назначения (владелец — все; руководитель — свой отдел) ────

export async function getAssignableEmployees(): Promise<AssignableEmployee[]> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return []
  if (!await can(actorFromViewer(viewer), 'tasks', 'create')) return []

  const admin = createAdminClient()
  let q = admin.from('employees').select('id, name, role').is('deleted_at', null).order('name')
  if (viewer.role !== 'owner') {
    // руководитель — только свой отдел
    q = q.eq('department_id', await getMyDeptId(admin, viewer.id))
  }
  const { data } = await q
  return (data ?? []).map(e => ({ id: e.id as string, name: e.name as string, role: e.role as string }))
}

// ─── Создание задачи ──────────────────────────────────────────────────────────

export async function createTask(input: {
  title: string
  description: string
  assigned_to: string
  deadline: string
}): Promise<ActionResult> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'tasks', 'create')) return { success: false, error: 'Недостаточно прав' }
  if (!input.title.trim()) return { success: false, error: 'Укажите название задачи' }
  if (!input.deadline) return { success: false, error: 'Укажите дедлайн' }
  if (!input.assigned_to) return { success: false, error: 'Выберите исполнителя' }

  const admin = createAdminClient()

  // Руководитель — только сотруднику своего отдела
  if (viewer.role !== 'owner') {
    const myDept = await getMyDeptId(admin, viewer.id)
    const { data: target } = await admin.from('employees').select('department_id').eq('id', input.assigned_to).is('deleted_at', null).maybeSingle()
    if (!target || target.department_id !== myDept) {
      return { success: false, error: 'Можно назначать только сотрудникам своего отдела' }
    }
  }

  const { error } = await admin.from('tasks').insert({
    company_id:  COMPANY_ID,
    title:       input.title.trim(),
    description: input.description.trim() || null,
    assignee_id:  input.assigned_to,
    created_by:  viewer.id,
    due_date:    input.deadline,
    status:      'todo',
  })
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Сотрудник отмечает «Выполнено» ───────────────────────────────────────────

export async function markTaskDone(taskId: string): Promise<ActionResult> {
  const viewer = await getViewer()
  if (!viewer) return { success: false, error: 'Нет сессии' }
  if (!await can(actorFromViewer(viewer), 'tasks', 'edit')) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: task } = await admin.from('tasks').select('assignee_id, status').eq('id', taskId).maybeSingle()
  if (!task) return { success: false, error: 'Задача не найдена' }
  if (task.assignee_id !== viewer.id) return { success: false, error: 'Это не ваша задача' }
  if (!['todo', 'in_progress'].includes(task.status as string)) {
    return { success: false, error: 'Задачу нельзя отметить в текущем статусе' }
  }

  const { error } = await admin
    .from('tasks')
    .update({ status: 'review', completed_at: new Date().toISOString(), rejection_reason: null })
    .eq('id', taskId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Руководитель/владелец подтверждает ───────────────────────────────────────

export async function confirmTask(taskId: string): Promise<ActionResult> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'tasks', 'edit')) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: task } = await admin.from('tasks').select('assignee_id, status, created_by').eq('id', taskId).maybeSingle()
  if (!task) return { success: false, error: 'Задача не найдена' }
  // Нельзя подтверждать задачу, где ты сам исполнитель
  if (task.assignee_id === viewer.id) return { success: false, error: 'Нельзя подтвердить собственную задачу' }
  if (task.status !== 'review') return { success: false, error: 'Подтверждать можно только отмеченные сотрудником задачи' }
  if (!(await canManage(admin, viewer, { assigned_to: task.assignee_id as string, created_by: task.created_by as string }))) return { success: false, error: 'Задача вне вашей зоны ответственности' }

  const { error } = await admin
    .from('tasks')
    .update({ status: 'done', confirmed_at: new Date().toISOString(), confirmed_by: viewer.id })
    .eq('id', taskId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Руководитель/владелец возвращает в работу (комментарий обязателен) ────────

export async function rejectTask(taskId: string, reason: string): Promise<ActionResult> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'tasks', 'edit')) return { success: false, error: 'Недостаточно прав' }
  if (!reason.trim()) return { success: false, error: 'Укажите причину возврата' }

  const admin = createAdminClient()
  const { data: task } = await admin.from('tasks').select('assignee_id, status, created_by').eq('id', taskId).maybeSingle()
  if (!task) return { success: false, error: 'Задача не найдена' }
  if (task.assignee_id === viewer.id) return { success: false, error: 'Нельзя обрабатывать собственную задачу' }
  if (task.status !== 'review') return { success: false, error: 'Вернуть можно только отмеченную сотрудником задачу' }
  if (!(await canManage(admin, viewer, { assigned_to: task.assignee_id as string, created_by: task.created_by as string }))) return { success: false, error: 'Задача вне вашей зоны ответственности' }

  const { error } = await admin
    .from('tasks')
    .update({ status: 'in_progress', rejection_reason: reason.trim(), completed_at: null })
    .eq('id', taskId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Проверка зоны ответственности руководителя ───────────────────────────────

async function canManage(
  admin: ReturnType<typeof createAdminClient>,
  viewer: { id: string; role: string },
  task: { assigned_to: string; created_by: string },
): Promise<boolean> {
  if (viewer.role === 'owner') return true
  if (task.created_by === viewer.id) return true
  const myDept = await getMyDeptId(admin, viewer.id)
  const { data: assignee } = await admin.from('employees').select('department_id').eq('id', task.assigned_to).maybeSingle()
  return assignee?.department_id === myDept
}
