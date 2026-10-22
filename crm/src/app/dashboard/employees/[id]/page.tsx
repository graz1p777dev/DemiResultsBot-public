// ─── Досье сотрудника ─────────────────────────────────────────────────────────
//
// Страница-досье (просмотр), а не форма: редактирование остаётся отдельной кнопкой
// «Изменить», которая открывает существующую модалку в списке сотрудников.
//
// МОДЕЛЬ ДОСТУПА (fail-closed, всё на сервере — UI ничего не «прячет»).
//
// Общий вход в досье:
//   getActor() → can(employees,view) → getScope(employees) → inScope(по строке сотрудника).
//
// ВАЖНО: право «видеть карточку сотрудника» НЕ даёт права видеть его декомпозицию,
// консультации, посещаемость и зарплату. Каждая вкладка читает СВОЙ ресурс, поэтому
// перед каждым admin-read делается независимая проверка
//   can(resource,view) + getScope(resource) + inScope(resource-scope, сотрудник)
// через mayViewResource(). Вкладка вообще не показывается, если права на её ресурс нет,
// и её запрос не выполняется.
//
// Пример дыры, которую это закрывает: бухгалтер с employees.view=all, но
// decomposition.view=false / consultations.view=false / attendance.scope=own —
// раньше видел чужую декомпозицию, консультации и посещаемость.
//
// Персональные поля (телефон, дата рождения, оклад, коэффициент, заметки, причина
// увольнения) не попадают даже в SELECT без права: сначала читаем только id+department_id
// для проверки охвата, и лишь затем формируем список колонок по правам.

import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Pencil } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, getScope, inScope, type Actor, type Section } from '@/lib/authz'
import { DossierTabs, resolveTab, type DossierTab } from './_components/DossierTabs'
import { OverviewTab, type OverviewEmployee } from './_components/OverviewTab'
import { ResultsTab, type ResultsRow } from './_components/ResultsTab'
import { AttendanceTab, type AttendanceRecord } from './_components/AttendanceTab'
import { SalaryTab, type SalaryRecord } from './_components/SalaryTab'
import { BRAND, initials } from './_components/shared'
import { formatTenureShort } from '@/lib/employee-tenure'

interface RawEmployee {
  id: string
  name: string
  email: string
  phone: string | null
  role: string
  status: string
  hire_date: string | null
  birth_date: string | null
  base_salary: number | null
  kpi_coefficient: number | null
  schedule_type: string
  work_start_time: string | null
  work_end_time: string | null
  notes: string | null
  dismissal_reason: string | null
  deleted_at: string | null
  department_id: string | null
  departments: { name: string } | null
}

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  active:    { label: 'Активный',      bg: '#dcfce7', color: '#166534' },
  probation: { label: 'Испытательный', bg: '#fef9c3', color: '#854d0e' },
  archived:  { label: 'Уволен',        bg: '#f3f4f6', color: '#6b7280' },
}

// FK указан явно: employees↔departments связаны ДВУМЯ ключами (department_id сотрудника
// и manager_id отдела), из-за чего короткое `departments(name)` даёт PGRST201 (ambiguous).
const BASE_FIELDS =
  'id,name,email,role,status,hire_date,schedule_type,work_start_time,work_end_time,' +
  'deleted_at,department_id,departments!employees_department_id_fkey(name)'

// Персональные/зарплатные поля — только при праве на salaries (как в исходной карточке).
// dismissal_reason сюда же: формулировка причины увольнения («нарушение дисциплины»)
// — чувствительные кадровые данные, не для всех, кто просто видит карточку.
const PERSONAL_FIELDS = 'phone,birth_date,base_salary,kpi_coefficient,notes,dismissal_reason'

/** Можно ли этому актору смотреть ДАННЫЙ ресурс ПО ЭТОМУ сотруднику.
 *  Три независимых условия: право на ресурс, охват ресурса, попадание сотрудника в охват.
 *  Охват берётся у самого ресурса, а не у employees — у бухгалтера может быть
 *  employees=all, но attendance=own. */
async function mayViewResource(
  actor: Actor,
  resource: Section,
  employeeId: string,
  employeeDepartmentId: string | null,
): Promise<boolean> {
  if (!await can(actor, resource, 'view')) return false
  const scope = await getScope(actor, resource)
  if (!scope) return false
  return inScope(actor, scope, employeeId, employeeDepartmentId)
}

export default async function EmployeeDossierPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id } = await params
  const { tab } = await searchParams

  // ─── Гейт 1: вход в раздел «Сотрудники» ─────────────────────────────────────
  const actor = await getActor()
  if (!actor || !await can(actor, 'employees', 'view')) redirect('/dashboard')
  const employeesScope = await getScope(actor, 'employees')
  if (!employeesScope) redirect('/dashboard')

  const admin = createAdminClient()

  // ─── Гейт 2: охват по конкретному сотруднику ────────────────────────────────
  // Читаем МИНИМУМ (id + отдел) — до проверки охвата ни одно содержательное поле
  // не должно покидать БД.
  const { data: probe, error: probeError } = await admin
    .from('employees')
    .select('id,department_id')
    .eq('id', id)
    .maybeSingle()

  if (probeError || !probe) notFound()
  const employeeId   = probe.id as string
  const employeeDept = (probe.department_id as string | null) ?? null

  if (!inScope(actor, employeesScope, employeeId, employeeDept)) redirect('/dashboard')

  // ─── Гейт 3: права на ресурс КАЖДОЙ вкладки (независимо друг от друга) ──────
  const [canDecomposition, canConsultations, canAttendance, canSalaries, canEdit] = await Promise.all([
    mayViewResource(actor, 'decomposition', employeeId, employeeDept),
    mayViewResource(actor, 'consultations', employeeId, employeeDept),
    mayViewResource(actor, 'attendance',    employeeId, employeeDept),
    mayViewResource(actor, 'salaries',      employeeId, employeeDept),
    can(actor, 'employees', 'edit'),
  ])

  // Персональные поля и зарплатная вкладка идут под одним правом (salaries).
  const canSeePersonal = canSalaries

  const availableTabs: DossierTab[] = ['overview']
  if (canDecomposition || canConsultations) availableTabs.push('results')
  if (canAttendance) availableTabs.push('attendance')
  if (canSalaries)   availableTabs.push('salary')

  // Неизвестная вкладка или вкладка без права → «Обзор» (fail-closed).
  const activeTab = resolveTab(tab, availableTabs)

  // ─── Загрузка карточки: колонки формируются ПО ПРАВАМ ───────────────────────
  const { data: empData, error: empError } = await admin
    .from('employees')
    .select(canSeePersonal ? `${BASE_FIELDS},${PERSONAL_FIELDS}` : BASE_FIELDS)
    .eq('id', employeeId)
    .maybeSingle()

  if (empError || !empData) notFound()
  const emp = empData as unknown as RawEmployee

  // Подпись роли берём из таблицы roles: после миграции 044 роли переименовываемы,
  // поэтому хардкод-словарь названий устарел бы при первом же переименовании.
  const { data: roleRow } = await admin
    .from('roles')
    .select('label')
    .eq('name', emp.role)
    .is('deleted_at', null)
    .maybeSingle()
  const roleLabel = (roleRow?.label as string | undefined) ?? emp.role

  const now        = new Date()
  const year       = now.getFullYear()
  const month      = now.getMonth() + 1
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const nextMonth  = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`

  // ─── Данные активной вкладки: каждый источник — под своим правом ────────────
  let resultsRows: ResultsRow[] = []
  let consultationsThisMonth: number | null = null   // null — нет права на consultations
  let attendanceRecords: AttendanceRecord[] = []
  let salaryRecords: SalaryRecord[] = []

  if (activeTab === 'results') {
    // Два РАЗНЫХ ресурса в одной вкладке — запрашиваем независимо друг от друга.
    const [decompRes, consultRes] = await Promise.all([
      canDecomposition
        ? admin
            .from('sales_plan_weekly')
            .select('period_year,period_month,total_fv_plan,total_fv_fact,total_sales_plan,total_sales_fact,total_revenue_plan,total_revenue_fact,kpi_pct')
            .eq('employee_id', employeeId)
            .order('period_year', { ascending: false })
            .order('period_month', { ascending: false })
            .limit(24)
        : Promise.resolve({ data: null }),
      canConsultations
        ? admin
            .from('consultations')
            .select('id', { count: 'exact', head: true })
            .eq('manager_id', employeeId)
            .is('deleted_at', null)
            .gte('date', monthStart)
            .lt('date', nextMonth)
        : Promise.resolve({ count: null }),
    ])
    resultsRows = ((decompRes as { data: unknown }).data ?? []) as ResultsRow[]
    consultationsThisMonth = (consultRes as { count?: number | null }).count ?? null
  }

  if (activeTab === 'attendance' && canAttendance) {
    const { data } = await admin
      .from('attendance')
      .select('date,status,is_late,late_minutes,check_in_time,comment')
      .eq('employee_id', employeeId)
      .gte('date', monthStart)
      .lt('date', nextMonth)
      .order('date', { ascending: false })
    attendanceRecords = (data ?? []) as unknown as AttendanceRecord[]
  }

  if (activeTab === 'salary' && canSalaries) {
    const { data } = await admin
      .from('salaries')
      .select('period_year,period_month,base_salary,kpi_bonus,bonuses,deductions,advance_amount,total_amount,kpi_pct,work_days_fact,work_days_plan,status,paid_at')
      .eq('employee_id', employeeId)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(24)
    salaryRecords = (data ?? []) as unknown as SalaryRecord[]
  }

  const statusInfo = STATUS_LABELS[emp.status] ?? STATUS_LABELS.active
  const deptName   = emp.departments?.name ?? null
  const tenure     = formatTenureShort(emp.hire_date)

  const overviewEmp: OverviewEmployee = {
    name: emp.name, email: emp.email, phone: emp.phone ?? null,
    role: emp.role, roleLabel, status: emp.status,
    hire_date: emp.hire_date, birth_date: emp.birth_date ?? null,
    schedule_type: emp.schedule_type,
    work_start_time: emp.work_start_time, work_end_time: emp.work_end_time,
    notes: emp.notes ?? null, dismissal_reason: emp.dismissal_reason ?? null,
    deleted_at: emp.deleted_at, deptName,
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: BRAND.bg }}>
      {/* Шапка досье */}
      <div className="px-5 py-4 flex items-center gap-3" style={{ backgroundColor: BRAND.text }}>
        <Link
          href="/dashboard/employees"
          aria-label="Назад к списку сотрудников"
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-opacity hover:opacity-80"
          style={{ backgroundColor: BRAND.accent }}
        >
          <ArrowLeft size={16} color="#ffffff" />
        </Link>

        <div
          className="w-11 h-11 rounded-2xl hidden sm:flex items-center justify-center text-sm font-bold shrink-0"
          style={{ backgroundColor: BRAND.accent, color: '#ffffff' }}
        >
          {initials(emp.name)}
        </div>

        <div className="min-w-0">
          <h1 className="text-white font-semibold text-base truncate">{emp.name}</h1>
          <p className="text-xs truncate" style={{ color: BRAND.muted }}>
            {roleLabel}
            {deptName && ` · ${deptName}`}
            {tenure && ` · ${tenure}`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap"
            style={{ backgroundColor: statusInfo.bg, color: statusInfo.color }}>
            {statusInfo.label}
          </span>
          {canEdit && (
            <Link
              href={`/dashboard/employees?edit=${emp.id}`}
              className="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-opacity hover:opacity-80"
              style={{ backgroundColor: BRAND.accent, color: '#ffffff' }}
            >
              <Pencil size={13} /> Изменить
            </Link>
          )}
        </div>
      </div>

      <DossierTabs employeeId={emp.id} active={activeTab} available={availableTabs} />

      <div className="p-5">
        {activeTab === 'overview' && (
          <OverviewTab emp={overviewEmp} canSeePersonal={canSeePersonal} />
        )}
        {activeTab === 'results' && (
          <ResultsTab
            rows={resultsRows}
            year={year}
            month={month}
            consultationsThisMonth={consultationsThisMonth}
            canDecomposition={canDecomposition}
          />
        )}
        {activeTab === 'attendance' && canAttendance && (
          <AttendanceTab records={attendanceRecords} year={year} month={month} />
        )}
        {activeTab === 'salary' && canSalaries && (
          <SalaryTab
            records={salaryRecords}
            baseSalary={emp.base_salary ?? 0}
            kpiCoefficient={emp.kpi_coefficient ?? 0}
          />
        )}
      </div>
    </div>
  )
}
