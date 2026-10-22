'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getViewer } from '@/lib/decomposition/viewer'
import { can, getScope, actorFromViewer } from '@/lib/authz'
import { businessToday } from '@/lib/business-date'

export type ActionResult = { success: true } | { success: false; error: string }

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface SalaryAdvance {
  id:      string
  date:    string
  amount:  number
  by_name: string | null
  notes:   string | null
}

export interface SalaryKpiItem {
  id:           string
  name:         string
  bonus_amount: number
  is_completed: boolean
}

export interface SalaryRow {
  employee_id: string
  name:        string
  role:        string
  role_label:  string
  // Оклад
  salary_type:    'fixed' | 'per_shift'
  salary_amount:  number   // фикс. сумма ИЛИ ставка за выход
  worked_days:    number   // для per_shift
  salary_calc:    number   // рассчитанный оклад
  // % плана и бонусы (из employee_kpi_results)
  has_decomposition: boolean
  plan_pct:    number | null
  plan_bonus:  number
  items_bonus: number
  daily_bonus: number
  is_closed:   boolean
  // Детали
  kpi_items: SalaryKpiItem[]
  advances:  SalaryAdvance[]
}

export interface SalarySheet {
  rows:        SalaryRow[]
  monthClosed: boolean
  closedAt:    string | null
  closedByName: string | null
  viewerRole:  string
  ownOnly:     boolean   // true — выдача урезана до собственной строки сотрудника
}

// Роли, для которых реализована индивидуальная декомпозиция (источник % плана)
const DECOMPOSITION_ROLES = ['mp']

// Полный доступ к ведомости (все сотрудники) — владелец/бухгалтер. Мутации (аванс,
// закрытие месяца, KPI) гейтятся отдельно через can(...,'salaries','edit').
async function requireSalaryAccess(): Promise<{ id: string; role: string } | null> {
  const viewer = await getViewer()
  if (!viewer) return null
  if (viewer.role !== 'owner' && viewer.role !== 'accountant') return null
  return { id: viewer.id, role: viewer.role }
}

// ─── Ведомость за месяц ───────────────────────────────────────────────────────

export async function getSalarySheet(year: number, month: number): Promise<SalarySheet | null> {
  const viewer = await getViewer()
  if (!viewer) return null
  const actor = actorFromViewer(viewer)
  if (!await can(actor, 'salaries', 'view')) return null
  const scope = await getScope(actor, 'salaries')
  if (!scope) return null
  // Полная ведомость требует и управляющей роли, и scope='all'.
  const ownOnly = scope !== 'all' || (viewer.role !== 'owner' && viewer.role !== 'accountant')

  const admin = createAdminClient()

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEndD  = new Date(year, month, 0)
  const monthEnd   = `${year}-${String(month).padStart(2, '0')}-${String(monthEndD.getDate()).padStart(2, '0')}`

  let employeeQuery = admin
    .from('employees')
    .select('id, name, role, schedule_type, schedule_anchor_date, hire_date')
    .is('deleted_at', null)
    .neq('role', 'owner')
    .order('name')
  if (ownOnly) employeeQuery = employeeQuery.eq('id', viewer.id)

  const [{ data: emps }, { data: roleRows }, { data: roleSettings }] = await Promise.all([
    employeeQuery,
    admin.from('roles').select('name, label').is('deleted_at', null),
    admin.from('kpi_role_settings').select('role_name, salary_type, salary_amount, rate_per_shift'),
  ])

  const roleLabels   = new Map((roleRows ?? []).map(r => [r.name as string, r.label as string]))
  const settingsByRole = new Map((roleSettings ?? []).map(r => [r.role_name as string, r]))
  const employees = emps ?? []
  const empIds = employees.map(e => e.id as string)

  // Актуализируем расчёт бонусов для открытых строк (закрытые функция не тронет)
  for (const e of employees) {
    await admin.rpc('recalculate_kpi_results', {
      p_employee_id: e.id,
      p_year:        year,
      p_month:       month,
    })
  }

  const [{ data: results }, { data: itemRows }, { data: itemResults }, { data: advRows }, { data: attRows }] = await Promise.all([
    admin
      .from('employee_kpi_results')
      .select('employee_id, plan_completion_pct, plan_bonus, items_bonus, daily_bonus, is_closed, closed_at, closed_by')
      .eq('period_year', year)
      .eq('period_month', month)
      .in('employee_id', empIds),
    admin
      .from('kpi_items')
      .select('id, name, bonus_amount, role_setting_id, sort_order, is_active, kpi_role_settings(role_name)')
      .eq('is_active', true)
      .order('sort_order'),
    admin
      .from('employee_kpi_item_results')
      .select('employee_id, kpi_item_id, is_completed')
      .eq('period_year', year)
      .eq('period_month', month)
      .in('employee_id', empIds),
    admin
      .from('advance_payments')
      .select('id, employee_id, amount, date, notes, created_by')
      .gte('date', monthStart)
      .lte('date', monthEnd)
      .in('employee_id', empIds)
      .order('date'),
    admin
      .from('attendance')
      .select('employee_id, date, status')
      .gte('date', monthStart)
      .lte('date', monthEnd)
      .in('employee_id', empIds),
  ])

  const resultsByEmp = new Map((results ?? []).map(r => [r.employee_id as string, r]))
  const itemResultsByEmp = new Map<string, Map<string, boolean>>()
  for (const ir of itemResults ?? []) {
    const empId = ir.employee_id as string
    if (!itemResultsByEmp.has(empId)) itemResultsByEmp.set(empId, new Map())
    itemResultsByEmp.get(empId)!.set(ir.kpi_item_id as string, ir.is_completed as boolean)
  }

  // Имена выдавших авансы
  const byIds = Array.from(new Set((advRows ?? []).map(a => a.created_by as string | null).filter(Boolean))) as string[]
  const byNames = new Map<string, string>()
  if (byIds.length > 0) {
    const { data: byEmps } = await admin.from('employees').select('id, name').in('id', byIds)
    for (const b of byEmps ?? []) byNames.set(b.id as string, b.name as string)
  }

  const rows: SalaryRow[] = employees.map(e => {
    const role = e.role as string
    const setting = settingsByRole.get(role)
    const salaryType = ((setting?.salary_type as string) ?? 'fixed') as 'fixed' | 'per_shift'
    const salaryAmount = salaryType === 'fixed'
      ? Number(setting?.salary_amount ?? 0)
      : Number(setting?.rate_per_shift ?? 0)

    // Отработанные дни для сдельного оклада — строго по факту из attendance:
    // status 'worked'/'remote'. Дни подмены хранятся как 'worked'
    // (+ covering_for_employee_id), поэтому засчитываются вошедшему автоматически.
    // Заменяемый строки не имеет — его день не оплачивается. Fallback на график
    // убран (правило: платим только за фактические выходы).
    const empAtt = (attRows ?? []).filter(a => a.employee_id === e.id)
    const workedDays = empAtt.filter(a => a.status === 'worked' || a.status === 'remote').length

    const salaryCalc = salaryType === 'fixed' ? salaryAmount : salaryAmount * workedDays

    const res = resultsByEmp.get(e.id as string)
    const hasDecomposition = DECOMPOSITION_ROLES.includes(role)

    const empItemMap = itemResultsByEmp.get(e.id as string)
    const kpiItems: SalaryKpiItem[] = (itemRows ?? [])
      .filter(it => {
        const rel = it.kpi_role_settings as unknown as { role_name: string } | null
        return rel?.role_name === role
      })
      .map(it => ({
        id:           it.id as string,
        name:         it.name as string,
        bonus_amount: Number(it.bonus_amount),
        is_completed: empItemMap?.get(it.id as string) ?? false,
      }))

    const advances: SalaryAdvance[] = (advRows ?? [])
      .filter(a => a.employee_id === e.id)
      .map(a => ({
        id:      a.id as string,
        date:    a.date as string,
        amount:  Number(a.amount),
        by_name: a.created_by ? (byNames.get(a.created_by as string) ?? null) : null,
        notes:   a.notes as string | null,
      }))

    return {
      employee_id: e.id as string,
      name:        e.name as string,
      role,
      role_label:  roleLabels.get(role) ?? role,
      salary_type:   salaryType,
      salary_amount: salaryAmount,
      worked_days:   workedDays,
      salary_calc:   salaryCalc,
      has_decomposition: hasDecomposition,
      plan_pct:    hasDecomposition ? Number(res?.plan_completion_pct ?? 0) : null,
      plan_bonus:  Number(res?.plan_bonus ?? 0),
      items_bonus: Number(res?.items_bonus ?? 0),
      daily_bonus: Number(res?.daily_bonus ?? 0),
      is_closed:   (res?.is_closed as boolean) ?? false,
      kpi_items:   kpiItems,
      advances,
    }
  })

  // Месяц закрыт = есть строки результатов и все закрыты
  const resRows = results ?? []
  const monthClosed = resRows.length > 0 && resRows.every(r => r.is_closed)
  const firstClosed = resRows.find(r => r.is_closed)
  let closedByName: string | null = null
  if (firstClosed?.closed_by) {
    const { data: closer } = await admin.from('employees').select('name').eq('id', firstClosed.closed_by as string).maybeSingle()
    closedByName = (closer?.name as string) ?? null
  }

  return {
    rows: ownOnly ? rows.filter(r => r.employee_id === viewer.id) : rows,
    monthClosed,
    closedAt: (firstClosed?.closed_at as string | null) ?? null,
    closedByName,
    viewerRole: viewer.role,
    // ownOnly — режим «только своя строка». Страница по нему рендерит узкий экран
    // (без переключателя сотрудников, без ФОТ и сумм по другим людям, без мутаций).
    // Флаг вычислен на СЕРВЕРЕ из сессии, клиент на него влиять не может; сама
    // фильтрация строк тоже серверная (выше), UI лишь отражает уже урезанную выдачу.
    ownOnly,
  }
}

// ─── Аванс ────────────────────────────────────────────────────────────────────

export async function addAdvance(
  employeeId: string,
  year: number,
  month: number,
  amount: number,
): Promise<ActionResult> {
  const viewer = await requireSalaryAccess()
  if (!viewer) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'salaries', 'edit')) return { success: false, error: 'Недостаточно прав' }
  if (!amount || amount <= 0) return { success: false, error: 'Сумма должна быть больше 0' }

  const admin = createAdminClient()

  // Закрытому месяцу авансы не добавляются
  const { data: res } = await admin
    .from('employee_kpi_results')
    .select('is_closed')
    .eq('employee_id', employeeId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()
  if (res?.is_closed) return { success: false, error: 'Месяц закрыт — изменения недоступны' }

  // Дата аванса — сегодня, если сегодня в выбранном месяце, иначе последний день месяца
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEndD  = new Date(year, month, 0)
  const monthEnd   = `${year}-${String(month).padStart(2, '0')}-${String(monthEndD.getDate()).padStart(2, '0')}`
  // Дата в поясе компании: toISOString() давал UTC, и аванс, выданный утром по Бишкеку,
  // проваливался во вчерашний день (а 1-го числа — в предыдущий месяц).
  const today = businessToday()
  const date = today >= monthStart && today <= monthEnd ? today : monthEnd

  const { error } = await admin.from('advance_payments').insert({
    employee_id: employeeId,
    amount,
    date,
    created_by: viewer.id,
  })
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/salary')
  return { success: true }
}

// ─── Отметка KPI-пункта ───────────────────────────────────────────────────────

export async function toggleKpiItem(
  employeeId: string,
  kpiItemId: string,
  year: number,
  month: number,
  isCompleted: boolean,
): Promise<ActionResult> {
  const viewer = await requireSalaryAccess()
  if (!viewer) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'salaries', 'edit')) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()

  const { data: res } = await admin
    .from('employee_kpi_results')
    .select('is_closed')
    .eq('employee_id', employeeId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()
  if (res?.is_closed) return { success: false, error: 'Месяц закрыт — изменения недоступны' }

  // Upsert; триггер на employee_kpi_item_results пересчитает items_bonus
  const { error } = await admin
    .from('employee_kpi_item_results')
    .upsert(
      {
        employee_id:  employeeId,
        kpi_item_id:  kpiItemId,
        period_year:  year,
        period_month: month,
        is_completed: isCompleted,
      },
      { onConflict: 'employee_id,kpi_item_id,period_year,period_month' },
    )
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/salary')
  return { success: true }
}

// ─── Закрытие месяца ──────────────────────────────────────────────────────────
// close_kpi_month() — SECURITY DEFINER, внутри проверяет get_my_role():
// вызываем через СЕССИОННЫЙ клиент (JWT пользователя), не через admin.

export async function closeMonth(year: number, month: number): Promise<ActionResult> {
  const viewer = await requireSalaryAccess()
  if (!viewer) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'salaries', 'edit')) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()

  const [{ data: emps }, { data: alreadyClosed }] = await Promise.all([
    admin
      .from('employees')
      .select('id')
      .is('deleted_at', null)
      .neq('role', 'owner'),
    admin
      .from('employee_kpi_results')
      .select('employee_id')
      .eq('period_year', year)
      .eq('period_month', month)
      .eq('is_closed', true),
  ])

  // Уже закрытых по отдельности пропускаем — не перезаписываем closed_at/closed_by
  const closedIds = new Set((alreadyClosed ?? []).map(r => r.employee_id as string))

  let closed = 0
  for (const e of emps ?? []) {
    if (closedIds.has(e.id as string)) continue
    // close_kpi_month теперь service_role-only (миграция 041); авторизация — выше
    // (requireSalaryAccess + can), id закрывающего передаём параметром.
    const { error } = await admin.rpc('close_kpi_month', {
      p_employee_id: e.id,
      p_year:        year,
      p_month:       month,
      p_closer_id:   viewer.id,
    })
    if (error) {
      console.error('[closeMonth]', e.id, error.message)
      return { success: false, error: `Ошибка закрытия: ${error.message} (закрыто ${closed})` }
    }
    closed++
  }

  revalidatePath('/dashboard/salary')
  return { success: true }
}

// ─── Закрытие месяца для одного сотрудника ────────────────────────────────────
// Например, при увольнении раньше остальных — расчёт фиксируется индивидуально.

export async function closeEmployeeMonth(
  employeeId: string,
  year: number,
  month: number,
): Promise<ActionResult> {
  const viewer = await requireSalaryAccess()
  if (!viewer) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actorFromViewer(viewer), 'salaries', 'edit')) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: res } = await admin
    .from('employee_kpi_results')
    .select('is_closed')
    .eq('employee_id', employeeId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()
  if (res?.is_closed) return { success: false, error: 'Расчёт этого сотрудника уже закрыт' }

  const { error } = await admin.rpc('close_kpi_month', {
    p_employee_id: employeeId,
    p_year:        year,
    p_month:       month,
    p_closer_id:   viewer.id,
  })
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/salary')
  return { success: true }
}
