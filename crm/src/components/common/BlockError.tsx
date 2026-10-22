'use client'
import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface BlockErrorProps {
  error: Error & { digest?: string }
  reset: () => void
  title?: string
}

export default function BlockError({ error, reset, title = 'Ошибка загрузки' }: BlockErrorProps) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-xl p-6"
      style={{
        backgroundColor: '#fff8f8',
        border: '1px solid #fecaca',
        minHeight: 100,
      }}
    >
      <AlertTriangle style={{ width: 20, height: 20, color: '#dc2626' }} />
      <div className="text-center">
        <p className="font-medium" style={{ fontSize: 13, color: '#0c2136' }}>{title}</p>
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
          Что-то пошло не так. Попробуйте ещё раз.
        </p>
        <p style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          Поддержка:{' '}
          <a href="tel:+996000000000" style={{ color: '#0c4d6c', fontWeight: 600 }}>
            0000000000
          </a>
        </p>
      </div>
      <button
        onClick={reset}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors"
        style={{
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          fontSize: 12,
          color: '#dc2626',
          cursor: 'pointer',
        }}
      >
        <RefreshCw style={{ width: 12, height: 12 }} />
        Попробовать снова
      </button>
    </div>
  )
}
