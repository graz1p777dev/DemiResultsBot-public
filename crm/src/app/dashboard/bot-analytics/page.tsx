'use client'

import { useEffect, useState } from 'react'
import { Bot, CalendarCheck2, CheckCircle2, Coins, MessageSquareText, Users } from 'lucide-react'
import { botGet } from '@/lib/bot-api'

type Analytics = {
  hourly: { hour: number; count: number }[]
  daily: { date: string; count: number }[]
  top_problems: { problem: string; count: number }[]
  usage_by_purpose: {
    purpose: string; prompt_tokens: number; completion_tokens: number
    total_tokens: number; total_cost: number; calls: number
  }[]
  usage_by_provider: {
    provider: string; prompt_tokens: number; completion_tokens: number
    total_tokens: number; total_cost: number; calls: number
  }[]
  stats: {
    total_leads: number; total_messages: number; total_approvals: number
    approved: number; approved_as_is: number; rejected: number
    consultation_confirmed: number
    prompt_tokens: number; completion_tokens: number; total_tokens: number; total_cost: number
  }
}

type TokenStat = { tokens: number; cost: number }
type TokenStats = { today: TokenStat; avg_day: TokenStat; avg_month: TokenStat; year: TokenStat; all_time: TokenStat }
type SalesAnalytics = {
  deals: number; won: number; lost: number; open: number; revenue: number
  ai_assisted_won: number; ai_assisted_revenue: number
  by_source: { source: string; deals: number; won: number; revenue: number }[]
  by_loss_reason?: { reason: string; count: number }[]
  by_manager?: { manager_id: string | null; manager: string; deals: number; won: number; revenue: number }[]
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#dce7ec] bg-white p-5 shadow-[0_8px_28px_rgba(12,33,54,0.04)]">
      <h2 className="mb-4 text-sm font-semibold text-[#0c2136]">{title}</h2>
      {children}
    </section>
  )
}

export default function BotAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null)
  const [tokens, setTokens] = useState<TokenStats | null>(null)
  const [sales, setSales] = useState<SalesAnalytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.allSettled([
      botGet<Analytics>('/admin/analytics'),
      botGet<TokenStats>('/admin/analytics/tokens'),
      fetch('/api/crm/sales-analytics', { cache: 'no-store' }).then(async response => {
        if (!response.ok) throw new Error('sales analytics unavailable')
        return response.json() as Promise<SalesAnalytics>
      }),
    ]).then(([a, t, s]) => {
      if (a.status === 'fulfilled') setData(a.value)
      if (t.status === 'fulfilled') setTokens(t.value)
      if (s.status === 'fulfilled') setSales(s.value)
      setLoading(false)
    })
  }, [])

  if (loading) return <p className="p-8 text-sm" style={{ color: '#8a97a5' }}>Загрузка аналитики...</p>
  if (!data) return <p className="p-8 text-sm" style={{ color: '#8a97a5' }}>Нет данных (бот-бэкенд недоступен)</p>

  const statCards = [
    { label: 'Клиенты в работе', value: data.stats.total_leads, icon: Users },
    { label: 'Сообщения', value: data.stats.total_messages, icon: MessageSquareText },
    { label: 'Ответы ИИ', value: data.stats.total_approvals, icon: Bot },
    { label: 'Записи на консультацию', value: data.stats.consultation_confirmed, icon: CalendarCheck2 },
  ]

  const maxProblem = Math.max(...data.top_problems.map(p => p.count), 1)
  const maxHour = Math.max(...data.hourly.map(h => h.count), 1)
  const decisions = data.stats.approved + data.stats.rejected
  const approvalRate = decisions ? Math.round(data.stats.approved / decisions * 100) : 0
  const conversion = sales?.deals ? Math.round((sales.won / sales.deals) * 100) : 0

  return (
    <main data-dark-blue-surfaces className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 p-4 md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1784a6]">Контроль качества и продаж</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-[#0c2136]">Аналитика ИИ-бота</h1><p className="mt-1 text-sm text-[#718493]">Результаты диалогов, решений менеджеров и расходов модели</p></div>
        <span className="rounded-lg border border-[#dce7ec] bg-white px-3 py-2 text-xs font-medium text-[#526a79]">Данные на текущий момент</span>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map(item => <section key={item.label} className="rounded-2xl border border-[#dce7ec] bg-white p-4 shadow-[0_8px_24px_rgba(12,33,54,0.035)]"><div className="flex items-start justify-between"><div><p className="text-xs font-medium text-[#718493]">{item.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-[#0c2136]">{item.value.toLocaleString('ru-RU')}</p></div><span className="grid size-9 place-items-center rounded-xl bg-[#eaf4f8] text-[#0c6b8a]"><item.icon size={17}/></span></div></section>)}
      </div>

      {sales && <section className="grid gap-5 rounded-2xl bg-[#0c2136] p-5 text-white shadow-[0_18px_50px_rgba(12,33,54,0.16)] lg:grid-cols-[1.2fr_2fr]">
        <div><p className="text-xs font-medium text-[#9fb7c6]">Выручка за текущий месяц</p><p className="mt-2 text-3xl font-semibold tabular-nums">{sales.revenue.toLocaleString('ru-RU')} <span className="text-base font-medium text-[#9fb7c6]">сом</span></p><p className="mt-3 text-xs text-[#9fb7c6]">С участием ИИ: {sales.ai_assisted_revenue.toLocaleString('ru-RU')} сом</p></div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/10 sm:grid-cols-4">{[
          ['Все сделки', sales.deals], ['В работе', sales.open], ['Успешные', sales.won], ['Конверсия', `${conversion}%`],
        ].map(([label, value]) => <div key={label} className="bg-[#112c43] p-4"><p className="text-lg font-semibold tabular-nums">{typeof value === 'number' ? value.toLocaleString('ru-RU') : value}</p><p className="mt-1 text-[11px] text-[#9fb7c6]">{label}</p></div>)}</div>
      </section>}

      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <Card title="Качество ответов ИИ">
          <div className="flex items-end justify-between"><div><p className="text-3xl font-semibold tabular-nums text-[#0c2136]">{approvalRate}%</p><p className="mt-1 text-xs text-[#718493]">доля принятых ответов</p></div><CheckCircle2 size={24} className="text-[#16805f]"/></div>
          <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-[#edf2f4]"><span className="bg-[#16805f]" style={{ width: `${approvalRate}%` }}/><span className="flex-1 bg-[#d65b5b]"/></div>
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-[#edf2f4] pt-4">{[['Принято', data.stats.approved], ['Без правок', data.stats.approved_as_is], ['Отклонено', data.stats.rejected]].map(([label, value]) => <div key={label}><dt className="text-[11px] text-[#718493]">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-[#0c2136]">{Number(value).toLocaleString('ru-RU')}</dd></div>)}</dl>
        </Card>
        <Card title="Активность клиентов по часам">
          <div className="flex h-36 items-end gap-1 border-b border-[#dce7ec] pt-4">
            {data.hourly.map(h => (
              <div key={h.hour} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h.hour}:00 — ${h.count} сообщ.`}>
                <div className="w-full rounded-t-sm" style={{
                  height: `${Math.max((h.count / maxHour) * 100, 2)}%`,
                  backgroundColor: '#0c6b8a', opacity: h.count > 0 ? 0.9 : 0.12,
                }} />
                {h.hour % 6 === 0 && <span className="mt-1 text-[9px] text-[#9aabb5]">{h.hour}:00</span>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Проблемы клиентов">
          {data.top_problems.length === 0 && <p className="text-sm text-[#718493]">Нет данных</p>}
          <div className="flex flex-col gap-2.5">
            {data.top_problems.slice(0, 8).map(p => (
              <div key={p.problem}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-[#0c2136]">{p.problem}</span><span className="tabular-nums text-[#718493]">{p.count}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#edf2f4]">
                  <div className="h-full rounded-full bg-[#0c6b8a]" style={{ width: `${(p.count / maxProblem) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
        {tokens && <Card title="Использование моделей">
          <div className="mb-4 flex items-center gap-2 text-[#0c6b8a]"><Coins size={18}/><span className="text-xs font-medium">Все AI-провайдеры</span></div>
          <div className="grid grid-cols-3 gap-3">{[
            ['Сегодня', tokens.today], ['30 дней', tokens.avg_month], ['Всё время', tokens.all_time],
          ].map(([label, value]) => { const stat = value as TokenStat; return <div key={label as string} className="border-l-2 border-[#dce7ec] pl-3"><p className="text-sm font-semibold tabular-nums text-[#0c2136]">{stat.tokens.toLocaleString('ru-RU')}</p><p className="text-[10px] text-[#718493]">токенов · ${stat.cost.toFixed(stat.cost >= 1 ? 2 : 4)}</p><p className="mt-1 text-[10px] font-medium text-[#526a79]">{label as string}</p></div> })}</div>
          <div className="mt-5 divide-y divide-[#edf2f4] border-t border-[#edf2f4] pt-2">
            {(data.usage_by_provider ?? []).map(provider => (
              <div key={provider.provider} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-2.5 text-xs">
                <div><p className="font-semibold text-[#0c2136]">{provider.provider === 'deepseek' ? 'DeepSeek' : provider.provider === 'openai' ? 'OpenAI' : provider.provider === 'google' ? 'Google Gemini' : provider.provider}</p><p className="mt-0.5 text-[10px] text-[#718493]">{provider.calls.toLocaleString('ru-RU')} запросов</p></div>
                <span className="tabular-nums text-[#526a79]">{provider.total_tokens.toLocaleString('ru-RU')} токенов</span>
                <span className="min-w-16 text-right font-semibold tabular-nums text-[#0c6b8a]">${provider.total_cost.toFixed(provider.total_cost >= 1 ? 2 : 4)}</span>
              </div>
            ))}
          </div>
        </Card>}
      </div>

      {sales?.by_loss_reason && sales.by_loss_reason.length > 0 && (
        <Card title="Причины отказов · CRM">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{sales.by_loss_reason.map(item => <div key={item.reason} className="flex items-center justify-between rounded-lg border border-[#edf2f4] px-3 py-2 text-xs"><span className="text-[#526a79]">{item.reason}</span><b className="tabular-nums text-[#0c2136]">{item.count}</b></div>)}</div>
        </Card>
      )}
      {sales?.by_manager && sales.by_manager.length > 0 && (
        <Card title="Продажи по менеджерам · CRM">
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-100 text-left text-xs text-slate-400"><th className="py-2">Менеджер</th><th className="py-2 text-right">Сделки</th><th className="py-2 text-right">Продажи</th><th className="py-2 text-right">Выручка</th></tr></thead><tbody>{sales.by_manager.map(item => <tr key={item.manager_id ?? 'unassigned'} className="border-b border-slate-50"><td className="py-2 font-medium text-[#0c2136]">{item.manager}</td><td className="py-2 text-right">{item.deals}</td><td className="py-2 text-right">{item.won}</td><td className="py-2 text-right font-semibold">{item.revenue.toLocaleString('ru-RU')} сом</td></tr>)}</tbody></table></div>
        </Card>
      )}

      <Card title="Расход токенов по задачам ИИ">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr className="text-xs uppercase" style={{ color: '#8a97a5' }}>
                <th className="text-left py-2 pr-3 font-medium">Задача</th>
                <th className="text-right py-2 px-3 font-medium">Вызовов</th>
                <th className="text-right py-2 px-3 font-medium">Токенов</th>
                <th className="text-right py-2 pl-3 font-medium">Стоимость</th>
              </tr>
            </thead>
            <tbody>
              {data.usage_by_purpose.map(u => (
                <tr key={u.purpose} style={{ borderTop: '1px solid #f1f2f4' }}>
                  <td className="py-2 pr-3" style={{ color: '#0c2136' }}>{u.purpose}</td>
                  <td className="py-2 px-3 text-right" style={{ color: '#8a97a5' }}>{u.calls.toLocaleString('ru-RU')}</td>
                  <td className="py-2 px-3 text-right" style={{ color: '#0c2136' }}>{u.total_tokens.toLocaleString('ru-RU')}</td>
                  <td className="py-2 pl-3 text-right font-medium text-[#0c6b8a]">${u.total_cost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  )
}
