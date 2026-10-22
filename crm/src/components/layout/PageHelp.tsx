'use client'

import Image from 'next/image'
import Link from 'next/link'
import { CircleHelp, Headphones, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createPortal } from 'react-dom'
import { getPageHelp } from '@/config/page-help'

export default function PageHelp() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const items = getPageHelp(pathname)

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', close)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', close)
    }
  }, [open])

  useEffect(() => { setOpen(false) }, [pathname])

  const drawer = open && typeof document !== 'undefined' ? createPortal(
    <div className="fixed inset-0 z-[80]">
      <button type="button" className="absolute inset-0 cursor-default bg-[#071827]/35 backdrop-blur-[2px]" onClick={() => setOpen(false)} aria-label="Закрыть помощь" />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col bg-[#f5fbfe] shadow-[-18px_0_60px_rgba(7,35,54,0.2)] dark:bg-[#0d2b3d]" role="dialog" aria-modal="true" aria-label="Помощь по текущей странице">
        <div className="flex shrink-0 items-start gap-3 border-b border-[#d8eaf2] bg-white/80 px-5 py-5 dark:border-white/10 dark:bg-white/5">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#ede9fe] text-[#6d28d9] dark:bg-violet-400/15 dark:text-violet-200"><Headphones size={20}/></div>
          <div className="min-w-0 flex-1"><h2 className="text-lg font-bold text-[#0c2136] dark:text-white">Как работать на этой странице</h2><p className="mt-0.5 text-xs leading-relaxed text-[#6f8596] dark:text-slate-300">Короткие подсказки и голосовые объяснения по порядку.</p></div>
          <button type="button" onClick={() => setOpen(false)} className="grid size-9 shrink-0 place-items-center rounded-lg text-[#60798b] hover:bg-[#e7f2f7] dark:text-slate-200 dark:hover:bg-white/10" aria-label="Закрыть"><X size={18}/></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overscroll-contain overflow-y-auto p-4">
          {items.map(item => <article key={item.number} className="overflow-hidden rounded-2xl border border-[#d8eaf2] bg-white p-4 dark:border-white/10 dark:bg-white/[0.06]">
            <div className="flex gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#e0f2fe] text-xs font-bold text-[#075a78] dark:bg-cyan-300/15 dark:text-cyan-100">{item.number}</span>
              <div className="min-w-0"><h3 className="text-sm font-bold text-[#102c42] dark:text-white">{item.title}</h3><p className="mt-1 text-xs leading-relaxed text-[#647b8d] dark:text-slate-300">{item.text}</p></div>
            </div>
            {item.image && <Image src={item.image} alt="Схема карточек клиентов CRM" width={1672} height={941} className="mt-3 h-auto w-full rounded-xl border border-[#d8eaf2]" />}
            <audio controls preload="none" className="mt-3 h-9 w-full" src={item.audio}>Ваш браузер не поддерживает аудио.</audio>
          </article>)}
        </div>

        <div className="shrink-0 border-t border-[#d8eaf2] bg-white/75 p-4 dark:border-white/10 dark:bg-white/5"><Link href="/dashboard/help" onClick={() => setOpen(false)} className="flex h-10 items-center justify-center rounded-xl bg-[#0c5f7e] text-sm font-semibold text-white hover:bg-[#084d68] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Открыть все инструкции</Link></div>
      </aside>
    </div>,
    document.body,
  ) : null

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Помощь по этой странице"
      title="Помощь по этой странице"
      className="flex h-8 items-center gap-1.5 rounded-lg border border-[#cfe2eb] bg-[#edf7fb] px-2.5 text-xs font-semibold text-[#075a78] transition-colors hover:bg-[#dceff6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]/40 dark:border-cyan-300/20 dark:bg-cyan-300/10 dark:text-cyan-100 dark:hover:bg-cyan-300/15"
    >
      <CircleHelp size={16} />
      <span className="hidden lg:inline">Помощь</span>
    </button>

    {drawer}
  </>
}
