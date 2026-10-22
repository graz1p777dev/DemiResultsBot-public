import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Payload = z.object({
  lead_id: z.coerce.number().int().positive(),
  pipeline_id: z.coerce.number().int().positive(),
  status_id: z.coerce.number().int().positive().optional(),
  stage_name: z.string().trim().min(1).max(120).optional(),
  title: z.string().min(1).max(300),
  amount: z.coerce.number().nonnegative().nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  customer_phone: z.string().max(64).nullable().optional(),
  customer_username: z.string().max(160).nullable().optional(),
  source: z.enum(['telegram', 'whatsapp', 'instagram', 'amocrm']).default('amocrm'),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
}).refine(value => value.status_id || value.stage_name, { message: 'status_id or stage_name is required' })

export async function POST(request: Request) {
  if (!process.env.INTERNAL_NOTIFY_TOKEN) return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  if (request.headers.get('x-internal-token') !== process.env.INTERNAL_NOTIFY_TOKEN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const parsed = Payload.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  const admin = createAdminClient()
  let stageQuery = admin.from('deal_stages').select('id, company_id, pipeline_id')
  stageQuery = parsed.data.stage_name
    ? stageQuery.eq('name', parsed.data.stage_name).eq('pipeline_id', '10000000-0000-0000-0000-000000000001')
    : stageQuery.eq('amocrm_status_id', parsed.data.status_id!)
  const { data: stage } = await stageQuery.maybeSingle()
  let resolvedStage = stage
  if (!resolvedStage && parsed.data.stage_name) {
    resolvedStage = (await admin.from('deal_stages').select('id, company_id, pipeline_id')
      .eq('name', 'Неразобранное').eq('pipeline_id', '10000000-0000-0000-0000-000000000001').maybeSingle()).data
  }
  if (!resolvedStage) return NextResponse.json({ error: 'Unknown CRM stage' }, { status: 409 })

  const now = new Date().toISOString()
  const values = {
    title: parsed.data.title,
    company_id: resolvedStage.company_id,
    pipeline_id: resolvedStage.pipeline_id,
    stage_id: resolvedStage.id,
    amount: parsed.data.amount ?? null,
    currency: 'KGS',
    customer_name: parsed.data.customer_name ?? null,
    customer_phone: parsed.data.customer_phone ?? null,
    customer_username: parsed.data.customer_username ?? null,
    source: parsed.data.source,
    amocrm_lead_id: parsed.data.lead_id,
    amocrm_pipeline_id: parsed.data.pipeline_id,
    last_synced_at: now,
    created_at: parsed.data.created_at ?? now,
    updated_at: parsed.data.updated_at ?? now,
    deleted_at: null as string | null,
  }

  const { data: linkedDeal } = await admin.from('deals').select('id').eq('amocrm_lead_id', parsed.data.lead_id).is('deleted_at', null).maybeSingle()
  let targetDeal = linkedDeal
  const normalizedPhone = (parsed.data.customer_phone ?? '').replace(/\D/g, '')
  if (!targetDeal && normalizedPhone) {
    const { data: client } = await admin.from('crm_clients').select('id').eq('company_id', resolvedStage.company_id).eq('phone_normalized', normalizedPhone).is('deleted_at', null).limit(1).maybeSingle()
    if (client) {
      targetDeal = (await admin.from('deals').select('id').eq('client_id', client.id).eq('source', parsed.data.source).is('amocrm_lead_id', null).is('deleted_at', null).order('updated_at', { ascending: false }).limit(1).maybeSingle()).data
    }
  }

  const result = targetDeal
    ? await admin.from('deals').update(values).eq('id', targetDeal.id)
    : await admin.from('deals').insert({ ...values, external_key: `bot:${parsed.data.lead_id}` })
  const { error } = result
  if (error) {
    console.error('[internal/deals]', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
