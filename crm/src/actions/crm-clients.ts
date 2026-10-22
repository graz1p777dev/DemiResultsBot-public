'use server'

import { can, getActor } from '@/lib/authz'
import { NextRequest } from 'next/server'
import { getBackendRecordAccess } from '@/lib/backend-record-access'
import { canAccessDealResponsible, DEAL_COMPANY_ID, getDealAccess } from '@/lib/deal-access'
import { createClient } from '@/lib/supabase/server'
import type { Deal } from '@/types'

export type CrmClientListItem = {
  id: number
  name: string | null
  phone: string | null
  source: string | null
  external_id: string
  deals_count: number
  amocrm_lead_ids: string[]
  last_message_at: string | null
  created_at: string
  purchases_count: number
  purchases_total: number
  last_purchase_at: string | null
}

export type CrmClientDetail = {
  id: number
  name: string | null
  phone: string | null
  source: string | null
  external_id: string
  created_at: string
  updated_at: string
  leads: Array<{
    id: number
    amocrm_lead_id: string
    status_id: number | null
    ai_enabled: boolean
    last_message_at: string | null
    created_at: string
  }>
  messages: Array<{
    id: number
    lead_id: number
    role: string
    direction: string
    text: string
    status: string
    created_at: string
  }>
  deals: Deal[]
}

async function botAdminFetch<T>(path: string): Promise<T> {
  const base = process.env.BOT_BACKEND_API_URL?.replace(/\/$/, '')
  const key = process.env.BOT_BACKEND_ADMIN_API_KEY
  if (!base || !key) throw new Error('Интеграция с ботом не настроена')
  const response = await fetch(`${base}/admin${path}`, {
    cache: 'no-store',
    headers: { 'X-Admin-API-Key': key },
  })
  if (!response.ok) throw new Error(`Bot API ${response.status}`)
  return response.json() as Promise<T>
}

async function readBackend(path: string[], search = ''): Promise<unknown> {
  return botAdminFetch(`/${path.slice(1).map(encodeURIComponent).join('/')}${search}`)
}

async function clientDeals(leadIds: number[]): Promise<Deal[]> {
  const access = await getDealAccess('view')
  if (!access || !leadIds.length) return []
  const db = await createClient()
  const deals: Deal[] = []
  for (let index = 0; index < leadIds.length; index += 500) {
    const { data, error } = await db.from('deals').select('*')
      .eq('company_id', DEAL_COMPANY_ID)
      .in('amocrm_lead_id', leadIds.slice(index, index + 500))
      .is('deleted_at', null).order('created_at', { ascending: false })
    if (error) return []
    deals.push(...((data ?? []) as Deal[]).filter(deal => canAccessDealResponsible(access, deal.responsible_employee_id)))
  }
  return deals
}

export async function getCrmClients(query = ''): Promise<{ items: CrmClientListItem[]; total: number }> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'clients', 'view')) return { items: [], total: 0 }
  const params = new URLSearchParams({ limit: '200' })
  if (query.trim()) params.set('q', query.trim())
  const access = actor.role === 'owner' ? null : await getBackendRecordAccess(['clients'])
  if (actor.role !== 'owner' && !access) return { items: [], total: 0 }
  const result = (actor.role === 'owner'
    ? await botAdminFetch(`/clients?${params}`)
    : await access!.list(new NextRequest(`https://crm.internal/clients?${params}`), ['admin', 'clients'], readBackend)) as { items: CrmClientListItem[]; total: number } | null
  if (!result) return { items: [], total: 0 }
  const leadIds = [...new Set(result.items.flatMap(item => item.amocrm_lead_ids).map(Number).filter(Number.isFinite))]
  const deals = await clientDeals(leadIds)
  const byLead = new Map<number, typeof deals>()
  for (const deal of deals) {
    if (!deal.amocrm_lead_id) continue
    const list = byLead.get(deal.amocrm_lead_id) ?? []
    list.push(deal)
    byLead.set(deal.amocrm_lead_id, list)
  }
  return {
    total: result.total,
    items: result.items.map(client => {
      const clientDeals = client.amocrm_lead_ids.flatMap(id => byLead.get(Number(id)) ?? [])
      const purchases = clientDeals.filter(deal => deal.status === 'won')
      const purchaseDates = purchases.map(deal => deal.sale_at || deal.updated_at).filter(Boolean).sort()
      return {
        ...client,
        purchases_count: purchases.length,
        purchases_total: purchases.reduce((sum, deal) => sum + Number(deal.amount ?? 0), 0),
        last_purchase_at: purchaseDates.at(-1) ?? null,
      }
    }),
  }
}

export async function getCrmClient(clientId: number): Promise<CrmClientDetail | null> {
  const actor = await getActor()
  if (!actor || !await can(actor, 'clients', 'view')) return null
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return null
  try {
    const access = actor.role === 'owner' ? null : await getBackendRecordAccess(['clients'])
    if (actor.role !== 'owner' && !access) return null
    const raw = await botAdminFetch<Omit<CrmClientDetail, 'deals'>>(`/clients/${clientId}`)
    const client = (actor.role === 'owner' ? raw
      : await access!.filter(['admin', 'clients', String(clientId)], raw, readBackend)) as Omit<CrmClientDetail, 'deals'> | null
    if (!client) return null
    const leadIds = client.leads.map(lead => Number(lead.amocrm_lead_id)).filter(Number.isFinite)
    return { ...client, deals: await clientDeals(leadIds) }
  } catch {
    return null
  }
}
