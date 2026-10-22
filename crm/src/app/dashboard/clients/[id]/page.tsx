import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Bot, ChevronLeft, Headset, MessageSquare, Phone, ShoppingBag, UserRound } from 'lucide-react'
import { getActor } from '@/lib/authz'
import { getCrmClient } from '@/actions/crm-clients'
import MergeClientButton from './MergeClientButton'

export const dynamic = 'force-dynamic'

function money(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value) + ' сом'
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor()
  if (!actor) redirect('/auth/login')
  if (!['owner', 'rop', 'mp', 'lmai'].includes(actor.role)) redirect('/dashboard')
  const { id } = await params
  const client = await getCrmClient(Number(id))
  if (!client) notFound()

  const wonDeals = client.deals.filter(deal => deal.status === 'won')
  const total = wonDeals.reduce((sum, deal) => sum + Number(deal.amount ?? 0), 0)
  const latestPurchase = wonDeals
    .map(deal => deal.sale_at || deal.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1)

  return (
    <div className="min-h-[calc(100vh-52px)] bg-[#f4f8fa] p-4 md:p-7">
      <div className="mx-auto max-w-7xl">
        <Link href="/dashboard/clients" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-[#0c5b78]"><ChevronLeft size={15} /> Все клиенты</Link>
        <header className="mb-5 rounded-2xl border border-[#dbe8ee] bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#dcecf3] text-[#0c5b78]"><UserRound size={23} /></div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#78909f]">Карточка клиента #{client.id}</p>
                <h1 className="mt-1 text-2xl font-bold text-[#092a42]">{client.name || 'Без имени'}</h1>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5"><Phone size={14} /> {client.phone || 'Телефон не указан'}</span>
                  <span>Источник: {client.source || 'не определён'}</span>
                  <span>Создан: {new Date(client.created_at).toLocaleDateString('ru-RU')}</span>
                </div>
                {(actor.role === 'owner' || actor.role === 'rop') && <div className="mt-3"><MergeClientButton clientId={client.id} /></div>}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-[#f3f7f9] px-4 py-3"><p className="text-[10px] uppercase text-slate-400">Сделок</p><p className="mt-1 text-lg font-bold text-[#17364c]">{client.deals.length}</p></div>
              <div className="rounded-xl bg-[#eef8f3] px-4 py-3"><p className="text-[10px] uppercase text-[#55917a]">Покупок</p><p className="mt-1 text-lg font-bold text-[#237354]">{wonDeals.length}</p></div>
              <div className="rounded-xl bg-[#eef8f3] px-4 py-3"><p className="text-[10px] uppercase text-[#55917a]">Сумма</p><p className="mt-1 whitespace-nowrap text-lg font-bold text-[#237354]">{money(total)}</p></div>
            </div>
          </div>
          {latestPurchase && <p className="mt-4 border-t border-[#eef3f5] pt-3 text-xs text-slate-500">Последняя покупка: {new Date(latestPurchase).toLocaleDateString('ru-RU')}</p>}
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <section className="overflow-hidden rounded-2xl border border-[#dbe8ee] bg-white">
            <div className="flex items-center gap-2 border-b border-[#e5edf1] px-5 py-4"><ShoppingBag size={17} className="text-[#0c5b78]" /><h2 className="font-semibold text-[#0c2136]">Сделки клиента</h2></div>
            {client.deals.length === 0 ? <p className="p-6 text-sm text-slate-500">Сделок пока нет.</p> : client.deals.map(deal => (
              <div key={deal.id} className="grid grid-cols-[1fr_auto] gap-3 border-b border-[#eef3f5] px-5 py-4 last:border-b-0">
                <div><p className="text-sm font-semibold text-[#17364c]">{deal.title}</p><p className="mt-1 text-xs text-slate-500">{new Date(deal.created_at).toLocaleString('ru-RU')} · {deal.source}</p></div>
                <div className="text-right"><p className="text-sm font-bold text-[#0c5b78]">{money(Number(deal.amount ?? 0))}</p><p className={`mt-1 text-[10px] font-bold uppercase ${deal.status === 'won' ? 'text-[#237354]' : deal.status === 'lost' ? 'text-red-600' : 'text-amber-600'}`}>{deal.status === 'won' ? 'Продажа' : deal.status === 'lost' ? 'Отказ' : 'В работе'}</p></div>
              </div>
            ))}
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#dbe8ee] bg-white">
            <div className="flex items-center justify-between border-b border-[#e5edf1] px-5 py-4"><div className="flex items-center gap-2"><MessageSquare size={17} className="text-[#0c5b78]" /><h2 className="font-semibold text-[#0c2136]">Переписка и активность</h2></div>{client.leads[0] && <Link href={`/dashboard/dialogs?lead=${client.leads[0].amocrm_lead_id}`} className="text-xs font-semibold text-[#0c5b78]">Открыть Inbox</Link>}</div>
            <div className="max-h-[650px] overflow-y-auto p-4">
              {client.messages.length === 0 && <p className="p-2 text-sm text-slate-500">Сообщений пока нет.</p>}
              <div className="space-y-3">
                {client.messages.map(message => {
                  const isClient = message.role === 'user'
                  const isManager = message.role === 'manager'
                  return (
                    <div key={message.id} className={`flex ${isClient ? 'justify-start' : 'justify-end'}`}>
                      <div className="max-w-[88%]">
                        <p className={`mb-1 flex items-center gap-1 text-[10px] ${isClient ? 'text-slate-500' : isManager ? 'justify-end text-[#237354]' : 'justify-end text-[#0c5b78]'}`}>
                          {isClient ? <><UserRound size={10} /> Клиент</> : isManager ? <><Headset size={10} /> Менеджер</> : <><Bot size={10} /> AI</>} · {new Date(message.created_at).toLocaleString('ru-RU')}
                        </p>
                        <div className={`rounded-2xl px-3 py-2 text-sm leading-5 ${isClient ? 'border border-[#dbe8ee] bg-white text-[#17364c]' : isManager ? 'bg-[#e7f5ed] text-[#1d5b43]' : 'bg-[#0c4d6c] text-white'}`}>{message.text}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
