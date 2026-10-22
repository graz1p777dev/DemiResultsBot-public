'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Eye, EyeOff, KeyRound, LogOut, MonitorSmartphone, ShieldCheck, Trash2, User } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { updateOwnProfile, changeOwnPassword, getAccountDevices, signOutOtherDevices, updateMiniPassword, type AccountDevice } from '@/actions/auth'
import { deleteOwnAccount } from '@/actions/account'
import { validatePassword } from '@/lib/auth-validation'

interface ProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  const { user, updateUser, signOut } = useAuth()

  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [savingProfile, setSavingProfile] = useState(false)

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deletePhrase, setDeletePhrase] = useState('')
  const [deleting, startDeleteTransition] = useTransition()
  const [devices, setDevices] = useState<AccountDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [kickingDevices, startKickDevicesTransition] = useTransition()
  const [miniPassword, setMiniPassword] = useState('')
  const [miniPasswordConfirm, setMiniPasswordConfirm] = useState('')
  const [savingMiniPassword, setSavingMiniPassword] = useState(false)

  async function loadDevices() {
    setLoadingDevices(true)
    const result = await getAccountDevices()
    setLoadingDevices(false)
    if (result.success) {
      setDevices(result.devices)
    }
  }

  function handleOpenChange(next: boolean) {
    if (next && user) {
      // Синхронизируем поля с актуальным пользователем при каждом открытии
      setName(user.name ?? '')
      setPhone(user.phone ?? '')
      setEmail(user.email ?? '')
      setNewPassword('')
      setConfirmPassword('')
      setDeleteOpen(false)
      setDeletePassword('')
      setDeletePhrase('')
      setMiniPassword('')
      setMiniPasswordConfirm('')
      void loadDevices()
    }
    onOpenChange(next)
  }

  useEffect(() => {
    if (open) void loadDevices()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleDeleteAccount() {
    if (!deletePassword || deletePhrase !== 'my time has come') return
    startDeleteTransition(async () => {
      const result = await deleteOwnAccount(deletePassword, deletePhrase)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      window.location.assign('/auth/login')
    })
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    setSavingProfile(true)
    const result = await updateOwnProfile({ name, phone, email })
    setSavingProfile(false)

    if (result.success) {
      updateUser(result.employee)
      toast.success('Профиль обновлён')
    } else {
      toast.error(result.error)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()

    const pwErr = validatePassword(newPassword)
    if (pwErr) { toast.error(pwErr); return }
    if (newPassword !== confirmPassword) { toast.error('Пароли не совпадают'); return }

    setSavingPassword(true)
    const result = await changeOwnPassword(newPassword)
    setSavingPassword(false)

    if (result.success) {
      toast.success('Пароль изменён')
      setNewPassword('')
      setConfirmPassword('')
    } else {
      toast.error(result.error)
    }
  }

  async function handleMiniPassword(e: React.FormEvent) {
    e.preventDefault()
    setSavingMiniPassword(true)
    const result = await updateMiniPassword(miniPassword, miniPasswordConfirm)
    setSavingMiniPassword(false)
    if (result.success) { toast.success('Мини‑пароль сохранён'); setMiniPassword(''); setMiniPasswordConfirm('') }
    else toast.error(result.error)
  }

  function handleKickDevices() {
    startKickDevicesTransition(async () => {
      const result = await signOutOtherDevices()
      if (result.success) {
        toast.success('Другие сессии завершены')
        void loadDevices()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl glass backdrop-blur-2xl">
        <DialogHeader>
          <DialogTitle>Профиль</DialogTitle>
          <DialogDescription>Личные данные и пароль для входа</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSaveProfile} className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <User size={13} /> Данные
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Имя</Label>
            <Input id="profile-name" value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="profile-phone">Телефон</Label>
              <Input id="profile-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+996 ..." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
          </div>
          <Button type="submit" disabled={savingProfile} className="w-full bg-[#0c4d6c] text-white hover:bg-[#0a3d56] disabled:bg-slate-300">
            {savingProfile ? 'Сохраняем...' : 'Сохранить данные'}
          </Button>
        </form>

        <div className="h-px bg-foreground/10 my-1" />

        {user?.role !== 'owner' && (
          <form onSubmit={handleMiniPassword} className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide"><KeyRound size={13} /> Мини‑пароль устройства</div>
            <div className="grid grid-cols-2 gap-3">
              <Input type="password" value={miniPassword} onChange={e => setMiniPassword(e.target.value)} placeholder="Новый мини‑пароль" minLength={4} maxLength={32} required />
              <Input type="password" value={miniPasswordConfirm} onChange={e => setMiniPasswordConfirm(e.target.value)} placeholder="Повторите мини‑пароль" minLength={4} maxLength={32} required />
            </div>
            <p className="text-[11px] text-muted-foreground">От 4 до 32 символов. Пока не задан — используется временный пароль 1234.</p>
            <Button type="submit" variant="outline" disabled={savingMiniPassword || !miniPassword || !miniPasswordConfirm} className="w-full" style={{ borderColor: '#0c4d6c', color: '#0c4d6c' }}>{savingMiniPassword ? 'Сохраняем...' : 'Сохранить мини‑пароль'}</Button>
          </form>
        )}

        <div className="h-px bg-foreground/10 my-1" />

        <form onSubmit={handleChangePassword} className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <KeyRound size={13} /> Смена пароля
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="profile-new-password">Новый пароль</Label>
              <div className="relative">
                <Input
                  id="profile-new-password"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Мин. 10 символов"
                  className="pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-confirm-password">Подтверждение</Label>
              <Input
                id="profile-confirm-password"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Повторите пароль"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Мин. 10 символов · одна заглавная буква · одна цифра
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={savingPassword || !newPassword || !confirmPassword}
            className="w-full"
            style={{ borderColor: '#0c4d6c', color: '#0c4d6c' }}
          >
            {savingPassword ? 'Сохраняем...' : 'Сменить пароль'}
          </Button>
        </form>

        <div className="h-px bg-foreground/10 my-1" />

        <section className="space-y-3 rounded-2xl border border-sky-300/20 bg-sky-950/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              <ShieldCheck size={13} /> Безопасность
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={kickingDevices}
              onClick={handleKickDevices}
              className="h-8 border-sky-700/40 text-xs text-sky-800 dark:text-sky-100"
            >
              <LogOut className="mr-1.5 size-3.5" />
              {kickingDevices ? 'Завершаем…' : 'Выйти на других устройствах'}
            </Button>
          </div>
          <Button type="button" variant="outline" onClick={async () => { try { const key = 'dr_device_accounts'; const saved = JSON.parse(localStorage.getItem(key) || '[]'); const account = { id: user?.id, name: user?.name || 'Сотрудник', email: user?.email || '' }; localStorage.setItem(key, JSON.stringify([account, ...(Array.isArray(saved) ? saved.filter((item: { id?: string }) => item?.id !== account.id) : [])].filter(item => item.id && item.email).slice(0, 8))) } catch { /* keep logout available */ } await signOut(); window.location.assign('/auth/login?add=1') }} className="w-full border-sky-700/40 text-sky-800 dark:text-sky-100">
            Выйти из текущей сессии
          </Button>
          <p className="text-xs text-muted-foreground">
            CRM показывает последние устройства, где был подтверждён мини‑пароль. Точное завершение одной конкретной сессии зависит от Supabase Auth, поэтому сейчас доступно безопасное завершение всех остальных сессий.
          </p>
          <div className="space-y-2">
            {loadingDevices && <div className="rounded-xl border border-sky-300/20 bg-sky-900/10 p-3 text-sm text-muted-foreground">Загружаем устройства…</div>}
            {!loadingDevices && devices.length === 0 && <div className="rounded-xl border border-sky-300/20 bg-sky-900/10 p-3 text-sm text-muted-foreground">Пока нет записанных входов на устройствах.</div>}
            {devices.map(device => (
              <div key={device.id} className="rounded-xl border border-sky-300/20 bg-sky-900/10 p-3">
                <div className="flex items-start gap-2">
                  <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-200" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900 dark:text-sky-50">
                        {device.user_agent}
                      </p>
                      {device.current && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-200">текущий</span>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      IP: {device.ip} · {new Date(device.created_at).toLocaleString('ru-RU')}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="h-px bg-foreground/10 my-1" />

        <section className="rounded-xl border border-red-400/30 bg-red-950/10 p-3.5">
          <div className="flex gap-2.5"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-700" /><div><p className="text-sm font-semibold text-red-900">Удаление аккаунта</p><p className="mt-0.5 text-xs text-red-700">Доступ будет удалён, а данные прошлых операций сохранятся в архиве.</p></div></div>
          {!deleteOpen ? <Button type="button" variant="outline" className="mt-3 h-8 border-red-300 text-xs text-red-700 hover:bg-red-100" onClick={() => setDeleteOpen(true)}><Trash2 className="mr-1.5 size-3.5" />Удалить мой аккаунт</Button> : <div className="mt-3 space-y-2.5"><Label htmlFor="delete-current-password" className="text-xs text-red-900">Текущий пароль</Label><Input id="delete-current-password" type="password" autoComplete="current-password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} /><Label htmlFor="delete-phrase" className="text-xs text-red-900">Напишите вручную: <code>my time has come</code></Label><Input id="delete-phrase" value={deletePhrase} onChange={e => setDeletePhrase(e.target.value)} onPaste={e => { e.preventDefault(); toast.error('Фразу нужно напечатать вручную.') }} onDrop={e => e.preventDefault()} autoComplete="off" spellCheck={false} /><div className="flex gap-2"><Button type="button" variant="destructive" size="sm" disabled={deleting || !deletePassword || deletePhrase !== 'my time has come'} onClick={handleDeleteAccount}>{deleting ? 'Удаляем…' : 'Удалить навсегда'}</Button><Button type="button" variant="ghost" size="sm" disabled={deleting} onClick={() => { setDeleteOpen(false); setDeletePassword(''); setDeletePhrase('') }}>Отмена</Button></div></div>}
        </section>
      </DialogContent>
    </Dialog>
  )
}
