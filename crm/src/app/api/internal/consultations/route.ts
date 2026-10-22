import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Payload = z.object({
  lead_id: z.coerce.number().int().positive(),
  date: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  name: z.string().min(1).max(200),
  phone: z.string().max(64).nullable().optional(),
  format: z.string().max(64).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
})

function toIsoDate(value: string) {
  const [day, month, year] = value.split('.')
  return `${year}-${month}-${day}`
}

export async function POST(request: Request) {
  if (!process.env.INTERNAL_NOTIFY_TOKEN) return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  if (request.headers.get('x-internal-token') !== process.env.INTERNAL_NOTIFY_TOKEN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const parsed = Payload.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  const admin = createAdminClient()
  const { data: deal } = await admin.from('deals')
    .select('id, client_id, responsible_employee_id')
    .eq('amocrm_lead_id', parsed.data.lead_id).is('deleted_at', null).maybeSingle()
  const row = {
    amocrm_lead_id: parsed.data.lead_id,
    bot_booking_key: `lead:${parsed.data.lead_id}`,
    crm_deal_id: deal?.id ?? null,
    manager_id: deal?.responsible_employee_id ?? null,
    date: toIsoDate(parsed.data.date),
    time: parsed.data.time,
    client_name: parsed.data.name,
    phone: parsed.data.phone ?? null,
    deal_number: String(parsed.data.lead_id),
    format: parsed.data.format?.toLowerCase().includes('онлайн') ? 'Онлайн' : 'Офлайн',
    status: 'Придёт',
    alb_status: 'Записан',
    amount: 0,
    delivery_cost: 0,
    is_nv: true,
    is_returning_customer: false,
    source: 'organic',
    comment: parsed.data.comment ?? null,
  }
  const { data: existing } = await admin.from('consultations').select('id')
    .eq('amocrm_lead_id', parsed.data.lead_id).is('deleted_at', null)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle()
  const operation = existing
    ? admin.from('consultations').update(row).eq('id', existing.id)
    : admin.from('consultations').insert(row)
  let { error } = await operation
  if (error && /crm_deal_id/i.test(error.message || '')) {
    const { crm_deal_id: _pendingMigration, ...compatibleRow } = row
    const fallback = existing
      ? admin.from('consultations').update(compatibleRow).eq('id', existing.id)
      : admin.from('consultations').insert(compatibleRow)
    error = (await fallback).error
  }
  if (error) {
    console.error('[internal/consultations]', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
