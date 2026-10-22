'use client'

// Раздел «Управление → Партнёры» — справочник партнёров (как «Сотрудники»).
// Заведение/редактирование/деактивация здесь; в декомпозиции — только аналитика.

import { useEffect, useState, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import { Plus, Search, Handshake } from 'lucide-react'
import {
  getPartnersPageData, savePartner, savePartnerType, deletePartnerType,
  type PartnersPageData,
} from '@/actions/partners'
import type { Partner } from '@/types'
import PartnerModal from '@/components/partners/PartnerModal'

const INK = '#0c2136', ACCENT = '#0c4d6c', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const box: React.CSSProperties = {
  padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px',
  background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit',
}

export default function PartnersPage() {
  const [data, setData] = useState<PartnersPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [search, setSearch] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partner | null>(null)
  const [, startAction] = useTransition()

  useEffect(() => {
    let cancelled = false
    getPartnersPageData().then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [reloadKey])

  const reload = () => setReloadKey(k => k + 1)
  const partners = useMemo(() => data?.partners ?? [], [data])
  const types = data?.types ?? []
  const canEdit = data?.canEdit ?? false

  const shown = useMemo(() => partners.filter(p =>
    (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
    (!fType || p.type === fType) &&
    (!fStatus || p.status === fStatus)
  ), [partners, search, fType, fStatus])

  const addType = async (name: string): Promise<boolean> => {
    const res = await savePartnerType(null, name)
    if (res.success) { toast.success('Тип добавлен'); reload(); return true }
    toast.error(res.error); return false
  }
  const toggleStatus = (p: Partner) => startAction(async () => {
    const res = await savePartner(p.id, { name: p.name, type: p.type, terms: p.terms, contact: p.contact, status: p.status === 'active' ? 'inactive' : 'active' })
    if (res.success) { toast.success(p.status === 'active' ? 'Деактивирован' : 'Активирован'); reload() }
    else toast.error(res.error)
  })
  const removeType = (id: string) => startAction(async () => {
    const res = await deletePartnerType(id)
    if (res.success) { toast.success('Тип удалён'); reload() } else toast.error(res.error)
  })

  if (loading) return <div style={{ padding: '40px', color: MUTE, fontFamily: "'Golos Text', sans-serif" }}>Загрузка…</div>
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел «Партнёры» доступен при праве на маркетинг.</p>
    </div>
  )

  return (
    <div style={{ padding: '28px 40px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, background: '#f5f6f8', minHeight: '100vh' }}>

      {/* Шапка */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', marginBottom: '22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '13px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Handshake size={22} color="#e6ebee" />
          </div>
          <div>
            <div style={{ fontSize: '21px', fontWeight: 700, letterSpacing: '-0.01em' }}>Партнёры</div>
            <div style={{ fontSize: '12.5px', color: MUTE }}>Справочник партнёров-источников обращений</div>
          </div>
        </div>
        {canEdit && (
          <button onClick={() => { setEditing(null); setModalOpen(true) }} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: ACCENT, color: '#fff', border: 'none', borderRadius: '11px', padding: '11px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            <Plus size={17} /> Добавить партнёра
          </button>
        )}
      </div>

      {/* Тулбар: поиск + фильтры */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: STEEL }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по названию…" style={{ ...box, width: '100%', paddingLeft: '36px' }} />
        </div>
        <select value={fType} onChange={e => setFType(e.target.value)} style={{ ...box, minWidth: '160px' }}>
          <option value="">Все типы</option>
          {types.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ ...box, minWidth: '150px' }}>
          <option value="">Все статусы</option>
          <option value="active">Активные</option>
          <option value="inactive">Неактивные</option>
        </select>
      </div>

      {/* Сетка карточек */}
      {shown.length === 0 ? (
        <div style={{ padding: '40px', textAlign: 'center', color: FAINT, background: '#fff', borderRadius: '16px', border: `1px solid ${LINE}` }}>Партнёры не найдены</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
          {shown.map(p => {
            const inactive = p.status !== 'active'
            return (
              <div key={p.id} style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '18px 20px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)', opacity: inactive ? 0.7 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                  <div style={{ fontSize: '15.5px', fontWeight: 700, color: INK }}>{p.name}</div>
                  <span style={{ fontSize: '11px', fontWeight: 600, padding: '3px 9px', borderRadius: '999px', whiteSpace: 'nowrap', background: inactive ? '#f1f4f6' : '#e6f4ec', color: inactive ? '#6b7280' : '#15803d' }}>
                    {inactive ? 'Неактивен' : 'Активен'}
                  </span>
                </div>
                <span style={{ display: 'inline-block', marginTop: '9px', fontSize: '11.5px', fontWeight: 600, color: ACCENT, background: '#e2eef4', padding: '3px 10px', borderRadius: '999px' }}>{p.type}</span>
                <div style={{ marginTop: '12px', display: 'grid', gap: '5px', fontSize: '12.5px', color: MUTE }}>
                  <div>Условия: <span style={{ color: p.terms ? INK : FAINT }}>{p.terms || '—'}</span></div>
                  <div>Контакт: <span style={{ color: p.contact ? INK : FAINT }}>{p.contact || '—'}</span></div>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: '14px', marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${LINE}` }}>
                    <button onClick={() => { setEditing(p); setModalOpen(true) }} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '13px' }}>Редактировать</button>
                    <button onClick={() => toggleStatus(p)} style={{ background: 'transparent', border: 'none', color: inactive ? '#1b7a4b' : '#c0392b', fontWeight: 600, cursor: 'pointer', fontSize: '13px' }}>{inactive ? 'Активировать' : 'Деактивировать'}</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Справочник типов (владелец) */}
      {canEdit && (
        <div style={{ marginTop: '28px', background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '18px 20px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: INK, marginBottom: '4px' }}>Типы партнёров</div>
          <p style={{ fontSize: '12.5px', color: MUTE, margin: '0 0 12px' }}>Справочник типов — можно добавлять свои прямо в форме партнёра. Базовые типы удалить нельзя.</p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {types.map(t => (
              <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', fontWeight: 600, color: INK, background: '#f4f7f9', border: `1px solid ${LINE}`, borderRadius: '999px', padding: '5px 12px' }}>
                {t.name}
                {!t.is_system && <button onClick={() => removeType(t.id)} title="Удалить тип" style={{ background: 'transparent', border: 'none', color: '#c0392b', cursor: 'pointer', fontWeight: 700, lineHeight: 1 }}>✕</button>}
              </span>
            ))}
          </div>
        </div>
      )}

      {modalOpen && (
        <PartnerModal
          partner={editing}
          types={types}
          onAddType={addType}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); reload() }}
        />
      )}
    </div>
  )
}
