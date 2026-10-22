'use client'

// Вкладка «Контент» (органика) — реестр публикаций, ведётся вручную (Instagram API нет).
// Форма добавления/редактирования, сводка за период, фильтр «только органика»,
// таблица публикаций + топ по охватам. Обращения с органики — из consultations source='organic'.

import { useState, useEffect, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getContentTabData, saveContentPost, deleteContentPost,
  type ContentTabData, type ContentPost, type ContentPostType,
} from '@/actions/content'
import { CONTENT_TYPE_LABELS, CONTENT_TYPE_ORDER } from '@/lib/constants'
import {
  SectionCard, TileGrid, StatTile, cardStyle, EField, PrimaryBtn, editInputStyle, LoadingBlocks,
  MONO, INK, ACCENT, MUTE, FAINT, LINE, DASH,
} from './skeleton-ui'

const fmt  = (n: number) => Math.round(n).toLocaleString('ru-RU')
const monthBounds = () => {
  const now = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) }
}

type FormState = {
  id: string | null
  date: string; type: ContentPostType; author_id: string; title: string; went_to_target: boolean
  reach: string; views: string; engagement: string; profile_visits: string
}
const emptyForm = (): FormState => ({
  id: null, date: '', type: 'reels', author_id: '', title: '', went_to_target: false,
  reach: '', views: '', engagement: '', profile_visits: '',
})

export default function ContentScreen() {
  const [period, setPeriod] = useState(monthBounds)
  const [data, setData] = useState<ContentTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [onlyOrganic, setOnlyOrganic] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, startSaving] = useTransition()

  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getContentTabData(period.start, period.end).then(d => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [period.start, period.end, reloadKey])

  const posts = useMemo(() => data?.posts ?? [], [data])
  const shown = useMemo(() => onlyOrganic ? posts.filter(p => !p.went_to_target) : posts, [posts, onlyOrganic])

  // ── Сводка ────────────────────────────────────────────────────────────────
  const s = useMemo(() => {
    const organicOnly = posts.filter(p => !p.went_to_target)
    const toTarget    = posts.filter(p => p.went_to_target)
    const avg = (arr: ContentPost[], k: 'reach' | 'engagement') => arr.length ? arr.reduce((a, p) => a + p[k], 0) / arr.length : 0
    const top = [...posts].sort((a, b) => b.reach - a.reach).slice(0, 3)
    return {
      total: posts.length, organicCount: organicOnly.length, toTargetCount: toTarget.length,
      avgReach: avg(posts, 'reach'), avgEngagement: avg(posts, 'engagement'),
      profileVisits: posts.reduce((a, p) => a + p.profile_visits, 0),
      top,
    }
  }, [posts])

  const save = () => {
    if (!form.date) { toast.error('Укажите дату'); return }
    startSaving(async () => {
      const res = await saveContentPost(form.id, {
        date: form.date, type: form.type, author_id: form.author_id || null, title: form.title || null,
        went_to_target: form.went_to_target,
        reach: Number(form.reach) || 0, views: Number(form.views) || 0,
        engagement: Number(form.engagement) || 0, profile_visits: Number(form.profile_visits) || 0,
      })
      if (res.success) { toast.success(form.id ? 'Публикация обновлена' : 'Публикация добавлена'); setForm(emptyForm()); reload() }
      else toast.error(res.error)
    })
  }
  const edit = (p: ContentPost) => setForm({
    id: p.id, date: p.date, type: p.type, author_id: p.author_id ?? '', title: p.title ?? '',
    went_to_target: p.went_to_target,
    reach: String(p.reach), views: String(p.views), engagement: String(p.engagement), profile_visits: String(p.profile_visits),
  })
  const remove = (p: ContentPost) => {
    if (!confirm('Удалить публикацию?')) return
    startSaving(async () => {
      const res = await deleteContentPost(p.id)
      if (res.success) { toast.success('Публикация удалена'); if (form.id === p.id) setForm(emptyForm()); reload() }
      else toast.error(res.error)
    })
  }

  if (loading && !data) return <LoadingBlocks />
  if (!data) return <SectionCard title="Нет доступа" subtitle="Недостаточно прав для просмотра контента (marketing.view)." />

  const authors = data.authors

  return (
    <div style={{ display: 'grid', gap: '24px' }}>

      {/* Период */}
      <section style={{ ...cardStyle, display: 'flex', gap: '18px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <EField label="Начало периода"><input type="date" value={period.start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} style={editInputStyle} /></EField>
        <EField label="Конец периода"><input type="date" value={period.end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} style={editInputStyle} /></EField>
      </section>

      {/* Форма публикации */}
      <SectionCard title={form.id ? 'Редактирование публикации' : 'Новая публикация'} subtitle="Единица органического контента — перенос цифр из Instagram вручную">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
          <EField label="Дата"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={editInputStyle} /></EField>
          <EField label="Тип">
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as ContentPostType }))} style={editInputStyle}>
              {CONTENT_TYPE_ORDER.map(t => <option key={t} value={t}>{CONTENT_TYPE_LABELS[t]}</option>)}
            </select>
          </EField>
          <EField label="Автор">
            <select value={form.author_id} onChange={e => setForm(f => ({ ...f, author_id: e.target.value }))} style={editInputStyle}>
              <option value="">— не указан —</option>
              {authors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </EField>
          <EField label="Описание"><input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="для узнавания" style={editInputStyle} /></EField>
          <EField label="Охваты"><input type="number" min={0} value={form.reach} onChange={e => setForm(f => ({ ...f, reach: e.target.value }))} placeholder="0" style={{ ...editInputStyle, fontFamily: MONO }} /></EField>
          <EField label="Просмотры"><input type="number" min={0} value={form.views} onChange={e => setForm(f => ({ ...f, views: e.target.value }))} placeholder="0" style={{ ...editInputStyle, fontFamily: MONO }} /></EField>
          <EField label="Вовлечённость"><input type="number" min={0} value={form.engagement} onChange={e => setForm(f => ({ ...f, engagement: e.target.value }))} placeholder="лайки+комменты+сохр." style={{ ...editInputStyle, fontFamily: MONO }} /></EField>
          <EField label="Переходы в профиль"><input type="number" min={0} value={form.profile_visits} onChange={e => setForm(f => ({ ...f, profile_visits: e.target.value }))} placeholder="0" style={{ ...editInputStyle, fontFamily: MONO }} /></EField>
        </div>
        <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' }}>
          <label title="Ролик запускался в платную рекламу (просмотры частично оплачены)" style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', fontWeight: 600, color: MUTE, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.went_to_target} onChange={e => setForm(f => ({ ...f, went_to_target: e.target.checked }))} style={{ width: '16px', height: '16px' }} />
            Шёл в таргет
            <span title="Ролик запускался в платную рекламу (просмотры частично оплачены)" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '15px', height: '15px', borderRadius: '50%', background: '#e2eef4', color: ACCENT, fontSize: '10px', fontWeight: 700, cursor: 'help' }}>?</span>
          </label>
          <PrimaryBtn onClick={save} disabled={saving}>{form.id ? 'Сохранить' : '＋ Добавить публикацию'}</PrimaryBtn>
          {form.id && <button onClick={() => setForm(emptyForm())} style={{ background: 'transparent', border: `1px solid ${LINE}`, color: MUTE, borderRadius: '10px', padding: '10px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Отмена</button>}
        </div>
      </SectionCard>

      {/* Сводка */}
      <SectionCard title="Сводка за период" subtitle="Всего / только органика / ушло в таргет">
        <TileGrid min={175}>
          <StatTile label="Публикаций" hint={`органика ${fmt(s.organicCount)} · в таргет ${fmt(s.toTargetCount)}`} value={fmt(s.total)} big />
          <StatTile label="Средние охваты" unit="на пост" value={s.total ? fmt(s.avgReach) : null} />
          <StatTile label="Средняя вовлечённость" unit="на пост" value={s.total ? fmt(s.avgEngagement) : null} />
          <StatTile label="Переходы в профиль" hint="сумма за период" value={fmt(s.profileVisits)} />
          <StatTile label="Обращения с органики" hint="из консультаций source=organic" value={fmt(data.organicAppeals)} big />
        </TileGrid>
        {s.top.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Топ по охватам</div>
            <div style={{ display: 'grid', gap: '6px' }}>
              {s.top.map((p, i) => (
                <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: '10px', alignItems: 'center', padding: '8px 12px', borderRadius: '10px', background: i === 0 ? '#e6f4ec' : '#f4f7f9', border: `1px solid ${LINE}` }}>
                  <span style={{ fontFamily: MONO, fontWeight: 700, color: i === 0 ? '#1b7a4b' : FAINT, textAlign: 'center' }}>{i + 1}</span>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {CONTENT_TYPE_LABELS[p.type]}{p.title ? ` · ${p.title}` : ''} <span style={{ color: FAINT, fontWeight: 400 }}>{p.date.slice(8, 10)}.{p.date.slice(5, 7)}</span>
                  </span>
                  <span style={{ fontFamily: MONO, fontWeight: 700, color: INK }}>{fmt(p.reach)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {/* Таблица публикаций */}
      <SectionCard title="Публикации" subtitle="Отсортированы по дате (сначала новые)" chip={`${shown.length} из ${posts.length}`}>
        <label title="Показать только ролики, залетевшие без рекламы" style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', fontWeight: 600, color: MUTE, cursor: 'pointer', marginBottom: '14px' }}>
          <input type="checkbox" checked={onlyOrganic} onChange={e => setOnlyOrganic(e.target.checked)} style={{ width: '16px', height: '16px' }} />
          Только органика (без рекламы)
          <span title="Показать только ролики, залетевшие без рекламы" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '15px', height: '15px', borderRadius: '50%', background: '#e2eef4', color: ACCENT, fontSize: '10px', fontWeight: 700, cursor: 'help' }}>?</span>
        </label>
        <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '900px', fontSize: '12px', fontFamily: MONO }}>
            <thead>
              <tr>
                {['Дата', 'Тип', 'Автор', 'В таргет', 'Охваты', 'Просмотры', 'Вовлечённость', 'Переходы', ''].map((h, i) => (
                  <th key={h || i} style={{ background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', textAlign: i >= 4 && i <= 7 ? 'right' : 'left', borderLeft: i === 0 ? undefined : '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: '20px', textAlign: 'center', color: FAINT, fontFamily: "'Golos Text', sans-serif" }}>Нет публикаций за период</td></tr>
              ) : shown.map(p => (
                <tr key={p.id}>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>{p.date.slice(8, 10)}.{p.date.slice(5, 7)}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", color: INK }}>{CONTENT_TYPE_LABELS[p.type]}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", color: p.author_name ? INK : FAINT }}>{p.author_name ?? DASH}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif" }}>
                    {p.went_to_target
                      ? <span style={{ fontSize: '11px', fontWeight: 600, color: ACCENT, background: '#e2eef4', padding: '2px 8px', borderRadius: '999px' }}>таргет</span>
                      : <span style={{ fontSize: '11px', fontWeight: 600, color: '#1b7a4b', background: '#e6f4ec', padding: '2px 8px', borderRadius: '999px' }}>органика</span>}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: p.reach ? INK : FAINT }}>{p.reach ? fmt(p.reach) : DASH}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: p.views ? INK : FAINT }}>{p.views ? fmt(p.views) : DASH}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: p.engagement ? INK : FAINT }}>{p.engagement ? fmt(p.engagement) : DASH}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: p.profile_visits ? INK : FAINT }}>{p.profile_visits ? fmt(p.profile_visits) : DASH}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', textAlign: 'right', fontFamily: "'Golos Text', sans-serif" }}>
                    <button onClick={() => edit(p)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontWeight: 600, cursor: 'pointer', fontSize: '12px', marginRight: '10px' }}>изм.</button>
                    <button onClick={() => remove(p)} style={{ background: 'transparent', border: 'none', color: '#c0392b', fontWeight: 600, cursor: 'pointer', fontSize: '12px' }}>уд.</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

    </div>
  )
}
