import { can, getScope, type Actor } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { canAccessDealResponsible, DEAL_COMPANY_ID, type DealAccess } from '@/lib/deal-access'
import { getPermissionsForRole } from '@/lib/identity'

export async function getClientAccess(actor: Actor, action: 'view' | 'edit'): Promise<DealAccess | null> {
  if (!await can(actor, 'clients', action)) return null
  let scope = await getScope(actor, 'clients')
  if (!scope && action === 'edit') {
    const rows = (await getPermissionsForRole(actor.role))?.filter(row => row.resource === 'clients') ?? []
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

export async function getAccessibleClient(access: DealAccess, clientId: string) {
  const { data, error } = await createAdminClient().from('crm_clients').select('*')
    .eq('id', clientId).eq('company_id', DEAL_COMPANY_ID).is('deleted_at', null).maybeSingle()
  if (error || !data || !canAccessDealResponsible(access, data.responsible_employee_id)) return null
  return data
}
