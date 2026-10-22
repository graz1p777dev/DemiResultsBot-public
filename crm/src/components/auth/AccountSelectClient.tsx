'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Plus, ShieldCheck, UserRound } from 'lucide-react'
import { signOutForAccountSwitch } from '@/actions/auth'

type Account = { id: string; name: string; email: string }
const STORAGE_KEY = 'dr_device_accounts'

export function AccountSelectClient({ current }: { current: Account }) {
  const router = useRouter()
  const [accounts, setAccounts] = useState<Account[]>([current])
  const [selected, setSelected] = useState(current.id)

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Account[]
      const merged = [current, ...saved.filter(item => item?.id && item.id !== current.id)]
      setAccounts(merged.slice(0, 8))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged.slice(0, 8)))
    } catch {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([current]))
    }
  }, [current])

  function continueWithSelected() {
    if (selected !== current.id) {
      const account = accounts.find(item => item.id === selected)
      router.push(`/auth/login?email=${encodeURIComponent(account?.email || '')}&switch=1`)
      return
    }
    router.push('/auth/mini-password')
  }

  return (
    <main className="min-h-screen bg-[#061d2f] text-white flex items-center justify-center p-6">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_8%,rgba(37,99,235,.25),transparent_34rem),radial-gradient(circle_at_90%_30%,rgba(14,165,233,.16),transparent_32rem)]" />
      <section className="relative w-full max-w-lg rounded-[2rem] border border-sky-300/15 bg-[#0b2a42]/90 p-8 shadow-2xl shadow-black/40">
        <div className="mb-7 flex items-center gap-3"><div className="flex size-12 items-center justify-center rounded-2xl bg-sky-400/15 text-sky-200"><ShieldCheck size={24} /></div><div><h1 className="text-2xl font-bold">Выберите аккаунт</h1><p className="mt-1 text-sm text-sky-100/65">Это устройство запомнило входы сотрудников.</p></div></div>
        <div className="space-y-3">
          {accounts.map(account => <button key={account.id} type="button" onClick={() => setSelected(account.id)} className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition ${selected === account.id ? 'border-sky-300/60 bg-sky-400/15' : 'border-sky-200/10 bg-sky-950/25 hover:bg-sky-900/35'}`}><span className="flex size-11 items-center justify-center rounded-full bg-sky-500/20 text-sky-100"><UserRound size={20} /></span><span className="min-w-0 flex-1"><span className="block font-semibold">{account.name}</span><span className="block truncate text-sm text-sky-100/55">{account.email}</span></span>{selected === account.id && <span className="text-xs text-sky-200">выбран</span>}</button>)}
        </div>
        <button type="button" onClick={continueWithSelected} className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#146d96] to-[#2387b8] font-semibold shadow-lg shadow-sky-950/40">Продолжить <ArrowRight size={17} /></button>
        <button type="button" onClick={() => signOutForAccountSwitch()} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-sky-200/15 text-sm text-sky-100/75 hover:bg-sky-900/30"><Plus size={17} /> Добавить аккаунт</button>
        <p className="mt-5 text-xs leading-relaxed text-sky-100/50">Текущий аккаунт подтверждается мини‑паролем. Для другого сотрудника потребуется его обычный защищённый вход.</p>
      </section>
    </main>
  )
}
