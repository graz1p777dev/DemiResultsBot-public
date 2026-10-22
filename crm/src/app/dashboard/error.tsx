'use client'
import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface DashboardErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  useEffect(() => {
    console.error('[Dashboard error]', error)

    const isChunkError = /chunk|failed to fetch dynamically imported module/i.test(error.message)
    const reloadKey = `chunk-reload:${window.location.pathname}`
    if (isChunkError && sessionStorage.getItem(reloadKey) !== '1') {
      sessionStorage.setItem(reloadKey, '1')
      window.location.reload()
      return
    }

    if (!isChunkError) sessionStorage.removeItem(reloadKey)
  }, [error])

  const retry = () => {
    sessionStorage.removeItem(`chunk-reload:${window.location.pathname}`)
    if (/chunk|failed to fetch dynamically imported module/i.test(error.message)) {
      window.location.reload()
      return
    }
    reset()
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-4"
      style={{ height: 'calc(100vh - 52px)' }}
    >
      <div
        className="flex items-center justify-center rounded-full"
        style={{ width: 48, height: 48, backgroundColor: '#fef2f2' }}
      >
        <AlertTriangle style={{ width: 22, height: 22, color: '#dc2626' }} />
      </div>
      <div className="text-center">
        <p className="font-semibold" style={{ fontSize: 15, color: '#0c2136' }}>
          Ошибка загрузки дашборда
        </p>
        <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 4, maxWidth: 320 }}>
          Что-то пошло не так. Попробуйте обновить страницу.
        </p>
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 8 }}>
          Если ошибка повторяется, позвоните в поддержку:{' '}
          <a href="tel:+996000000000" style={{ color: '#0c4d6c', fontWeight: 600 }}>
            0000000000
          </a>
        </p>
      </div>
      <button
        onClick={retry}
        className="flex items-center gap-2 rounded-xl px-4 py-2 font-medium transition-opacity hover:opacity-80"
        style={{
          backgroundColor: '#0c4d6c',
          color: '#ffffff',
          fontSize: 13,
          cursor: 'pointer',
          border: 'none',
        }}
      >
        <RefreshCw style={{ width: 14, height: 14 }} />
        Попробовать снова
      </button>
    </div>
  )
}
