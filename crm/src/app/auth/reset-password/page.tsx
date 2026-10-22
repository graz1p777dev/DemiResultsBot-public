'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { confirmPasswordReset } from '@/actions/auth'
import { validatePassword, passwordStrength } from '@/lib/auth-validation'

// Эта страница открывается ПОСЛЕ /auth/callback, который уже обменял code
// на сессию server-side и поставил cookie. Здесь просто форма смены пароля.

export default function ResetPasswordPage() {
  const router = useRouter()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const pwErr = validatePassword(password)
    if (pwErr) { setError(pwErr); return }
    if (password !== confirm) { setError('Пароли не совпадают'); return }

    setLoading(true)
    const result = await confirmPasswordReset(password)
    setLoading(false)

    if (result.success) {
      setSuccess(true)
      setTimeout(() => router.push('/dashboard'), 2000)
    } else {
      setError(result.error)
    }
  }

  const strength = password.length > 0 ? passwordStrength(password) : null
  const strengthMap = {
    weak:   { label: 'Слабый',  color: '#ef4444', width: '33%' },
    medium: { label: 'Средний', color: '#f59e0b', width: '66%' },
    strong: { label: 'Сильный', color: '#22c55e', width: '100%' },
  }

  if (success) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ backgroundColor: '#0c2136' }}
      >
        <div
          className="w-full max-w-sm rounded-2xl p-8 text-center space-y-3"
          style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
            style={{ backgroundColor: 'rgba(34,197,94,0.15)' }}
          >
            <span style={{ fontSize: 22 }}>✅</span>
          </div>
          <h1 className="text-xl font-bold text-white">Пароль обновлён</h1>
          <p className="text-sm" style={{ color: '#a2b4c0' }}>
            Перенаправляем в личный кабинет...
          </p>
        </div>
      </div>
    )
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
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
          style={{ backgroundColor: 'rgba(12,77,108,0.4)' }}
        >
          <Lock style={{ width: 18, height: 18, color: '#a2b4c0' }} />
        </div>
        <h1 className="text-2xl font-bold text-white mb-1">Новый пароль</h1>
        <p className="text-sm mb-6" style={{ color: '#a2b4c0' }}>
          Придумайте надёжный пароль для вашего аккаунта.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: '#a2b4c0' }}>
              Новый пароль
            </label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                placeholder="Мин. 10 символов"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full pl-4 pr-10 h-11 rounded-xl text-sm text-white placeholder:text-gray-600 focus:outline-none transition-all"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: '#a2b4c0' }}
                tabIndex={-1}
              >
                {showPass
                  ? <EyeOff style={{ width: 15, height: 15 }} />
                  : <Eye style={{ width: 15, height: 15 }} />
                }
              </button>
            </div>

            {strength && (
              <div className="space-y-1 pt-1">
                <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.1)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: strengthMap[strength].width,
                      backgroundColor: strengthMap[strength].color,
                    }}
                  />
                </div>
                <p className="text-[11px]" style={{ color: strengthMap[strength].color }}>
                  {strengthMap[strength].label}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: '#a2b4c0' }}>
              Подтверждение
            </label>
            <input
              type={showPass ? 'text' : 'password'}
              placeholder="Повторите пароль"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              className="w-full px-4 h-11 rounded-xl text-sm text-white placeholder:text-gray-600 focus:outline-none transition-all"
              style={{
                backgroundColor: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            />
          </div>

          <p className="text-[11px]" style={{ color: 'rgba(162,180,192,0.7)' }}>
            Мин. 10 символов, одна заглавная буква, одна цифра.
          </p>

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
            {loading ? 'Сохраняем...' : 'Сохранить пароль'}
          </button>
        </form>
      </div>
    </div>
  )
}
