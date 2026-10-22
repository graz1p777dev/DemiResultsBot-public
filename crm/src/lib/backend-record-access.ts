import type { NextRequest } from 'next/server'
import type { Section } from '@/lib/authz'
import { canAccessDealResponsible, DEAL_COMPANY_ID, getDealAccess } from '@/lib/deal-access'
import { createAdminClient } from '@/lib/supabase/admin'

type Row = Record<string, unknown>
type ReadBackend = (path: string[], search?: string) => Promise<unknown>

function row(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function id(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  return /^[1-9]\d*$/.test(text) ? text : null
}

function messageId(value: unknown): boolean {
  return id(value) !== null || (typeof value === 'string' && /^(appr|local)-[1-9]\d*$/.test(value))
}

export async function getBackendRecordAccess(resources: Section[]) {
  const accesses = (await Promise.all(resources.map(resource => getDealAccess('view', resource))))
    .filter(access => access !== null)
  if (!accesses.length) return null

  async function allowedIds(values: unknown[]): Promise<Set<string> | null> {
    const ids = values.map(id)
    if (ids.some(value => value === null)) return null
    const unique = [...new Set(ids as string[])]
    const allowed = new Set<string>()
    for (let offset = 0; offset < unique.length; offset += 200) {
      const { data, error } = await createAdminClient().from('deals')
        .select('amocrm_lead_id, responsible_employee_id')
        .eq('company_id', DEAL_COMPANY_ID).is('deleted_at', null)
        .in('amocrm_lead_id', unique.slice(offset, offset + 200))
      if (error || !data) return null
      const seen = new Set<string>()
      for (const deal of data) {
        const leadId = id(deal.amocrm_lead_id)
        const responsible = deal.responsible_employee_id
        if (!leadId || seen.has(leadId) || (responsible !== null && typeof responsible !== 'string')) return null
        seen.add(leadId)
        if (accesses.some(access => canAccessDealResponsible(access, responsible))) allowed.add(leadId)
      }
    }
    return allowed
  }

  async function allows(value: unknown) {
    const leadId = id(value)
    return leadId !== null && Boolean((await allowedIds([leadId]))?.has(leadId))
  }

  async function clientDetail(value: unknown, clientId: string, requireAll = false): Promise<Row | null> {
    if (!row(value) || id(value.id) !== clientId || !Array.isArray(value.leads) || !Array.isArray(value.messages)) return null
    if (!value.leads.every(lead => row(lead) && id(lead.id) && id(lead.amocrm_lead_id))) return null
    const leads = value.leads as Row[]
    if (new Set(leads.map(lead => id(lead.id))).size !== leads.length) return null
    const allowed = await allowedIds(leads.map(lead => lead.amocrm_lead_id))
    if (!allowed) return null
    const visible = leads.filter(lead => allowed.has(id(lead.amocrm_lead_id)!))
    if (!visible.length || (requireAll && visible.length !== leads.length)) return null
    const internalIds = new Set(visible.map(lead => id(lead.id)))
    if (!value.messages.every(message => row(message) && id(message.lead_id))) return null
    return { ...value, leads: visible, messages: value.messages.filter(message => internalIds.has(id(message.lead_id))) }
  }

  async function authorize(request: NextRequest, path: string[], read: ReadBackend): Promise<boolean> {
    if (path[1] === 'chat') return allows(path[2])
    if (path[1] === 'conversations' && path[2] === 'by-lead') return allows(path[3])
    if (path[1] === 'leads') {
      const detail = await read(['admin', 'leads', path[2]])
      return row(detail) && row(detail.lead) && id(detail.lead.id) === path[2] && await allows(detail.lead.amocrm_lead_id)
    }
    if (path[1] === 'attachment') {
      const leadIds = request.nextUrl.searchParams.getAll('leadId')
      if (leadIds.length !== 1 || !await allows(leadIds[0])) return false
      const chat = await read(['admin', 'chat', leadIds[0]])
      return row(chat) && id(chat.lead_id) === leadIds[0] && Array.isArray(chat.messages)
        && chat.messages.every(message => row(message) && messageId(message.id))
        && chat.messages.filter(message => id(message.id) === path[2]).length === 1
    }
    if (path[1] === 'approvals' && path.length > 2) {
      let offset = 0
      let total: number | null = null
      let leadId: unknown = null
      const seen = new Set<string>()
      do {
        const page = await read(['admin', 'approvals'], `?status=pending,edited&limit=200&offset=${offset}`)
        if (!row(page) || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || (page.total as number) < 0) return false
        if (total !== null && total !== page.total) return false
        total = page.total as number
        if (page.items.length > 200 || offset + page.items.length > total || (!page.items.length && offset < total)) return false
        for (const item of page.items) {
          if (!row(item) || !id(item.id) || !row(item.lead) || !id(item.lead.amocrm_lead_id)
            || !['pending', 'edited'].includes(String(item.status)) || seen.has(id(item.id)!)) return false
          seen.add(id(item.id)!)
          if (id(item.id) === path[2]) leadId = item.lead.amocrm_lead_id
        }
        offset += page.items.length
      } while (offset < total)
      return allows(leadId)
    }
    if (path[1] === 'clients' && path[3] === 'merge') {
      let body: unknown
      try { body = await request.clone().json() } catch { return false }
      if (!row(body) || !id(body.target_client_id)) return false
      for (const clientId of [path[2], id(body.target_client_id)!]) {
        if (!await clientDetail(await read(['admin', 'clients', clientId]), clientId, true)) return false
      }
    }
    return true
  }

  async function filter(path: string[], value: unknown, read?: ReadBackend): Promise<unknown | null> {
    if (path[1] === 'conversations' && path.length === 2) {
      if (!Array.isArray(value) || !value.every(item => row(item) && id(item.id))) return null
      const supported = value.filter(item => id(item.amocrm_lead_id))
      const allowed = await allowedIds(supported.map(item => item.amocrm_lead_id))
      return allowed ? supported.filter(item => allowed.has(id(item.amocrm_lead_id)!)) : null
    }
    if (path[1] === 'conversations' && path[2] === 'by-lead') {
      return row(value) && id(value.id) && id(value.amocrm_lead_id) === path[3] ? value : null
    }
    if (path[1] === 'chat') {
      return row(value) && id(value.lead_id) === path[2] && Array.isArray(value.messages)
        && value.messages.every(message => row(message) && messageId(message.id)) ? value : null
    }
    if (path[1] === 'clients' && path.length === 3) {
      const scoped = await clientDetail(value, path[2])
      if (!scoped || !read) return null
      const leads = scoped.leads as Row[]
      if (leads.length > 200) return null
      const expected = new Map(leads.map(lead => [id(lead.id)!, id(lead.amocrm_lead_id)!]))
      const bounded = await read(path, `?${new URLSearchParams({ lead_ids: [...expected.keys()].join(',') })}`)
      if (!row(bounded) || id(bounded.id) !== path[2] || !Array.isArray(bounded.leads)
        || bounded.leads.length !== expected.size || !Array.isArray(bounded.messages) || bounded.messages.length > 300) return null
      const seen = new Set<string>()
      for (const lead of bounded.leads) {
        if (!row(lead) || !id(lead.id) || seen.has(id(lead.id)!)
          || expected.get(id(lead.id)!) !== id(lead.amocrm_lead_id)) return null
        seen.add(id(lead.id)!)
      }
      if (!bounded.messages.every(message => row(message) && id(message.id) && expected.has(id(message.lead_id)!))) return null
      return bounded
    }
    if (path[1] === 'clients' || path[1] === 'approvals') {
      if (!row(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || (value.total as number) < value.items.length) return null
      const items = value.items
      const leadIds: unknown[] = []
      for (const item of items) {
        if (!row(item) || !id(item.id)) return null
        if (path[1] === 'clients') {
          if (!Array.isArray(item.amocrm_lead_ids)) return null
          leadIds.push(...item.amocrm_lead_ids)
        } else {
          if (!row(item.lead)) return null
          leadIds.push(item.lead.amocrm_lead_id)
        }
      }
      const allowed = await allowedIds(leadIds)
      if (!allowed) return null
      const visible = items.flatMap(item => {
        if (path[1] === 'approvals') return allowed.has(id(item.lead.amocrm_lead_id)!) ? [item] : []
        const ids = item.amocrm_lead_ids.filter((leadId: unknown) => allowed.has(id(leadId)!))
        return ids.length ? [{ ...item, amocrm_lead_ids: ids, deals_count: ids.length }] : []
      })
      return { ...value, items: visible, total: visible.length }
    }
    return null
  }

  // Backend offsets refer to all managers' rows. Apply browser pagination only
  // AFTER scope filtering, or a short first page hides later accessible records.
  async function list(request: NextRequest, path: string[], read: ReadBackend): Promise<unknown | null> {
    const conversations = path[1] === 'conversations'
    const params = request.nextUrl.searchParams
    const offset = Number(params.get('offset') ?? 0)
    const limit = Number(params.get('limit') ?? (conversations ? Infinity : 100))
    if (!Number.isSafeInteger(offset) || offset < 0 || (!(limit === Infinity && conversations) && (!Number.isSafeInteger(limit) || limit < 1))) return null
    const pageSize = conversations ? limit : Math.min(limit, 200)
    const visible: Row[] = []
    const seen = new Set<string>()
    let rawOffset = 0
    let total: number | null = null
    let envelope: Row = {}
    while (true) {
      const query = new URLSearchParams(params)
      query.set('limit', '200')
      query.set('offset', String(rawOffset))
      const page = await read(path, `?${query}`)
      const filtered = await filter(path, page)
      if (filtered === null) return null
      const rawItems = conversations ? page : (page as Row).items
      const scopedItems = conversations ? filtered : (filtered as Row).items
      const items = rawItems as Row[]
      if (items.length > 200) return null
      for (const item of items) {
        const key = id(item.id)!
        if (seen.has(key)) return null
        seen.add(key)
      }
      visible.push(...scopedItems as Row[])
      rawOffset += items.length
      if (conversations) {
        if (items.length < 200 || visible.length >= offset + pageSize) break
      } else {
        envelope = page as Row
        if (total !== null && total !== envelope.total) return null
        total = envelope.total as number
        if (rawOffset > total || (!items.length && rawOffset < total)) return null
        if (rawOffset === total) break
      }
    }
    const items = visible.slice(offset, offset + pageSize)
    return conversations ? items : { ...envelope, items, total: visible.length }
  }

  return { authorize, filter, list }
}
