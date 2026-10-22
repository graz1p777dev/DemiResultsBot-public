'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor } from '@/lib/authz'

export type ActionResult = { success: true } | { success: false; error: string }

export interface DeptRow {
  id: string
  name: string
  description: string | null
  is_active: boolean
}

export interface RoleRow {
  id: string
  name: string
  label: string
  description: string | null
  is_system: boolean
  permission_level: string
}

export interface WorkScheduleRow {
  id: string
  name: string
  description: string | null
  is_system: boolean
  is_active: boolean
}

// ─── Auth guard ────────────────────────────────────────────────────────────────
// requireSession — для ЧТЕНИЯ (справочники используются вне Настроек: фильтры отделов
// на экранах декомпозиции и т.п.), любой активный сотрудник.
// requireOwnerActor — для МУТАЦИЙ (создание/изменение/удаление отделов/ролей/графиков).
// ЖЁСТКОЕ ПРАВИЛО: изменять настройки может ТОЛЬКО owner — хардкод, не через таблицу
// permissions (иначе можно было бы случайно/по ошибке открыть себе доступ к настройкам
// через панель прав). getUser() валидирует identity у Auth-сервера (не getSession()).

async function requireSession() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function requireOwnerActor(): Promise<boolean> {
  const actor = await getActor()
  return actor?.role === 'owner'
}

// ─── Departments ───────────────────────────────────────────────────────────────

export async function getDepartments(): Promise<DeptRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('departments')
    .select('id, name, description, is_active')
    .eq('is_active', true)
    .order('name')
  return (data ?? []) as DeptRow[]
}

export async function createDepartment(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.from('departments').insert({
    name: name.trim(),
    description: description.trim() || null,
    is_active: true,
  })
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateDepartment(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.from('departments').update({
    name: name.trim(),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteDepartment(id: string): Promise<ActionResult> {
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { count } = await admin.from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('department_id', id)
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: к этому отделу привязаны сотрудники (${count} чел.) — сначала переведите их в другой отдел` }
  }
  const { error } = await admin.from('departments').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Roles ─────────────────────────────────────────────────────────────────────

export async function getRoles(): Promise<RoleRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('roles')
    .select('id, name, label, description, is_system, permission_level')
    .is('deleted_at', null)
    .order('created_at')
  return (data ?? []) as RoleRow[]
}

// ВНИМАНИЕ: старый createRole (создавал роль БЕЗ permissions → «дыра» неполной роли)
// удалён. Единственный путь создания роли — createRoleWithPermissions (access-control.ts,
// атомарная RPC create_role_with_permissions: роль + ровно 16 прав или откат).

export async function updateRole(
  id: string,
  label: string,
  description: string,
  permissionLevel?: 'employee' | 'department_head',
): Promise<ActionResult> {
  if (!label.trim()) return { success: false, error: 'Название роли обязательно' }
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data: role } = await admin.from('roles').select('is_system, name').eq('id', id).single()
  // После миграции 044 системная роль ровно одна — owner. Держим и явную проверку по имени:
  // is_system может быть сбит, а owner защищать нужно всегда (на нём висит весь RBAC).
  const locked = role?.is_system === true || role?.name === 'owner'
  const updates: Record<string, unknown> = {
    // Заблокированные роли: label не меняем — он идентифицирует роль в UI, изменение сломает ориентацию
    ...(locked ? {} : { label: label.trim() }),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }
  if (!locked && permissionLevel) updates.permission_level = permissionLevel
  const { error } = await admin.from('roles').update(updates).eq('id', id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

/** Русские формы числительного для сообщений об отказе: 1 запись / 2 записи / 5 записей. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  switch (n % 10) {
    case 1:  return one
    case 2:
    case 3:
    case 4:  return few
    default: return many
  }
}

export async function deleteRole(id: string): Promise<ActionResult> {
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data: role } = await admin.from('roles').select('is_system, name').eq('id', id).single()
  // owner — единственная неприкосновенная роль (миграция 044): на ней держится весь RBAC.
  // Проверяем и по имени, и по флагу — БД дополнительно страхует триггером protect_owner_role().
  if (role?.name === 'owner') return { success: false, error: 'Роль «Владелец» защищена — её нельзя удалить' }
  if (role?.is_system) return { success: false, error: 'Системные роли нельзя удалять' }
  if (!role?.name) return { success: false, error: 'Роль не найдена' }

  // Зависимости роли. Настоящая гарантия — внешние ключи с ON DELETE RESTRICT
  // (миграция 047): проверка и удаление происходят атомарно внутри БД, поэтому
  // гонку «создать сотрудника между проверкой и DELETE» выиграть нельзя.
  // Эти же проверки в коде оставлены РАДИ ПОНЯТНЫХ СООБЩЕНИЙ — они говорят, что
  // именно мешает, вместо сырой ошибки 23503.
  // Считаем и архивных: их можно восстановить, и восстановленный сотрудник
  // получил бы битую роль (getPermissionRow() не найдёт её и запретит всё).
  const [empRes, kpiRes] = await Promise.all([
    admin.from('employees').select('id', { count: 'exact', head: true }).eq('role', role.name),
    admin.from('kpi_role_settings').select('id', { count: 'exact', head: true }).eq('role_name', role.name),
  ])

  // FAIL-CLOSED: если проверку зависимостей выполнить не удалось, удалять нельзя.
  // Раньше `?? 0` превращал ошибку запроса в «зависимостей нет», и DELETE шёл дальше.
  if (empRes.error || kpiRes.error) {
    console.error('[deleteRole:deps]', empRes.error?.message ?? '', kpiRes.error?.message ?? '')
    return { success: false, error: 'Не удалось проверить связи роли — удаление отменено. Повторите позже' }
  }

  const empCount = empRes.count ?? 0
  const kpiCount = kpiRes.count ?? 0

  if (empCount > 0) {
    // Разделяем активных и архивных — владельцу нужно понимать, где искать.
    const { count: activeCount, error: activeError } = await admin.from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('role', role.name)
      .is('deleted_at', null)
    if (activeError) {
      console.error('[deleteRole:active]', activeError.message)
      return { success: false, error: 'Не удалось проверить связи роли — удаление отменено. Повторите позже' }
    }
    const active   = activeCount ?? 0
    const archived = empCount - active
    const parts = [
      active   > 0 ? `${active} ${plural(active, 'активный', 'активных', 'активных')}` : null,
      archived > 0 ? `${archived} в архиве` : null,
    ].filter(Boolean).join(', ')
    return {
      success: false,
      error: `Нельзя удалить: к роли привязаны сотрудники (${parts}) — сначала переведите их на другую роль`,
    }
  }

  if (kpiCount > 0) {
    return {
      success: false,
      error: `Нельзя удалить: на роль настроены KPI (${kpiCount} ${plural(kpiCount, 'запись', 'записи', 'записей')}) — сначала удалите настройки KPI этой роли`,
    }
  }

  const { error } = await admin.from('roles').delete().eq('id', id).eq('is_system', false)
  if (error) {
    console.error('[deleteRole]', error.code, '|', error.message)
    // 23503 — нарушение внешнего ключа (миграция 047). Сюда попадаем, если ссылка
    // появилась уже после проверок выше (гонка) — то есть ровно тот случай, ради
    // которого FK и добавлены. Пользователю нужен смысл, а не код ошибки.
    if (error.code === '23503') {
      return {
        success: false,
        error: 'Нельзя удалить: на роль только что появились ссылки (сотрудник или настройки KPI). Обновите страницу и проверьте связи',
      }
    }
    return { success: false, error: 'Не удалось удалить роль' }
  }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Work Schedules ────────────────────────────────────────────────────────────

export async function getWorkSchedules(): Promise<WorkScheduleRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('work_schedules')
    .select('id, name, description, is_system, is_active')
    .eq('is_active', true)
    .order('created_at')
  return (data ?? []) as WorkScheduleRow[]
}

export async function createWorkSchedule(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.from('work_schedules').insert({
    name: name.trim(),
    description: description.trim() || null,
    is_system: false,
    is_active: true,
  })
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateWorkSchedule(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { error } = await admin.from('work_schedules').update({
    name: name.trim(),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteWorkSchedule(id: string): Promise<ActionResult> {
  if (!await requireOwnerActor()) return { success: false, error: 'Недостаточно прав' }
  const admin = createAdminClient()
  const { data: ws } = await admin.from('work_schedules').select('is_system, name').eq('id', id).single()
  if (ws?.is_system) return { success: false, error: 'Системные графики нельзя удалять' }
  const { count } = await admin.from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('schedule_type', ws?.name ?? '')
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: этот график используют ${count} сотр. — сначала измените им график` }
  }
  const { error } = await admin.from('work_schedules').delete().eq('id', id).eq('is_system', false)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}
