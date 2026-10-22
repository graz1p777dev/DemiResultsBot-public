'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type {
  TaskStatus,
  TaskWithRelations,
  TaskEmployee,
  TaskViewer,
  TaskClient,
} from '@/types'
import { can, getScope } from '@/lib/authz'

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

// ─── Результат действия ──────────────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

// ─── Текущий сотрудник ───────────────────────────────────────────────────────

async function getViewer(): Promise<TaskViewer | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  const { data } = await supabase
    .from('employees')
    .select('id, role, department_id, name')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()

  return (data as TaskViewer | null) ?? null
}

// ─── Данные для доски ────────────────────────────────────────────────────────

export interface TasksData {
  tasks: TaskWithRelations[]
  employees: TaskEmployee[]
  departments: { id: string; name: string }[]
  clients: TaskClient[]
  me: TaskViewer | null
}

export async function getTasksData(): Promise<TasksData> {
  const me = await getViewer()
  if (!me) return { tasks: [], employees: [], departments: [], clients: [], me: null }

  const supabase = await createClient()
  const admin = createAdminClient()

  // tasks/task_members — через RLS-клиент: видимость применяется в БД.
  // employees/departments — через admin: имена нужны для пикеров и аватаров.
  const [{ data: tasks }, { data: members }] =
    await Promise.all([
      supabase
        .from('tasks')
        .select('*')
        .order('position', { ascending: true })
        .order('created_at', { ascending: false }),
      supabase.from('task_members').select('task_id, employee_id'),
    ])

  const membersByTask = new Map<string, string[]>()
  for (const m of (members ?? []) as { task_id: string; employee_id: string }[]) {
    const arr = membersByTask.get(m.task_id) ?? []
    arr.push(m.employee_id)
    membersByTask.set(m.task_id, arr)
  }

  const visibleTasks = (tasks ?? []) as Array<Omit<TaskWithRelations, 'members' | 'client_name'>>
  const employeeIds = Array.from(new Set([
    me.id,
    ...visibleTasks.flatMap((task) => [task.created_by, task.assignee_id, ...(membersByTask.get(task.id) ?? [])]),
  ].filter((id): id is string => Boolean(id))))
  const clientIds = Array.from(new Set(visibleTasks.map((task) => task.client_id).filter((id): id is string => Boolean(id))))

  const scope = await getScope({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks')
  let assigneeQuery = admin
    .from('employees')
    .select('id, name, role, department_id, avatar_url')
    .is('deleted_at', null)
    .order('name')
  if (scope === 'own') assigneeQuery = assigneeQuery.eq('id', me.id)
  if (scope === 'team') assigneeQuery = assigneeQuery.eq('department_id', me.department_id ?? '00000000-0000-0000-0000-000000000000')

  const [{ data: relatedEmployees }, { data: assignableEmployees }, { data: depts }, { data: clientRows }] = await Promise.all([
    employeeIds.length
      ? admin.from('employees').select('id, name, role, department_id, avatar_url').in('id', employeeIds).is('deleted_at', null)
      : Promise.resolve({ data: [] }),
    assigneeQuery,
    admin.from('departments').select('id, name').eq('is_active', true).order('name'),
    clientIds.length
      ? admin.from('crm_clients').select('id,first_name,last_name,phone').eq('company_id', COMPANY_ID).in('id', clientIds).is('deleted_at', null)
      : Promise.resolve({ data: [] }),
  ])

  const employeeById = new Map((relatedEmployees ?? []).map((employee) => [employee.id as string, employee]))
  for (const employee of assignableEmployees ?? []) employeeById.set(employee.id as string, employee)
  const clientNameById = new Map((clientRows ?? []).map((client) => {
    const name = [client.first_name, client.last_name].filter(Boolean).join(' ').trim() || client.phone || 'Клиент'
    return [client.id as string, name]
  }))
  const withRel: TaskWithRelations[] = visibleTasks.map((task) => ({
    ...task,
    members: membersByTask.get(task.id) ?? [],
    client_name: task.client_id ? clientNameById.get(task.client_id) ?? 'Клиент' : null,
  }))

  return {
    tasks: withRel,
    employees: Array.from(employeeById.values()) as TaskEmployee[],
    departments: (depts ?? []) as { id: string; name: string }[],
    clients: Array.from(clientNameById, ([id, name]) => ({ id, name })),
    me,
  }
}

// ─── Схема формы ─────────────────────────────────────────────────────────────

const TaskSchema = z.object({
  title: z.string().trim().min(1, 'Название обязательно').max(300, 'Слишком длинное название'),
  description: z.string().nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  visibility: z.enum(['all', 'department', 'private']).default('private'),
  assignee_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).default([]),
})

export type TaskFormData = z.input<typeof TaskSchema>

// ─── Создание ────────────────────────────────────────────────────────────────

export async function createTask(input: TaskFormData): Promise<ActionResult<{ id: string }>> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!await can({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks', 'create')) {
    return { success: false, error: 'Недостаточно прав' }
  }

  const parsed = TaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data
  const supabase = await createClient()
  if (!(await canAssignTask(me, d.assignee_id ?? null, d.member_ids))) {
    return { success: false, error: 'Нельзя назначить задачу выбранному сотруднику' }
  }

  // Позиция — в конец выбранной колонки.
  const { data: last } = await supabase
    .from('tasks')
    .select('position')
    .eq('status', d.status)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const position = ((last?.position as number | undefined) ?? -1) + 1

  const { data: created, error } = await supabase
    .from('tasks')
    .insert({
      title: d.title,
      description: d.description?.trim() || null,
      status: d.status,
      priority: d.priority,
      // Задачи в CRM личные: их видят только автор, исполнитель и owner.
      visibility: 'private',
      assignee_id: d.assignee_id ?? null,
      department_id: null,
      due_date: d.due_date || null,
      created_by: me.id,
      company_id: COMPANY_ID,
      position,
    })
    .select('id')
    .single()

  if (error || !created) return { success: false, error: error?.message ?? 'Не удалось создать задачу' }

  if (d.member_ids.length) {
    const uniqueMembers = Array.from(new Set(d.member_ids)).filter((employeeId) => employeeId !== me.id)
    if (uniqueMembers.length) {
      const { error: membersError } = await supabase.from('task_members').insert(
        uniqueMembers.map((employee_id) => ({ task_id: created.id, employee_id })),
      )
      if (membersError) return { success: false, error: 'Задача создана, но участников добавить не удалось' }
    }
  }

  revalidatePath('/dashboard/tasks')
  return { success: true, data: { id: created.id } }
}

// ─── Редактирование ──────────────────────────────────────────────────────────

export async function updateTask(id: string, input: TaskFormData): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!await can({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks', 'edit')) {
    return { success: false, error: 'Недостаточно прав' }
  }

  const parsed = TaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data
  const supabase = await createClient()
  if (!(await canAssignTask(me, d.assignee_id ?? null, d.member_ids))) {
    return { success: false, error: 'Нельзя назначить задачу выбранному сотруднику' }
  }

  const { data: existing } = await supabase
    .from('tasks')
    .select('created_by, visibility')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return { success: false, error: 'Задача не найдена или недоступна' }

  // Видимость и состав участников меняет только автор или owner.
  const canManage = me.role === 'owner' || existing.created_by === me.id
  const visibility = canManage ? 'private' : (existing.visibility as typeof d.visibility)

  const { data: updated, error } = await supabase
    .from('tasks')
    .update({
      title: d.title,
      description: d.description?.trim() || null,
      status: d.status,
      priority: d.priority,
      assignee_id: d.assignee_id ?? null,
      due_date: d.due_date || null,
      visibility,
      department_id: null,
    })
    .eq('id', id)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) return { success: false, error: 'Недостаточно прав' }

  if (canManage) {
    await supabase.from('task_members').delete().eq('task_id', id)
    const uniqueMembers = Array.from(new Set(d.member_ids)).filter((employeeId) => employeeId !== me.id)
    if (uniqueMembers.length) {
      const { error: membersError } = await supabase.from('task_members').insert(
        uniqueMembers.map((employee_id) => ({ task_id: id, employee_id })),
      )
      if (membersError) return { success: false, error: 'Задача сохранена, но участников добавить не удалось' }
    }
  }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Перемещение / переупорядочивание ────────────────────────────────────────

export async function moveTask(
  taskId: string,
  toStatus: TaskStatus,
  orderedIds: string[]
): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!await can({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks', 'edit')) {
    return { success: false, error: 'Недостаточно прав' }
  }

  const supabase = await createClient()

  const { data: moved, error } = await supabase
    .from('tasks')
    .update({ status: toStatus })
    .eq('id', taskId)
    .select('id')
  if (error) return { success: false, error: error.message }
  if (!moved || moved.length === 0) return { success: false, error: 'Недостаточно прав' }

  // Пересобираем позиции в целевой колонке.
  await Promise.all(
    orderedIds.map((id, idx) =>
      supabase.from('tasks').update({ position: idx }).eq('id', id)
    )
  )

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

// ─── Удаление ────────────────────────────────────────────────────────────────

export async function deleteTask(id: string): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!await can({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks', 'delete')) {
    return { success: false, error: 'Недостаточно прав' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.from('tasks').delete().eq('id', id).select('id')
  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) {
    return { success: false, error: 'Удалять задачу может только автор или владелец' }
  }

  revalidatePath('/dashboard/tasks')
  return { success: true }
}

async function canAssignTask(
  me: TaskViewer,
  assigneeId: string | null,
  memberIds: string[],
): Promise<boolean> {
  const scope = await getScope({ userId: '', employeeId: me.id, role: me.role, departmentId: me.department_id }, 'tasks')
  if (!scope) return false
  const targetIds = Array.from(new Set([assigneeId, ...memberIds].filter((id): id is string => Boolean(id))))
  if (!targetIds.length) return true
  if (scope === 'all') return true
  if (scope === 'own') return targetIds.every((id) => id === me.id)

  const { data } = await createAdminClient()
    .from('employees')
    .select('id')
    .in('id', targetIds)
    .eq('department_id', me.department_id ?? '00000000-0000-0000-0000-000000000000')
    .is('deleted_at', null)
  return (data ?? []).length === targetIds.length
}
