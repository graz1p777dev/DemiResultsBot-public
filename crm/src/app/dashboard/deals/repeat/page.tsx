import { redirect } from 'next/navigation'
import { getActor, can } from '@/lib/authz'
import DealsBoard from '@/components/deals/DealsBoard'

export const metadata = { title: 'Повторные продажи — Demi Results' }
export const dynamic = 'force-dynamic'

export default async function RepeatDealsPage() {
  const actor = await getActor()
  if (!actor) redirect('/auth/login')
  if (!await can(actor, 'deals', 'view')) redirect('/dashboard')
  return <DealsBoard key="repeat-sales" initialPipelines={[]} initialStages={[]} initialDeals={[]} employees={[]} viewerId={actor.employeeId} canViewAll={actor.role === 'owner' || actor.role === 'rop'} canManageStages={actor.role === 'owner'} pipelineCode="repeat-sales" />
}
