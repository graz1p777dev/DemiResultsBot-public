'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitMerge, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { botGet, botJson } from '@/lib/bot-api'

type Candidate = { id: number; name: string | null; phone: string | null; external_id: string }

export default function MergeClientButton({ clientId }: { clientId: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [merging, setMerging] = useState<number | null>(null)

  useEffect(() => {
    if (!open || query.trim().length < 2) { setItems([]); return }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const result = await botGet<{ items: Candidate[] }>(`/admin/clients?q=${encodeURIComponent(query.trim())}&limit=20`)
        setItems(result.items.filter(item => item.id !== clientId))
      } catch { setItems([]) } finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(timer)
  }, [clientId, open, query])

  const merge = async (target: Candidate) => {
    if (!confirm(`Объединить текущую карточку с «${target.name || target.phone || `#${target.id}`}»? Все сделки и переписка перейдут в выбранную карточку.`)) return
    setMerging(target.id)
    try {
      await botJson(`/admin/clients/${clientId}/merge`, 'POST', { target_client_id: target.id })
      toast.success('Карточки объединены')
      router.replace(`/dashboard/clients/${target.id}`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось объединить карточки')
    } finally { setMerging(null) }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-[#cddde5] bg-white px-3 py-2 text-xs font-semibold text-[#0c5b78] hover:bg-[#f3f8fa]"><GitMerge size={14} /> Объединить дубль</button>
      {open && <div className="fixed inset-0 z-[70] grid place-items-center bg-[#0c2136]/45 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
        <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-[#e5edf1] px-5 py-4"><div><h2 className="font-semibold text-[#0c2136]">Объединение клиента</h2><p className="mt-0.5 text-xs text-slate-500">Найдите карточку, которую нужно оставить основной</p></div><button onClick={() => setOpen(false)}><X size={18} className="text-slate-400" /></button></div>
          <div className="p-5">
            <div className="flex items-center gap-2 rounded-xl border border-[#cddde5] px-3"><Search size={15} className="text-slate-400" /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Имя или телефон" className="h-11 flex-1 bg-transparent text-sm outline-none" /></div>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-[#e5edf1]">
              {loading && <p className="p-4 text-sm text-slate-500">Поиск...</p>}
              {!loading && query.trim().length < 2 && <p className="p-4 text-sm text-slate-500">Введите минимум 2 символа.</p>}
              {!loading && query.trim().length >= 2 && items.length === 0 && <p className="p-4 text-sm text-slate-500">Другие карточки не найдены.</p>}
              {items.map(item => <button key={item.id} disabled={merging !== null} onClick={() => void merge(item)} className="flex w-full items-center justify-between border-b border-[#eef3f5] p-4 text-left last:border-0 hover:bg-[#f7fbfc] disabled:opacity-50"><span><span className="block text-sm font-semibold text-[#17364c]">{item.name || 'Без имени'} · #{item.id}</span><span className="mt-0.5 block text-xs text-slate-500">{item.phone || 'Телефон не указан'}</span></span><span className="text-xs font-semibold text-[#0c5b78]">{merging === item.id ? 'Объединение...' : 'Выбрать'}</span></button>)}
            </div>
            <p className="mt-3 text-xs leading-5 text-amber-700">Операция сохраняется в журнале аудита. Исходная карточка удаляется только после переноса её лидов, истории и памяти клиента.</p>
          </div>
        </div>
      </div>}
    </>
  )
}
