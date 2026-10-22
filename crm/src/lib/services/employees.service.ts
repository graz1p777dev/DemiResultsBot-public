'use server'
// ─── EmployeesService ─────────────────────────────────────────────────────────
// 'use server' позволяет вызывать из Client Components через useEffect.
// Adapter использует admin client — SUPABASE_SERVICE_ROLE_KEY только на сервере.

import { employeesRepository } from '../data/repository/EmployeesRepository'
import type { EmployeesData }   from '../models/employees'
import { getActor, can } from '@/lib/authz'

export async function getEmployeesData(year: number, month: number): Promise<EmployeesData> {
  // Adapter читает через admin (обход RLS) с окладами → требуем employees.view.
  const actor = await getActor()
  if (!actor || !await can(actor, 'employees', 'view')) {
    return {
      employees: [],
      stats: { total: 0, active: 0, archived: 0, totalFund: 0, avgKpiPct: 0 },
      period: { year, month },
    }
  }
  return employeesRepository.getData(year, month)
}
