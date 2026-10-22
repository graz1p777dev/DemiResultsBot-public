'use client'
import { useState } from 'react'
import { ShieldCheck, Lock } from 'lucide-react'
import { verifyMiniPassword } from '@/actions/auth'

export default function MiniPasswordForm() {
  const [miniPassword, setMiniPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await verifyMiniPassword(miniPassword)
    if (result && !result.success) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#061d2f] text-white flex items-center justify-center p-6">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_20%_10%,rgba(37,99,235,.24),transparent_34rem),radial-gradient(circle_at_90%_20%,rgba(14,165,233,.18),transparent_32rem)]" />
      <section className="relative w-full max-w-md rounded-[2rem] border border-sky-300/15 bg-[#0b2a42]/88 p-8 shadow-2xl shadow-black/40">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-sky-400/15 text-sky-200">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Мини‑пароль устройства</h1>
            <p className="mt-1 text-sm text-sky-100/65">Дополнительная проверка перед входом в CRM.</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm text-sky-100/70">Мини‑пароль</span>
            <span className="relative block">
              <Lock className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-sky-100/45" />
              <input
                type="password"
                value={miniPassword}
                onChange={e => setMiniPassword(e.target.value)}
                autoFocus
                className="h-12 w-full rounded-2xl border border-sky-200/15 bg-sky-950/45 pl-11 pr-4 text-white outline-none placeholder:text-sky-100/30 focus:border-sky-300/50"
                placeholder="Введите мини‑пароль"
                required
              />
            </span>
          </label>

          {error && (
            <div className="rounded-2xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="h-12 w-full rounded-2xl bg-gradient-to-r from-[#146d96] to-[#2387b8] font-semibold text-white shadow-lg shadow-sky-950/40 disabled:opacity-60"
          >
            {loading ? 'Проверяем…' : 'Войти в CRM'}
          </button>
        </form>

        <p className="mt-5 text-xs leading-relaxed text-sky-100/50">
          Временный мини‑пароль для сотрудников: <span className="font-semibold text-sky-100/80">1234</span>. Владелец входит без мини‑пароля.
        </p>
      </section>
    </main>
  )
}
