'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { getKpiChecklist, toggleKpiChecklistItem, type KpiChecklist } from '@/actions/kpi-checklist'

const MONO = "'IBM Plex Mono', monospace"
const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '22px 24px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

// ─── Самоотметка KPI-пунктов текущего месяца ──────────────────────────────────
// Общий блок для всех индивидуальных экранов декомпозиции (ЛМ, МП, Таргетолог).
// Отметки сразу видны в «Зарплате» — триггер пересчитывает items_bonus.

export function KpiSelfChecklist({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<KpiChecklist | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!employeeId) return
    getKpiChecklist(employeeId).then(setData)
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  if (!data || data.items.length === 0) return null

  const done = data.items.filter(i => i.is_completed).length

  const handleToggle = async (itemId: string, current: boolean) => {
    if (!data.canToggle || busyId) return
    setBusyId(itemId)
    const res = await toggleKpiChecklistItem(employeeId, itemId, !current)
    setBusyId(null)
    if (res.success) load()
    else toast.error(res.error)
  }

  return (
    <section style={{ ...cardStyle, marginTop: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Мои KPI-пункты</h2>
          {data.isClosed && (
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#8a9aa6', background: '#eef2f4', border: '1px solid #dbe3e7', padding: '3px 9px', borderRadius: '999px' }}>месяц закрыт</span>
          )}
        </div>
        <span style={{ fontSize: '12px', color: '#7b8a95' }}>{done} из {data.items.length} выполнено</span>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#6b7d8a' }}>
        {data.isClosed
          ? 'Изменения недоступны — расчёт месяца зафиксирован'
          : 'Отмечайте выполненные пункты в течение месяца — бонус сразу учитывается в зарплате'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {data.items.map(item => (
          <label
            key={item.id}
            onClick={() => void handleToggle(item.id, item.is_completed)}
            style={{
              display: 'flex', alignItems: 'center', gap: '11px',
              background: '#fff', border: '1px solid #e3e9ec', borderRadius: '10px',
              padding: '11px 14px', cursor: data.canToggle ? 'pointer' : 'default',
              opacity: busyId === item.id ? 0.6 : 1,
            }}
          >
            <span style={{
              width: '19px', height: '19px', borderRadius: '6px', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: item.is_completed ? '#0c4d6c' : '#fff',
              border: `1.5px solid ${item.is_completed ? '#0c4d6c' : '#cdd8de'}`,
            }}>
              {item.is_completed && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: '13px', color: item.is_completed ? '#0c2136' : '#5c6f7c', fontWeight: 500 }}>{item.name}</span>
              {item.description && <span style={{ display: 'block', fontSize: '11.5px', color: '#a2b4c0', marginTop: '1px' }}>{item.description}</span>}
            </span>
            <span style={{ fontFamily: MONO, fontSize: '12.5px', color: '#9aa7b0', whiteSpace: 'nowrap' }}>{fmt(item.bonus_amount)} сом</span>
          </label>
        ))}
      </div>
    </section>
  )
}
