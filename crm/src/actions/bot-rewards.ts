'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { can, getActor } from '@/lib/authz'

export type RewardEmployee = { id: string; name: string; email: string }

export async function getRewardEligibleEmployees(): Promise<RewardEmployee[]> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'dashboard', 'view')) return []

  const { data, error } = await createAdminClient()
    .from('employees')
    .select('id,name,email')
    .is('deleted_at', null)
    .in('status', ['active', 'probation'])
    .order('name')

  if (error) return []
  return (data ?? []) as RewardEmployee[]
}
