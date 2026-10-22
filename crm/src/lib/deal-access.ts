import { can, getActor, getScope, type Actor, type Scope, type Section } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Deal } from '@/types'
import { getPermissionsForRole } from '@/lib/identity'

export const DEAL_COMPANY_ID = '00000000-0000-0000-0000-000000000001'

export interface DealAccess {
  actor: Actor
  scope: Scope
  responsibleIds: string[] | null
  allowUnassigned: boolean
}

export async function getDealAccess(action: 'view' | 'edit', resource: Section = 'deals'): Promise<DealAccess | null> {
  const actor = await getActor()
  if (!actor || !await can(actor, resource, action)) return null
  let scope = await getScope(actor, resource)
  if (!scope && action === 'edit') {
    const rows = (await getPermissionsForRole(actor.role))?.filter(row => row.resource === resource) ?? []
    const value = rows.length === 1 && rows[0].can_edit ? rows[0].scope : null
    if (value === 'own' || value === 'team' || value === 'all') scope = value
  }
  if (!scope) return null
  const admin = createAdminClient()
  const { data: member, error } = await admin.from('crm_company_members').select('employee_id')
    .eq('company_id', DEAL_COMPANY_ID).eq('employee_id', actor.employeeId).maybeSingle()
  if (error || !member) return null

  const responsibleIds = scope === 'all' ? null : [actor.employeeId]
  if (scope === 'team' && actor.departmentId) {
    for (let from = 0; ; from += 500) {
      const { data, error: teamError } = await admin.from('employees')
        .select('id, crm_company_members!inner(company_id)')
        .eq('crm_company_members.company_id', DEAL_COMPANY_ID)
        .eq('department_id', actor.departmentId).is('deleted_at', null).neq('status', 'archived')
        .order('id').range(from, from + 499)
      if (teamError || !data) return null
      responsibleIds!.push(...data.map(employee => employee.id as string))
      if (data.length < 500) break
    }
  }
  return { actor, scope, responsibleIds, allowUnassigned: scope === 'all' || ['rop', 'mp', 'lmai'].includes(actor.role) }
}

export function canAccessDealResponsible(access: DealAccess, employeeId: string | null): boolean {
  return employeeId === null ? access.allowUnassigned : access.responsibleIds === null || access.responsibleIds.includes(employeeId)
}

export async function getAccessibleDeal(access: DealAccess, dealId: string): Promise<(Deal & { loss_reason_code: string | null }) | null> {
  const { data, error } = await createAdminClient().from('deals').select('*')
    .eq('id', dealId).eq('company_id', DEAL_COMPANY_ID).is('deleted_at', null).maybeSingle()
  if (error || !data || !canAccessDealResponsible(access, data.responsible_employee_id)) return null
  return data as Deal & { loss_reason_code: string | null }
}

export async function canAssignDealResponsible(access: DealAccess, employeeId: string | null): Promise<boolean> {
  if (!canAccessDealResponsible(access, employeeId)) return false
  if (employeeId === null) return true
  const { data, error } = await createAdminClient().from('employees')
    .select('id, crm_company_members!inner(company_id)')
    .eq('id', employeeId).eq('crm_company_members.company_id', DEAL_COMPANY_ID)
    .is('deleted_at', null).neq('status', 'archived').maybeSingle()
  return !error && Boolean(data)
}
