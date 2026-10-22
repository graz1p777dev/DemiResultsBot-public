'use client'
import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { LiveFeedItem } from '@/types'
import { STATUS_AFTER_FV_MAP, ACTUAL_STATUS_MAP, CONSULTATION_STATUS_MAP } from '@/lib/constants'
import { formatTime, formatMoney } from '@/lib/formatters'

interface LiveFeedProps {
  initialItems: LiveFeedItem[]
  dateStr: string
  employeeId?: string
}

function getStatusStyle(status: LiveFeedItem['status']): { label: string; color: string; bg: string } {
  if (!status) return { label: '—', color: '#9ca3af', bg: '#f3f4f6' }
  if (status in STATUS_AFTER_FV_MAP) return STATUS_AFTER_FV_MAP[status as keyof typeof STATUS_AFTER_FV_MAP]
  if (status in ACTUAL_STATUS_MAP) return ACTUAL_STATUS_MAP[status as keyof typeof ACTUAL_STATUS_MAP]
  if (status in CONSULTATION_STATUS_MAP) return CONSULTATION_STATUS_MAP[status as keyof typeof CONSULTATION_STATUS_MAP]
  return { label: status, color: '#9ca3af', bg: '#f3f4f6' }
}

function FeedRow({ item, isNew }: { item: LiveFeedItem; isNew?: boolean }) {
  const style = getStatusStyle(item.status)
  return (
    <div
      className="flex items-start gap-3 py-2.5"
      style={{
        borderBottom: '1px solid #f0f2f4',
        animation: isNew ? 'feedIn 0.2s ease-out' : undefined,
      }}
    >
      {/* Цветная точка */}
      <div
        className="rounded-full flex-shrink-0 mt-1"
        style={{ width: 7, height: 7, backgroundColor: style.color }}
      />
      {/* Данные */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="font-medium truncate"
            style={{ fontSize: 13, color: '#0c2136', maxWidth: 140 }}
          >
            {item.client_name}
          </span>
          <span
            className="rounded-md px-1.5 py-0.5 font-medium flex-shrink-0"
            style={{ fontSize: 10, color: style.color, backgroundColor: style.bg }}
          >
            {style.label}
          </span>
          {item.is_nv && (
            <span
              className="rounded-md px-1.5 py-0.5 font-medium flex-shrink-0"
              style={{ fontSize: 10, color: '#9333ea', backgroundColor: '#f3e8ff' }}
            >
              НВ
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{item.manager_name}</span>
          {item.amount > 0 && (
            <>
              <span style={{ color: '#e5e7eb' }}>·</span>
              <span
                className="tabular-nums font-medium"
                style={{ fontSize: 11, color: '#16a34a' }}
              >
                {formatMoney(item.amount)}
              </span>
            </>
          )}
        </div>
      </div>
      {/* Время */}
      <span
        className="flex-shrink-0 tabular-nums"
        style={{ fontSize: 11, color: '#9ca3af' }}
      >
        {formatTime(item.time)}
      </span>
    </div>
  )
}

export default function LiveFeed({ initialItems, dateStr, employeeId }: LiveFeedProps) {
  const [items, setItems] = useState<LiveFeedItem[]>(initialItems)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Realtime подписка — ОТЛОЖЕННАЯ.
  // WebSocket к Supabase Realtime открывается НЕ на маунте, а после того как браузер
  // простаивает (requestIdleCallback; fallback — setTimeout), то есть вне критического окна
  // загрузки документа. В Firefox открытие Realtime-WS в момент SSR-стриминга/загрузки чанков
  // приводило к зависанию document (NS_BINDING_ABORTED) и застывшим скелетонам; Chrome это
  // прощал. Данные (initialItems) уже отрисованы из SSR — лента видна сразу, WS лишь догоняет
  // real-time обновлениями. Если WS не поднимется — контент это не блокирует.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    let idleHandle: number | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (cancelled) return

      const filter = employeeId
        ? `manager_id=eq.${employeeId}`
        : undefined

      const channelConfig = {
        event: 'INSERT' as const,
        schema: 'public',
        table: 'consultations',
        ...(filter ? { filter } : {}),
      }

      channel = supabase
        .channel('live-feed')
        .on('postgres_changes', channelConfig, (payload) => {
          const newRow = payload.new as Record<string, unknown>
          // Только события за сегодня
          if (newRow.date !== dateStr) return

          const newItem: LiveFeedItem = {
            id: newRow.id as string,
            time: (newRow.time as string | null) ?? '00:00',
            client_name: newRow.client_name as string,
            manager_name: '—',
            status: (newRow.status_after_fv ?? newRow.actual_status ?? newRow.status) as LiveFeedItem['status'],
            amount: Number(newRow.amount) || 0,
            is_nv: Boolean(newRow.is_nv),
          }

          setItems(prev => [newItem, ...prev])
          setNewIds(prev => new Set([...prev, newItem.id]))
          // Убираем анимацию через 500ms
          setTimeout(() => {
            setNewIds(prev => {
              const next = new Set(prev)
              next.delete(newItem.id)
              return next
            })
          }, 500)
        })
        .subscribe()
    }

    // Открываем WS вне окна первичной загрузки.
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(connect, { timeout: 2000 })
    } else {
      timeoutHandle = setTimeout(connect, 1200)
    }

    // Гарантированная очистка: отменяем ещё не сработавшее открытие И закрываем канал,
    // чтобы при навигации/reload в Firefox не накапливались висящие WebSocket-соединения
    // (лимит ~6 на хост).
    return () => {
      cancelled = true
      if (idleHandle !== undefined && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (channel) supabase.removeChannel(channel)
    }
  }, [supabase, dateStr, employeeId])

  if (items.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-xl"
        style={{
          minHeight: 100,
          backgroundColor: 'rgba(255,255,255,0.6)',
          border: '1px dashed #e5e7eb',
        }}
      >
        <p style={{ fontSize: 13, color: '#a2b4c0' }}>Записей на сегодня нет</p>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes feedIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        className="rounded-xl overflow-hidden"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid rgba(0,0,0,0.04)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          maxHeight: 320,
          overflowY: 'auto',
        }}
      >
        <div className="px-4">
          {items.map(item => (
            <FeedRow key={item.id} item={item} isNew={newIds.has(item.id)} />
          ))}
        </div>
      </div>
    </>
  )
}
