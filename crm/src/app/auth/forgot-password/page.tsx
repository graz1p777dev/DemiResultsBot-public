'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Mail, ArrowLeft } from 'lucide-react'
import { requestPasswordReset } from '@/actions/auth'

export default function ForgotPasswordPage() {
  const searchParams = useSearchParams()
  const hasExpiredLink = searchParams.get('error') === 'invalid_code'

  const [email, setEmail]     = useState('')
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState(
    hasExpiredLink ? 'Ссылка истекла или уже использована. Запросите новую.' : ''
  )
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await requestPasswordReset(email)
    setLoading(false)
    if (result.success) {
      setSent(true)
    } else {
      setError(result.error)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: '#0c2136' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8"
        style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        <a
          href="/auth/login"
          className="inline-flex items-center gap-1.5 text-xs mb-6 transition-colors"
          style={{ color: '#a2b4c0' }}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} />
          Назад к входу
        </a>

        {sent ? (
          <div className="text-center space-y-3">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
              style={{ backgroundColor: 'rgba(34,197,94,0.15)' }}
            >
              <span style={{ fontSize: 22 }}>✉️</span>
            </div>
            <h1 className="text-xl font-bold text-white">Письмо отправлено</h1>
            <p className="text-sm" style={{ color: '#a2b4c0' }}>
              Если аккаунт с таким email существует, мы отправили ссылку для сброса пароля.
              Проверьте почту и перейдите по ссылке в письме.
            </p>
            <p className="text-xs" style={{ color: 'rgba(162,180,192,0.6)' }}>
              Письмо может попасть в «Спам».
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-white mb-1">Восстановление пароля</h1>
            <p className="text-sm mb-6" style={{ color: '#a2b4c0' }}>
              Укажите email — пришлём ссылку для сброса пароля.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide" style={{ color: '#a2b4c0' }}>
                  Email
                </label>
                <div className="relative">
                  <Mail
                    className="absolute left-3.5 top-1/2 -translate-y-1/2"
                    style={{ width: 15, height: 15, color: '#a2b4c0' }}
                  />
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    className="dr-auth-input w-full pl-10 pr-4 h-11 rounded-xl text-sm !text-white placeholder:text-[#9ab0bf] focus:outline-none transition-all"
                    style={{
                      backgroundColor: '#071c2f',
                      border: '1px solid #315776',
                      color: '#ffffff',
                      WebkitTextFillColor: '#ffffff',
                    }}
                  />
                </div>
              </div>

              {error && (
                <div
                  className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl"
                  style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}
                >
                  ⚠ {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-xl font-semibold text-sm text-white transition-all"
                style={{ backgroundColor: '#0c4d6c', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Отправляем...' : 'Отправить ссылку'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
