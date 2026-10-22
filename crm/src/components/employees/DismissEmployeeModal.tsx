'use client'

// Увольнение с указанием причины. Отдельная модалка вместо window.confirm:
// причина — кадровые данные, которые потом видно в досье уволенного, и вводить
// её через prompt() неудобно. Причина необязательна — не блокируем действие.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { UserMinus } from 'lucide-react'

const SUGGESTIONS = [
  'По собственному желанию',
  'Соглашение сторон',
  'Не прошёл испытательный срок',
  'Нарушение дисциплины',
] as const

export function DismissEmployeeModal({ employeeName, isPending, onConfirm, onClose }: {
  employeeName: string
  isPending: boolean
  onConfirm: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(12,33,54,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget && !isPending) onClose() }}
    >
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: '#ffffff', maxHeight: '90vh' }}
        role="dialog"
        aria-modal="true"
        aria-label={`Увольнение сотрудника ${employeeName}`}
      >
        <div
          className="flex items-center gap-3 px-6 py-4 shrink-0"
          style={{ background: 'linear-gradient(135deg, #0c4d6c 0%, #0c2136 100%)' }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
          >
            <UserMinus size={18} color="#ffffff" />
          </div>
          <div className="min-w-0">
            <h2 className="text-white font-semibold text-base">Увольнение сотрудника</h2>
            <p className="text-xs truncate" style={{ color: '#a2b4c0' }}>{employeeName}</p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-3">
          <p className="text-sm" style={{ color: '#0c2136' }}>
            Сотрудник переедет в архив и потеряет доступ к системе. Его данные и история сохранятся —
            при необходимости увольнение можно отменить кнопкой «Восстановить».
          </p>

          <div className="space-y-1">
            <Label className="text-xs font-semibold text-gray-500">
              Причина увольнения <span style={{ color: '#a2b4c0' }}>· необязательно</span>
            </Label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              autoFocus
              placeholder="Например: по собственному желанию"
              // Фокус-рамка задана явно фирменным #0c4d6c: дефолтное кольцо темы —
              // фиолетовое, а violet/purple в палитре Demi Results запрещены.
              className="w-full min-w-0 rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none"
              style={{ color: '#0c2136', borderColor: '#ebebee' }}
              onFocus={e => { e.currentTarget.style.borderColor = '#0c4d6c' }}
              onBlur={e => { e.currentTarget.style.borderColor = '#ebebee' }}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setReason(s)}
                disabled={isPending}
                className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
                style={{ backgroundColor: '#e6ebee', color: '#0c4d6c' }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div
          className="flex items-center justify-end gap-2 px-6 py-4 shrink-0"
          style={{ borderTop: '1px solid #ebebee' }}
        >
          <Button variant="ghost" size="sm" className="rounded-lg" onClick={onClose} disabled={isPending}>
            Отмена
          </Button>
          <Button
            size="sm"
            className="rounded-lg text-white"
            style={{ backgroundColor: '#b91c1c' }}
            onClick={() => onConfirm(reason)}
            disabled={isPending}
          >
            <UserMinus size={14} className="mr-1.5" />
            {isPending ? 'Увольнение…' : 'Уволить'}
          </Button>
        </div>
      </div>
    </div>
  )
}
