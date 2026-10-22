import { redirect } from 'next/navigation'
import { getActor } from '@/lib/authz'
import { getPipelineSettingsData } from '@/actions/deals'
import PipelineSettings from '@/components/deals/PipelineSettings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Воронки и этапы — Demi Results' }

export default async function PipelineSettingsPage() {
  const actor = await getActor()
  if (actor?.role !== 'owner') redirect('/dashboard/settings')
  const data = await getPipelineSettingsData()
  return <PipelineSettings pipelines={data.pipelines} stages={data.stages} />
}
