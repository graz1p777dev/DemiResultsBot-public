import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { getDealAccess } from '@/lib/deal-access'

const Body = z.object({ leadId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER), claimed: z.boolean() })

export async function POST(request: Request) {
  const access = await getDealAccess('edit')
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { actor } = access
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const { data, error } = await createAdminClient().rpc('claim_crm_deal', {
    p_actor: actor.employeeId,
    p_lead_id: parsed.data.leadId,
    p_claimed: parsed.data.claimed,
  })
  if (!error && data?.status === 200) return NextResponse.json({ ok: true, responsibleEmployeeId: parsed.data.claimed ? actor.employeeId : null })
  if (!error && data?.status === 404) return NextResponse.json({ error: data.error === 'client_not_found' ? 'Карточка клиента не найдена' : 'Сделка не найдена' }, { status: 404 })
  if (!error && data?.status === 403) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!error && data?.status === 409) return NextResponse.json({ error: 'Ответственный уже изменился. Обновите диалог.' }, { status: 409 })
  return NextResponse.json({ error: 'Не удалось назначить ответственного' }, { status: 500 })
}
