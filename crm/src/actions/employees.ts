'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { validatePassword } from '@/lib/auth-validation'
import { getActor, can, getScope, inScope } from '@/lib/authz'
import type { Employee, Department } from '@/types'

// ─── getEmployees (admin — обходит RLS, содержит оклады) ──────────────────────
// P0: раньше отдавал select('*') (с base_salary!) ЛЮБОМУ залогиненному.
// Теперь: право employees.view + фильтр строк по scope (own/team/all) + минимизация
// полей (зарплатные/персональные — только при праве salaries.view) + includeArchived
// только при наличии этого права.

export async function getEmployees(includeArchived: boolean): Promise<{
  employees: Employee[]
  departments: Pick<Department, 'id' | 'name'>[]
  roles: { value: string; label: string }[]
  schedules: { value: string; label: string }[]
}> {
  const actor = await getActor()
  const empty = { employees: [], departments: [], roles: [], schedules: [] }
  if (!actor || !await can(actor, 'employees', 'view')) return empty

  const scope = await getScope(actor, 'employees')
  if (!scope) return empty
  const salaryScope = await getScope(actor, 'salaries')
  const canSeeSalary = salaryScope !== null

  const admin = createAdminClient()

  // Минимизация полей: базовый набор всем с employees.view; зарплатные — только с salaries.view.
  const baseCols = 'id,name,email,role,status,hire_date,schedule_type,work_start_time,work_end_time,attendance_tracked,deleted_at,department_id'
  const cols = canSeeSalary
    ? `${baseCols},base_salary,kpi_coefficient,phone,birth_date,notes`
    : baseCols

  let query = admin.from('employees').select(cols).order('name')
  // includeArchived только при праве (архив — чувствительнее); иначе форсим активных.
  if (!includeArchived || !canSeeSalary) query = query.is('deleted_at', null)

  // Фильтр строк по scope: own → только сам; team → свой отдел; all → все.
  if (scope === 'own') {
    query = query.eq('id', actor.employeeId)
  } else if (scope === 'team') {
    query = actor.departmentId
      ? query.eq('department_id', actor.departmentId)
      : query.eq('id', actor.employeeId)
  }

  const [{ data: emps }, { data: depts }, { data: roleRows }, { data: scheduleRows }] = await Promise.all([
    query,
    admin.from('departments').select('id, name').eq('is_active', true).order('name'),
    admin.from('roles').select('name, label').is('deleted_at', null).order('created_at'),
    admin.from('work_schedules').select('name, description').eq('is_active', true).order('created_at'),
  ])

  return {
    employees: ((emps as unknown as Employee[]) ?? []).map(employee => {
      if (salaryScope && inScope(actor, salaryScope, employee.id, employee.department_id)) return employee
      const publicFields: Partial<Employee> = { ...employee }
      for (const field of ['base_salary', 'kpi_coefficient', 'phone', 'birth_date', 'notes'] as const) delete publicFields[field]
      return publicFields as Employee
    }),
    departments: (depts as Pick<Department, 'id' | 'name'>[]) ?? [],
    roles: ((roleRows ?? []) as { name: string; label: string }[]).map(r => ({ value: r.name, label: r.label })),
    schedules: ((scheduleRows ?? []) as { name: string; description: string | null }[]).map(s => ({
      value: s.name,
      label: s.description ? `${s.name} — ${s.description}` : s.name,
    })),
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const EmployeeSchema = z.object({
  name:             z.string().min(2, 'Имя обязательно (мин. 2 символа)'),
  email:            z.string().email('Некорректный email'),
  phone:            z.string().nullable().optional(),
  role:             z.string().min(1, 'Роль обязательна'),
  department_id:    z.string().uuid().nullable().optional(),
  hire_date:        z.string().nullable().optional(),
  birth_date:       z.string().nullable().optional(),
  base_salary:      z.number().min(0).default(0),
  kpi_coefficient:  z.number().min(0).default(1.0).optional(),
  schedule_type:    z.string().min(1).default('5/2'),
  // Умолчание 10:00–21:00 — базовая смена менеджера (решение владельца).
  // Остальным время задаётся вручную на карточке.
  work_start_time:  z.string().default('10:00'),
  work_end_time:    z.string().default('21:00'),
  // Учёт посещаемости включается ЯВНО и не выводится из роли. Пока выключен —
  // сотрудник не попадает ни в отчёт, ни в автопрогулы, ни в отметку прихода.
  attendance_tracked: z.boolean().default(false),
  status:           z.enum(['active', 'probation', 'archived']).default('active'),
  notes:            z.string().nullable().optional(),
  // Пароль нужен только при создании — при обновлении передаётся как пустая строка
  initial_password: z.string().optional(),
})

export type EmployeeFormData = z.infer<typeof EmployeeSchema>
export type ActionResult = { success: true } | { success: false; error: string }

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function requireOwner(): Promise<boolean> {
  const actor = await getActor()
  return actor?.role === 'owner'
}

// ─── createEmployee ───────────────────────────────────────────────────────────

export async function createEmployee(data: EmployeeFormData): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  // Валидация пароля — обязателен при создании
  const password = parsed.data.initial_password ?? ''
  if (!password) return { success: false, error: 'Задайте начальный пароль для сотрудника' }
  const pwErr = validatePassword(password)
  if (pwErr) return { success: false, error: pwErr }

  const admin = createAdminClient()

  // Проверяем уникальность email в employees
  const normalizedEmail = parsed.data.email.trim().toLowerCase()
  const { data: existing } = await admin
    .from('employees')
    .select('id')
    .ilike('email', normalizedEmail)
    .maybeSingle()
  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  // 1. Создаём auth.users через service role (email сразу подтверждён)
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email:         parsed.data.email,
    password,
    email_confirm: true,
  })

  if (authErr || !authUser?.user) {
    console.error('[createEmployee] auth.admin.createUser:', authErr?.message)
    if (authErr?.message?.includes('already been registered')) {
      return { success: false, error: 'Пользователь с таким email уже существует в системе' }
    }
    return { success: false, error: 'Ошибка создания аккаунта' }
  }

  // 2. Создаём запись в employees с привязанным user_id
  const payload = {
    user_id:         authUser.user.id,
    name:            parsed.data.name,
    email:           parsed.data.email,
    phone:           parsed.data.phone ?? null,
    role:            parsed.data.role,
    department_id:   parsed.data.department_id ?? null,
    hire_date:       parsed.data.hire_date ?? null,
    birth_date:      parsed.data.birth_date ?? null,
    base_salary:     parsed.data.base_salary,
    kpi_coefficient: parsed.data.kpi_coefficient,
    schedule_type:   parsed.data.schedule_type,
    work_start_time: parsed.data.work_start_time,
    work_end_time:   parsed.data.work_end_time,
    attendance_tracked: parsed.data.attendance_tracked,
    status:          parsed.data.status,
    notes:           parsed.data.notes ?? null,
  }

  const { error: empErr } = await admin.from('employees').insert(payload)
  if (empErr) {
    console.error('[createEmployee] insert:', empErr.code, empErr.message)
    // Откат: удаляем auth-пользователя чтобы не было orphan
    await admin.auth.admin.deleteUser(authUser.user.id)
    if (empErr.code === '23505') return { success: false, error: 'Email уже занят' }
    return { success: false, error: 'Ошибка создания сотрудника' }
  }

  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── updateEmployee ───────────────────────────────────────────────────────────

export async function updateEmployee(id: string, data: EmployeeFormData): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const admin = createAdminClient()

  const { data: currentEmployee } = await admin
    .from('employees')
    .select('user_id, email')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (!currentEmployee) return { success: false, error: 'Сотрудник не найден' }

  // Проверяем уникальность email (кроме текущего)
  const normalizedEmail = parsed.data.email.trim().toLowerCase()
  const { data: existing } = await admin
    .from('employees')
    .select('id')
    .ilike('email', normalizedEmail)
    .neq('id', id)
    .maybeSingle()

  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  const payload = {
    name:            parsed.data.name,
    email:           parsed.data.email,
    phone:           parsed.data.phone ?? null,
    role:            parsed.data.role,
    department_id:   parsed.data.department_id ?? null,
    hire_date:       parsed.data.hire_date ?? null,
    birth_date:      parsed.data.birth_date ?? null,
    base_salary:     parsed.data.base_salary,
    kpi_coefficient: parsed.data.kpi_coefficient,
    schedule_type:   parsed.data.schedule_type,
    work_start_time: parsed.data.work_start_time,
    work_end_time:   parsed.data.work_end_time,
    attendance_tracked: parsed.data.attendance_tracked,
    status:          parsed.data.status,
    notes:           parsed.data.notes ?? null,
  }

  const { error } = await admin
    .from('employees')
    .update(payload)
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    console.error('[updateEmployee]', error.code, error.message)
    return { success: false, error: 'Ошибка обновления сотрудника' }
  }

  // Email для входа хранится также в Supabase Auth — синхронизируем его с
  // карточкой сотрудника, иначе после смены email вход по новой почте невозможен.
  if (currentEmployee.user_id && currentEmployee.email?.toLowerCase() !== normalizedEmail) {
    const { error: authError } = await admin.auth.admin.updateUserById(currentEmployee.user_id, {
      email: normalizedEmail,
      email_confirm: true,
    })
    if (authError) return { success: false, error: 'Email в авторизации не удалось обновить' }
  }

  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function resetEmployeePassword(id: string, password: string, confirmation: string): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }
  if (password !== confirmation) return { success: false, error: 'Пароли не совпадают' }
  const pwErr = validatePassword(password)
  if (pwErr) return { success: false, error: pwErr }
  const admin = createAdminClient()
  const { data: employee } = await admin.from('employees').select('user_id').eq('id', id).is('deleted_at', null).single()
  if (!employee?.user_id) return { success: false, error: 'У сотрудника нет аккаунта для сброса' }
  const { error } = await admin.auth.admin.updateUserById(employee.user_id, { password })
  if (error) return { success: false, error: 'Не удалось сбросить пароль' }
  await admin.from('employees').update({ must_change_password: true }).eq('id', id)
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── archiveEmployee (soft delete) ───────────────────────────────────────────

export async function archiveEmployee(id: string, reason?: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor || actor.role !== 'owner') return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()

  // Архивирование и запись в аудит — одной транзакцией (RPC dismiss_employee,
  // миграция 046). Раньше это были два отдельных запроса: при сбое лога увольнение
  // всё равно проходило, и след терялся.
  // RPC возвращает false, если сотрудника нет или он уже уволен — тогда мы НЕ
  // рапортуем ложный «успех» (прежний .update().is('deleted_at', null) молча
  // затрагивал 0 строк и возвращал success).
  const { data, error } = await admin.rpc('dismiss_employee', {
    p_employee_id: id,
    p_actor_id:    actor.employeeId,
    p_reason:      reason ?? null,
  })

  if (error) {
    console.error('[archiveEmployee]', error.code, '|', error.message)
    return { success: false, error: 'Ошибка увольнения сотрудника' }
  }
  if (data !== true) {
    return { success: false, error: 'Сотрудник не найден или уже уволен' }
  }

  // Отзыв доступа: блокируем Auth-пользователя. RLS-хелперы после 057 уже отдают NULL для
  // архивированного (прямой Data API закрыт немедленно, ещё до истечения access-токена);
  // бан дополнительно не даёт ОБНОВИТЬ сессию. Сбой бана не откатывает увольнение (оно
  // атомарно закоммичено в dismiss_employee) — только логируем.
  const { data: emp } = await admin.from('employees').select('user_id').eq('id', id).maybeSingle()
  if (emp?.user_id) {
    const { error: banErr } = await admin.auth.admin.updateUserById(emp.user_id as string, { ban_duration: '876000h' })
    if (banErr) console.error('[archiveEmployee] ban:', banErr.message)
  }

  revalidatePath('/dashboard/employees')
  revalidatePath(`/dashboard/employees/${id}`)
  return { success: true }
}

// ─── restoreEmployee ──────────────────────────────────────────────────────────

export async function restoreEmployee(id: string): Promise<{ success: true; warning?: string } | { success: false; error: string }> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: emp } = await admin.from('employees').select('user_id').eq('id', id).maybeSingle()
  // Причину увольнения снимаем: сотрудник снова активен, прошлая причина
  // ввела бы в заблуждение в его карточке.
  const { error } = await admin
    .from('employees')
    .update({ deleted_at: null, status: 'active', dismissal_reason: null })
    .eq('id', id)
    .not('deleted_at', 'is', null)

  if (error) {
    console.error('[restoreEmployee]', error.code, error.message)
    return { success: false, error: 'Ошибка восстановления сотрудника' }
  }

  // Разблокировать Auth-пользователя (симметрично archiveEmployee) — сотрудник снова
  // может входить. Строка сотрудника уже восстановлена; провал разбана НЕ откатываем, но и
  // не молчим (иначе владелец решит, что вход открыт, а он заблокирован): retry × 1, затем
  // возвращаем success С ПРЕДУПРЕЖДЕНИЕМ, чтобы владелец разблокировал вручную.
  if (emp?.user_id) {
    const uid = emp.user_id as string
    let { error: unbanErr } = await admin.auth.admin.updateUserById(uid, { ban_duration: 'none' })
    if (unbanErr) {
      ;({ error: unbanErr } = await admin.auth.admin.updateUserById(uid, { ban_duration: 'none' }))
    }
    if (unbanErr) {
      console.error('[restoreEmployee] unban failed after retry:', unbanErr.message)
      revalidatePath('/dashboard/employees')
      return {
        success: true,
        warning: 'Сотрудник восстановлен, но авто-разблокировка входа не удалась. ' +
                 'Разблокируйте аккаунт вручную в Supabase Auth, иначе вход останется закрыт.',
      }
    }
  }

  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── upsertEmployeeKpi ────────────────────────────────────────────────────────

export interface KpiPlanFormData {
  plan_fv:        number | null
  plan_sales:     number | null
  plan_revenue:   number | null
  plan_appeals:   number | null
  plan_leads:     number | null
  plan_nv:        number | null
  plan_work_days: number | null
}

export async function upsertEmployeeKpi(
  employeeId: string,
  year: number,
  month: number,
  data: KpiPlanFormData,
): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()

  const { error: upsertErr } = await admin
    .from('employee_kpi')
    .upsert(
      {
        employee_id:   employeeId,
        period_year:   year,
        period_month:  month,
        plan_fv:       data.plan_fv,
        plan_sales:    data.plan_sales,
        plan_revenue:  data.plan_revenue,
        plan_appeals:  data.plan_appeals,
        plan_leads:    data.plan_leads,
        plan_nv:       data.plan_nv,
        plan_work_days:data.plan_work_days,
        created_by:    null,
      },
      { onConflict: 'employee_id,period_year,period_month' }
    )

  if (upsertErr) {
    console.error('[upsertEmployeeKpi]', upsertErr.message)
    return { success: false, error: 'Ошибка сохранения KPI-планов' }
  }

  // Пересчитываем sales_plan_weekly чтобы kpi_pct обновился сразу
  const { error: rpcErr } = await admin.rpc('recalculate_decomposition', {
    p_employee_id: employeeId,
    p_year:        year,
    p_month:       month,
  })
  if (rpcErr) {
    console.error('[upsertEmployeeKpi] recalculate_decomposition failed:', rpcErr.message)
  }

  // Инвалидируем кэш — следующий getEmployeesData получит свежие данные
  const { globalCache } = await import('@/lib/data/cache/MemoryCache')
  globalCache.invalidate(`employees:${year}:${month - 1}`)
  globalCache.invalidate(`employees:${year}:${month}`)

  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── getEmployeeKpiPlan ───────────────────────────────────────────────────────

export async function getEmployeeKpiPlan(
  employeeId: string,
  year: number,
  month: number,
): Promise<KpiPlanFormData | null> {
  if (!await requireOwner()) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('employee_kpi')
    .select('plan_fv,plan_sales,plan_revenue,plan_appeals,plan_leads,plan_nv,plan_work_days')
    .eq('employee_id', employeeId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()

  if (!data) return null
  return data as KpiPlanFormData
}
