import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Search, UserRound, WalletCards } from 'lucide-react'
import { can, getActor } from '@/lib/authz'
import { getCrmClients } from '@/actions/crm-clients'

export const metadata = { title: 'Клиенты — Demi Results CRM' }
export const dynamic = 'force-dynamic'

function money(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value) + ' сом'
}

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await getActor()
  if (!actor) redirect('/auth/login')
  if (!await can(actor, 'clients', 'view')) redirect('/dashboard')
  const { q = '' } = await searchParams
  const data = await getCrmClients(q)

  return (
    <div className="min-h-[calc(100vh-52px)] bg-[#f4f8fa] p-4 md:p-7">
      <div className="mx-auto max-w-7xl">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#1784a6]">CRM · Единая база</p>
            <h1 className="mt-1 text-2xl font-bold text-[#092a42]">Клиенты</h1>
            <p className="mt-1 text-sm text-slate-500">{data.total} карточек без тестовых диалогов</p>
          </div>
          <form className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input name="q" defaultValue={q} placeholder="Имя или телефон" className="h-11 w-72 rounded-xl border border-[#cddde5] bg-white pl-9 pr-3 text-sm text-[#092a42] outline-none focus:border-[#1784a6] focus:ring-4 focus:ring-[#1784a6]/10" />
          </form>
        </header>

        <div className="overflow-hidden rounded-2xl border border-[#dbe8ee] bg-white shadow-sm">
          <div className="hidden grid-cols-[minmax(220px,1.4fr)_1fr_120px_140px_130px] gap-4 border-b border-[#e5edf1] bg-[#f8fbfc] px-5 py-3 text-[11px] font-bold uppercase tracking-[0.11em] text-slate-500 md:grid">
            <span>Клиент</span><span>Источник</span><span>Сделки</span><span>Покупки</span><span>Последняя</span>
          </div>
          {data.items.length === 0 && (
            <div className="p-12 text-center"><UserRound className="mx-auto text-slate-300" size={34} /><p className="mt-3 text-sm font-semibold text-[#17364c]">Клиенты не найдены</p></div>
          )}
          {data.items.map(client => (
            <Link key={client.id} href={`/dashboard/clients/${client.id}`} className="grid gap-3 border-b border-[#eef3f5] px-5 py-4 transition last:border-b-0 hover:bg-[#f7fbfc] md:grid-cols-[minmax(220px,1.4fr)_1fr_120px_140px_130px] md:items-center md:gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#0c2136]">{client.name || 'Без имени'}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">{client.phone || 'Телефон не указан'}</p>
              </div>
              <span className="w-fit rounded-full bg-[#e5f1f5] px-2.5 py-1 text-xs font-semibold text-[#0c5b78]">{client.source || 'не определён'}</span>
              <div><span className="md:hidden text-xs text-slate-400">Сделок: </span><span className="text-sm font-semibold text-[#17364c]">{client.deals_count}</span></div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-[#237354]"><WalletCards size={14} /> {money(client.purchases_total)}</div>
              <span className="text-xs text-slate-500">{client.last_purchase_at ? new Date(client.last_purchase_at).toLocaleDateString('ru-RU') : '—'}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
