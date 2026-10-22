import { NextResponse } from 'next/server'
import { z } from 'zod'
import { can, getActor } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const ClientId = z.string().uuid()

export async function GET(request: Request) {
  const actor = await getActor()
  if (!actor || !await can(actor, 'inbox', 'view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const parsed = ClientId.safeParse(new URL(request.url).searchParams.get('client'))
  if (!parsed.success) return NextResponse.json({ error: 'Некорректный ID клиента' }, { status: 400 })
  const { data } = await createAdminClient().from('deals').select('amocrm_lead_id').eq('client_id', parsed.data).not('amocrm_lead_id', 'is', null).is('deleted_at', null).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (!data?.amocrm_lead_id) return NextResponse.json({ error: 'Диалог клиента не найден' }, { status: 404 })
  return NextResponse.json({ botLeadId: String(data.amocrm_lead_id) })
}
