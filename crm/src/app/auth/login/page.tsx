'use client'
import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Eye, EyeOff, Lock, Mail, BarChart3, CalendarDays, DollarSign, Users, UserRound } from 'lucide-react'
import { signIn } from '@/actions/auth'

const features = [
  { icon: CalendarDays, label: 'Записи', desc: 'Управление клиентами' },
  { icon: BarChart3, label: 'KPI', desc: 'План и факт' },
  { icon: DollarSign, label: 'Зарплата', desc: 'Авторасчёт' },
  { icon: Users, label: 'Команда', desc: 'Роли и доступ' },
]

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [savedAccounts, setSavedAccounts] = useState<Array<{ id: string; name: string; email: string }>>([])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const savedEmail = params.get('email')
    setIsAdding(params.get('add') === '1' || params.get('switch') === '1')
    if (savedEmail) setEmail(savedEmail)
    try {
      const accounts = JSON.parse(localStorage.getItem('dr_device_accounts') || '[]')
      if (Array.isArray(accounts)) setSavedAccounts(accounts.filter(item => item?.id && item?.email).slice(0, 8))
    } catch { /* corrupted local device list — keep login form usable */ }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    // При успешном входе signIn выполняет серверный redirect (Set-Cookie + Location одним
    // ответом) → Next.js навигирует на /dashboard (или /auth/change-password) сам, управление
    // сюда не возвращается. Возврат значения означает ошибку входа.
    const result = await signIn(email, password)
    if (result && !result.success) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-gray-950 relative overflow-hidden">
      {/* BG blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-violet-600/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -right-40 w-96 h-96 bg-purple-600/15 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 left-1/3 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl" />
      </div>

      {/* Left — brand */}
      <div className="hidden lg:flex w-[52%] flex-col justify-between p-12 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <span className="text-white text-xs font-bold">DR</span>
          </div>
          <span className="text-white font-semibold text-base">Demi Results CRM</span>
        </div>

        <div>
          <p className="text-violet-400 text-sm font-medium mb-3 tracking-widest uppercase">Умный бизнес</p>
          <h2 className="text-5xl font-bold text-white leading-tight mb-5">
            Всё для вашего<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-purple-400">
              роста
            </span>
          </h2>
          <p className="text-gray-400 text-base leading-relaxed max-w-sm">
            Замените таблицы Excel на профессиональную CRM. Записи, KPI, зарплата и финансы в одном месте.
          </p>

          <div className="grid grid-cols-2 gap-3 mt-10">
            {features.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-3 bg-[#102842] border border-[#244662] rounded-2xl p-4 backdrop-blur-sm hover:bg-[#163653] transition-colors">
                <div className="w-9 h-9 rounded-xl bg-violet-600/30 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-violet-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{label}</p>
                  <p className="text-xs text-gray-500">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-8 mt-10 pt-8 border-t border-white/8">
            {[['100%', 'Данных в одном месте'], ['0', 'Таблиц Excel'], ['24/7', 'Доступ']].map(([n, l]) => (
              <div key={l}>
                <p className="text-2xl font-bold text-white">{n}</p>
                <p className="text-xs text-gray-500 mt-0.5">{l}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-gray-600 text-xs">© 2026 Demi Results. Все права защищены.</p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center p-8 relative z-10">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-10">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">DR</span>
            </div>
            <span className="text-white font-semibold">Demi Results CRM</span>
          </div>

          {/* Card */}
          <div className="bg-[#0d2942] backdrop-blur-xl border border-[#244662] rounded-3xl p-8 shadow-2xl shadow-black/50">
            {isAdding && savedAccounts.length > 0 && (
              <div className="mb-6 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Аккаунты на этом устройстве</p>
                <div className="space-y-2">
                  {savedAccounts.map(account => (
                    <button key={account.id} type="button" onClick={() => setEmail(account.email)} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${email === account.email ? 'border-sky-400/60 bg-sky-400/10' : 'border-[#244662] bg-[#071c2f] hover:bg-[#102f49]'}`}>
                      <span className="flex size-8 items-center justify-center rounded-full bg-sky-500/20 text-sky-200"><UserRound size={15} /></span>
                      <span className="min-w-0"><span className="block truncate text-sm font-semibold text-white">{account.name}</span><span className="block truncate text-xs text-gray-400">{account.email}</span></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <h1 className="text-2xl font-bold text-white mb-1">{isAdding ? 'Добавить аккаунт' : 'Войти в систему'}</h1>
            <p className="text-gray-400 text-sm mb-8">{isAdding ? 'Введите обычный пароль сотрудника для этого устройства' : 'Введите ваши данные для входа'}</p>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="dr-auth-input w-full pl-10 pr-4 h-11 bg-[#071c2f] border border-[#315776] rounded-xl text-sm !text-white placeholder:text-[#8fa8b8] focus:outline-none focus:border-[#38a5d8] focus:bg-[#0a243a] transition-all"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Пароль</Label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type={showPass ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="dr-auth-input w-full pl-10 pr-10 h-11 bg-[#071c2f] border border-[#315776] rounded-xl text-sm !text-white placeholder:text-[#8fa8b8] focus:outline-none focus:border-[#38a5d8] focus:bg-[#0a243a] transition-all"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">
                  <span className="text-base">⚠</span> {error}
                </div>
              )}

              <div className="flex justify-end">
                <a
                  href="/auth/forgot-password"
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Забыли пароль?
                </a>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 bg-gradient-to-r from-violet-600 to-purple-700 hover:from-violet-500 hover:to-purple-600 disabled:opacity-50 text-white font-semibold rounded-xl shadow-lg shadow-purple-900/40 transition-all duration-200 mt-2 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Входим...
                  </>
                ) : 'Войти →'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
