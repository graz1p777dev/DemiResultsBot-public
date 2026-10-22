'use client'

import { useEffect, useState } from 'react'
import { Trophy } from 'lucide-react'
import { botGet } from '@/lib/bot-api'
import { getRewardEligibleEmployees, type RewardEmployee } from '@/actions/bot-rewards'

type Row = { manager_id: string; approved: number; rejected: number; rejected_with_reason: number; edited: number; manual: number; saved: number; points: number }
type RankedRow = Row & { employee: RewardEmployee }

const medals = ['🥇', '🥈', '🥉']

export default function TopConfirmers() {
  const [rows, setRows] = useState<RankedRow[]>([])
  useEffect(() => {
    Promise.all([botGet<Row[]>('/admin/analytics/managers'), getRewardEligibleEmployees()])
      .then(([activity, employees]) => {
        const findEmployee = (managerId: string) => {
          if (managerId.startsWith('crm-id:')) return employees.find(employee => employee.id === managerId.slice(7))
          const alias = managerId.replace(/^crm:/, '').trim().toLocaleLowerCase('ru-RU')
          return employees.find(employee =>
            employee.name.trim().toLocaleLowerCase('ru-RU') === alias ||
            employee.email.split('@')[0].toLocaleLowerCase('ru-RU') === alias
          )
        }
        const mergedByEmployee = new Map<string, RankedRow>()

        activity
          .map(row => ({ ...row, employee: findEmployee(row.manager_id) }))
          .filter((row): row is RankedRow => Boolean(row.employee))
          .forEach(row => {
            const current = mergedByEmployee.get(row.employee.id)
            mergedByEmployee.set(row.employee.id, current ? {
              ...current,
              approved: current.approved + row.approved,
              rejected: current.rejected + row.rejected,
              rejected_with_reason: current.rejected_with_reason + row.rejected_with_reason,
              edited: current.edited + row.edited,
              manual: current.manual + row.manual,
              saved: current.saved + row.saved,
              points: current.points + row.points,
            } : row)
          })

        setRows(Array.from(mergedByEmployee.values())
          .sort((a, b) => b.points - a.points)
          .slice(0, 3))
      })
      .catch(() => setRows([]))
  }, [])
  return <section className="mx-6 mb-5 rounded-2xl bg-white p-4 shadow-sm">
    <div className="mb-3 flex items-center gap-2"><Trophy size={16} className="text-amber-500" /><h2 className="text-sm font-bold text-[#0c2136]">Лучшие сотрудники</h2><span className="text-[11px] text-slate-400">баллы за работу с ответами ИИ</span></div>
    <div className="grid gap-2 sm:grid-cols-3">{rows.map((row, index) => { const name = row.employee.name; const initials = name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); return <div key={row.employee.id} className="flex items-center gap-2 rounded-xl bg-[#f5f8fa] p-2.5" title={`Принято: ${row.approved} · С причиной: ${row.rejected_with_reason} · Изменено: ${row.edited} · Вручную: ${row.manual}`}><span className="text-xl">{medals[index]}</span><span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#075a78] text-[10px] font-bold text-white">{initials}</span><span className="min-w-0"><b className="block truncate text-xs text-[#0c2136]">{name}</b><small className="text-[11px] font-semibold text-[#1784a6]">{row.points.toLocaleString('ru-RU')} баллов</small></span></div> })}</div>
    {!rows.length && <p className="text-xs text-slate-400">У действующих сотрудников пока нет начисленных баллов.</p>}
    <p className="mt-3 text-[10px] text-slate-400">Принять +2 · отклонить +1 · объяснить причину +4 · ответить вручную +8 · улучшить ответ ИИ +10</p>
  </section>
}
