'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getViewer, isManager } from '@/lib/decomposition/viewer'
import { can, getActor, getScope, inScope } from '@/lib/authz'
import { computeFunnelPlan } from './company-plan'
import { countWorkDays, NON_WORKING_STATUSES } from '@/lib/decomposition/schedule'

export type ActionResult = { success: true } | { success: false; error: string }

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface MyDailyRow {
  date:    string  // YYYY-MM-DD
  appeals: number | null
  leads:   number | null
  nv:      number | null
}

export interface MyDecompositionData {
  employee:   { id: string; name: string }
  viewerRole: 'lmai' | 'owner'
  plan: {
    id:         string
    date_start: string
    date_end:   string
  } | null
  /** Цели на период (реверсивный расчёт из company_plans) */
  targets: { appeals: number; leads: number; nv: number } | null
  /** Ориентиры конверсии из company_plans, % */
  convTargets: { appeal_lead: number; lead_nv: number } | null
  /** Факт по дням из daily_activity (только дни, где есть записи) */
  daily: MyDailyRow[]
  /** Оставшиеся рабочие дни сотрудника (график минус отсутствия) — для «нужно в день» */
  remainingWorkDays: number
  scheduleType: string
}

// ─── Роли с реализованной индивидуальной декомпозицией ────────────────────────

const INDIVIDUAL_ROLES = ['lmai', 'mp', 'targetolog']

// getViewer / isManager вынесены в общий серверный модуль
// (используются также в mp-decomposition.ts)

// ─── Доступ зрителя (для роутинга на объединённом экране) ─────────────────────

export interface DecompositionAccess {
  role: string
  isManager: boolean
  hasIndividual: boolean
}

export async function getDecompositionAccess(): Promise<DecompositionAccess | null> {
  const viewer = await getViewer()
  if (!viewer) return null
  return {
    role: viewer.role,
    isManager: isManager(viewer),
    hasIndividual: INDIVIDUAL_ROLES.includes(viewer.role),
  }
}

// ─── Список сотрудников для переключателя (owner / department_head) ───────────

export interface EmployeeOption {
  id: string
  name: string
  role: string
  role_label: string
  department_id: string | null
  hasIndividual: boolean
}

export interface DepartmentOption {
  id: string
  name: string
}

export async function getDepartmentsForDecomposition(): Promise<DepartmentOption[]> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return []
  const actor = await getActor()
  if (!actor) return []
  if (!await can(actor, 'decomposition', 'view')) return []
  const scope = await getScope(actor, 'decomposition')
  if (!scope) return []

  const admin = createAdminClient()
  const { data } = await admin
    .from('departments')
    .select('id, name')
    .eq('is_active', true)
    .order('name')
  const all = (data ?? []) as DepartmentOption[]
  // team → только свой отдел; all → все; own → пусто (руководитель не в списке «own»).
  if (scope === 'all') return all
  if (scope === 'team') return actor.departmentId ? all.filter(d => d.id === actor.departmentId) : []
  return []
}

export async function getEmployeesForDecomposition(): Promise<EmployeeOption[]> {
  const viewer = await getViewer()
  if (!viewer || !isManager(viewer)) return []
  const actor = await getActor()
  if (!actor) return []
  if (!await can(actor, 'decomposition', 'view')) return []
  const scope = await getScope(actor, 'decomposition')
  if (!scope) return []

  const admin = createAdminClient()
  const [{ data: emps }, { data: roleRows }] = await Promise.all([
    admin
      .from('employees')
      .select('id, name, role, department_id')
      .is('deleted_at', null)
      .neq('role', 'owner')
      .order('name'),
    admin.from('roles').select('name, label').is('deleted_at', null),
  ])

  const labels = new Map((roleRows ?? []).map(r => [r.name as string, r.label as string]))
  // Список ограничен охватом: team → только свой отдел, all → все, own → только себя.
  return (emps ?? [])
    .filter(e => inScope(actor, scope, e.id as string, (e.department_id as string | null) ?? null))
    .map(e => ({
      id:    e.id as string,
      name:  e.name as string,
      role:  e.role as string,
      role_label: labels.get(e.role as string) ?? (e.role as string),
      department_id: (e.department_id as string | null) ?? null,
      hasIndividual: INDIVIDUAL_ROLES.includes(e.role as string),
    }))
}

// ─── Определение целевого сотрудника ──────────────────────────────────────────
// lmai видит себя; owner/department_head — переданного сотрудника
// (или единственного ЛМ по умолчанию).

interface TargetEmployee {
  id: string
  name: string
  schedule_type: string
  anchor: string | null
}

const EMP_FIELDS = 'id, name, schedule_type, schedule_anchor_date, hire_date'
// Литеральная строка (не конкатенация) — иначе Supabase не выводит тип select.
const EMP_FIELDS_DEPT = 'id, name, schedule_type, schedule_anchor_date, hire_date, department_id'

function toTarget(row: Record<string, unknown> | null): TargetEmployee | null {
  if (!row) return null
  return {
    id:   row.id as string,
    name: row.name as string,
    schedule_type: (row.schedule_type as string) ?? '5/2',
    anchor: (row.schedule_anchor_date as string | null) ?? (row.hire_date as string | null),
  }
}

async function resolveTarget(targetEmployeeId?: string): Promise<{
  viewer: 'lmai' | 'owner' | null
  employee: TargetEmployee | null
}> {
  const me = await getViewer()
  if (!me) return { viewer: null, employee: null }
  const admin = createAdminClient()

  if (me.role === 'lmai') {
    // ЛМ всегда видит только себя (этот экран — только для лидогенерации)
    const { data } = await admin.from('employees').select(EMP_FIELDS).eq('id', me.id).is('deleted_at', null).maybeSingle()
    return { viewer: 'lmai', employee: toTarget(data) }
  }

  if (isManager(me)) {
    // Охват обязателен: department_head не должен открыть ЛМ чужого отдела, и цель
    // обязана быть именно лид-менеджером (роль этого экрана), а не произвольным UUID.
    const actor = await getActor()
    if (!actor) return { viewer: null, employee: null }
    const scope = await getScope(actor, 'decomposition')
    if (!scope) return { viewer: null, employee: null }

    if (targetEmployeeId) {
      const { data: emp } = await admin
        .from('employees')
        .select(EMP_FIELDS_DEPT)
        .eq('id', targetEmployeeId)
        .eq('role', 'lmai')
        .is('deleted_at', null)
        .maybeSingle()
      if (!emp || !inScope(actor, scope, emp.id as string, (emp.department_id as string | null) ?? null)) {
        return { viewer: 'owner', employee: null }  // вне охвата / не ЛМ → экран покажет подсказку
      }
      return { viewer: 'owner', employee: toTarget(emp) }
    }
    // Дефолтный ЛМ — первый В ОХВАТЕ (а не первый по компании).
    const { data: lms } = await admin
      .from('employees')
      .select(EMP_FIELDS_DEPT)
      .eq('role', 'lmai')
      .is('deleted_at', null)
      .order('created_at')
    const scoped = (lms ?? []).find(l => inScope(actor, scope, l.id as string, (l.department_id as string | null) ?? null))
    return { viewer: 'owner', employee: toTarget(scoped ?? null) }
  }

  return { viewer: null, employee: null }
}

// ─── Чтение данных экрана ─────────────────────────────────────────────────────

export async function getMyDecomposition(targetEmployeeId?: string): Promise<MyDecompositionData | null> {
  const viewer = await getViewer()
  if (!viewer) return null
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'decomposition', 'view')) return null

  // Охват целевого сотрудника обеспечивает resolveTarget (getScope + inScope + роль).
  const target = await resolveTarget(targetEmployeeId)
  if (!target.viewer) return null

  const admin = createAdminClient()

  // owner без ЛМ-сотрудника — валидное состояние: экран покажет подсказку
  const employee = target.employee ?? null

  // Активный план компании на сегодня
  const today = new Date().toISOString().slice(0, 10)
  const { data: plan } = await admin
    .from('company_plans')
    .select('id, date_start, date_end, target_revenue, avg_check, conv_appeal_lead, conv_lead_nv, conv_nv_fv, conv_fv_sale')
    .lte('date_start', today)
    .gte('date_end', today)
    .maybeSingle()

  let targets: { appeals: number; leads: number; nv: number } | null = null
  let convTargets: { appeal_lead: number; lead_nv: number } | null = null
  let daily: MyDailyRow[] = []
  let remainingWorkDays = 0

  if (plan) {
    const funnel = await computeFunnelPlan({
      target_revenue:   Number(plan.target_revenue),
      avg_check:        Number(plan.avg_check),
      conv_appeal_lead: Number(plan.conv_appeal_lead),
      conv_lead_nv:     Number(plan.conv_lead_nv),
      conv_nv_fv:       Number(plan.conv_nv_fv),
      conv_fv_sale:     Number(plan.conv_fv_sale),
    })
    targets = { appeals: funnel.appeals, leads: funnel.leads, nv: funnel.nv }
    convTargets = {
      appeal_lead: Number(plan.conv_appeal_lead),
      lead_nv:     Number(plan.conv_lead_nv),
    }

    if (employee) {
      const { data: rows } = await admin
        .from('daily_activity')
        .select('date, appeals_fact, leads_fact, nv_fact')
        .eq('employee_id', employee.id)
        .gte('date', plan.date_start as string)
        .lte('date', plan.date_end as string)
        .order('date')
      daily = (rows ?? []).map(r => ({
        date:    r.date as string,
        appeals: r.appeals_fact as number | null,
        leads:   r.leads_fact as number | null,
        nv:      r.nv_fact as number | null,
      }))

      // Оставшиеся рабочие дни — как на экране МП: график минус отсутствия,
      // плюс отработанные вне графика (подмены).
      const { data: attRows } = await admin
        .from('attendance')
        .select('date, status')
        .eq('employee_id', employee.id)
        .gte('date', today)
        .lte('date', plan.date_end as string)

      const absences = new Set(
        (attRows ?? [])
          .filter(r => (NON_WORKING_STATUSES as readonly string[]).includes(r.status as string))
          .map(r => r.date as string),
      )
      const extraDays = new Set(
        (attRows ?? [])
          .filter(r => r.status === 'worked' || r.status === 'remote')
          .map(r => r.date as string),
      )
      const from = today < (plan.date_start as string) ? (plan.date_start as string) : today
      remainingWorkDays = today > (plan.date_end as string)
        ? 0
        : countWorkDays(from, plan.date_end as string, employee.schedule_type, employee.anchor, absences, extraDays)
    }
  }

  return {
    employee:   employee ? { id: employee.id, name: employee.name } : { id: '', name: '' },
    viewerRole: target.viewer,
    plan: plan ? { id: plan.id as string, date_start: plan.date_start as string, date_end: plan.date_end as string } : null,
    targets,
    convTargets,
    daily,
    remainingWorkDays,
    scheduleType: employee?.schedule_type ?? '5/2',
  }
}

// ─── Сохранение дневного факта ────────────────────────────────────────────────

export async function saveMyDailyEntry(
  employeeId: string,
  date: string,
  appeals: number,
  leads: number,
  nv: number,
): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет сессии' }

  // Владелец/руководитель — за ЛМ в своём охвате; ЛМ — только за себя.
  const allowed = isManager(me) || (me.role === 'lmai' && me.id === employeeId)
  if (!allowed) return { success: false, error: 'Недостаточно прав' }

  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, 'decomposition', 'edit')) return { success: false, error: 'Недостаточно прав' }
  const scope = await getScope(actor, 'decomposition')
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  if (!date) return { success: false, error: 'Укажите дату' }
  if (appeals < 0 || leads < 0 || nv < 0) return { success: false, error: 'Значения не могут быть отрицательными' }

  const admin = createAdminClient()

  // Цель — активный лид-менеджер в охвате (pre-check; финальная проверка охвата и роли
  // атомарна с записью внутри RPC save_lmai_daily_entry, FOR UPDATE по цели).
  const { data: target } = await admin
    .from('employees')
    .select('id, department_id')
    .eq('id', employeeId)
    .eq('role', 'lmai')
    .is('deleted_at', null)
    .maybeSingle()
  if (!target) return { success: false, error: 'Сотрудник не найден или не является лид-менеджером' }
  if (!inScope(actor, scope, target.id as string, (target.department_id as string | null) ?? null)) {
    return { success: false, error: 'Сотрудник вне вашего охвата' }
  }

  // Пишет только appeals/leads/nv; fv/sales/revenue и walk_in_* не затрагиваются.
  const { error } = await admin.rpc('save_lmai_daily_entry', {
    p_employee_id:         employeeId,
    p_date:                date,
    p_appeals:             appeals,
    p_leads:               leads,
    p_nv:                  nv,
    p_actor_employee_id:   actor.employeeId,
    p_actor_scope:         scope,
    p_actor_department_id: actor.departmentId,
  })
  if (error) {
    console.error('[saveMyDailyEntry]', error.code, '|', error.message)
    const msg = error.message || ''
    if (msg.includes('scope_violation')) return { success: false, error: 'Сотрудник вне вашего охвата' }
    if (msg.includes('target_not_lmai')) return { success: false, error: 'Сотрудник не найден или не является лид-менеджером' }
    if (msg.includes('actor_inactive')) return { success: false, error: 'Недостаточно прав' }
    return { success: false, error: 'Не удалось сохранить' }
  }

  revalidatePath('/dashboard/decomposition')
  return { success: true }
}

// ─── Композитная загрузка страницы декомпозиции ───────────────────────────────
// ЗАЧЕМ. Next.js выполняет Server Action POST'ы от одного клиента ПО ОЧЕРЕДИ, поэтому
// Promise.all на клиенте не даёт параллелизма: три экшена = три последовательных
// round-trip'а по ~900 мс. Здесь они собираются в ОДИН запрос, внутри которого
// идентичность резолвится один раз (см. src/lib/identity.ts), а независимые выборки
// идут через Promise.all. Логика доступа не меняется — вызываются те же функции.
export interface DecompositionBootstrap {
  access: DecompositionAccess | null
  departments: DepartmentOption[]
  employees: EmployeeOption[]
}

export async function getDecompositionBootstrap(): Promise<DecompositionBootstrap> {
  const access = await getDecompositionAccess()

  // Справочники нужны только менеджеру — как и раньше на клиенте.
  if (!access?.isManager) {
    return { access, departments: [], employees: [] }
  }

  const [departments, employees] = await Promise.all([
    getDepartmentsForDecomposition(),
    getEmployeesForDecomposition(),
  ])

  return { access, departments, employees }
}
