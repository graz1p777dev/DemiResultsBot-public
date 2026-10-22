import { AlertTriangle, CircleDollarSign, Inbox, MessagesSquare, Workflow } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'

export default async function CrmLiveSummary() {
  const supabase = await createClient()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const [todayInbox, pendingInbox, activeDeals, overdueDeals, wonDeals] = await Promise.all([
    // crm_inbox_items is the unified inbox; whatsapp_messages is retained for
    // legacy Green API traffic that has not yet been backfilled into it.
    supabase.from('crm_inbox_items').select('id', { count: 'exact', head: true }).gte('received_at', today),
    supabase.from('crm_inbox_items').select('id', { count: 'exact', head: true }).eq('status', 'unprocessed'),
    supabase.from('deals').select('id', { count: 'exact', head: true }).eq('status', 'open').is('deleted_at', null),
    supabase.from('deals').select('id', { count: 'exact', head: true }).eq('status', 'open').lt('sla_due_at', now.toISOString()).is('deleted_at', null),
    supabase.from('deals').select('amount').eq('status', 'won').gte('sale_at', month).is('deleted_at', null),
  ])
  const [legacyToday, legacyIncoming] = await Promise.all([
    supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).gte('created_at', today),
    supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('direction', 'incoming'),
  ])
  const won = wonDeals.data ?? []
  const revenue = won.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const cards = [
    { label: 'Обращения сегодня', value: (todayInbox.count ?? 0) + (legacyToday.count ?? 0), icon: MessagesSquare, tone: 'text-sky-700 bg-sky-50' },
    { label: 'Неразобранные', value: pendingInbox.count ?? legacyIncoming.count ?? 0, icon: Inbox, tone: 'text-amber-700 bg-amber-50' },
    { label: 'Активные сделки', value: activeDeals.count ?? 0, icon: Workflow, tone: 'text-[#075a78] bg-[#eaf4f8]' },
    { label: 'Просрочены', value: overdueDeals.count ?? 0, icon: AlertTriangle, tone: 'text-red-700 bg-red-50' },
    { label: 'Продажи за месяц', value: `${won.length} · ${revenue.toLocaleString('ru-RU')} сом`, icon: CircleDollarSign, tone: 'text-emerald-700 bg-emerald-50' },
  ]
  return <section className="px-6 pb-4" aria-label="Живые показатели CRM">
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
      {cards.map(({ label, value, icon: Icon, tone }) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-3">
        <div className={`mb-2 grid size-7 place-items-center rounded-lg ${tone}`}><Icon size={14}/></div>
        <strong className="block text-sm text-[#0c2136]">{value}</strong><span className="text-[10px] text-slate-500">{label}</span>
      </div>)}
    </div>
    <p className="mt-2 text-[10px] text-slate-400">Обновляется при открытии страницы · учитывает права текущего сотрудника</p>
  </section>
}
