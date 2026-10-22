import { redirect } from 'next/navigation'
import { getDealsData } from '@/actions/deals'
import AnalyticsWorkspace from '@/components/analytics/AnalyticsWorkspace'
import { can, getActor } from '@/lib/authz'

export const metadata = { title: 'Аналитика CRM — Demi Results' }
export const dynamic = 'force-dynamic'

export default async function AnalyticsPage() {
  const actor = await getActor()
  if (!actor) redirect('/auth/login')
  if (!await can(actor, 'deals', 'view')) redirect('/dashboard')
  const data = await getDealsData()
  return <AnalyticsWorkspace deals={data.deals} stages={data.stages} employees={data.employees}/>
}
