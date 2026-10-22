'use client'

// ─── Окно правки записи посещаемости ──────────────────────────────────────────
//
// Комментарий обязателен: кнопка сохранения заблокирована, пока он пуст, а на
// сервере это дополнительно закрыто CHECK'ом в БД — правка без объяснения не
// запишется физически даже в обход интерфейса.
//
// Время вводится в поясе компании (Asia/Bishkek). Пересчёт опоздания,
// переработки и недоработки делает сервер от СНИМКА смены, сохранённого в самой
// записи, а не от текущего графика сотрудника.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  correctAttendance, getAttendanceCorrections, getAttendanceRecord,
  type AttendanceRecord, type CorrectionEntry,
} from '@/actions/attendance'

const STATUSES = [
  { v: 'worked',           l: 'Работал' },
  { v: 'late_not_counted', l: 'Опоздал >30 мин — день не зачтён' },
  { v: 'absent',           l: 'Прогул' },
  { v: 'remote',           l: 'Удалённо' },
  { v: 'day_off',          l: 'Выходной' },
  { v: 'sick',             l: 'Больничный' },
  { v: 'vacation',         l: 'Отпуск' },
]

const FIELD_LABELS: Record<string, string> = {
  status: 'статус',
  check_in_time: 'приход',
  check_out_time: 'уход',
  late_minutes: 'опоздание, мин',
  late_grade: 'степень опоздания',
  counts_as_worked: 'день зачтён',
  overtime_minutes: 'переработка, мин',
  shortfall_minutes: 'недоработка, мин',
}

/** timestamptz → значение для input[type=datetime-local] в поясе компании. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const bishkek = new Date(d.getTime() + 6 * 3600_000)
  return bishkek.toISOString().slice(0, 16)
}

/** Обратно: значение поля (время компании) → ISO в UTC. */
function fromLocalInput(v: string): string | null {
  if (!v) return null
  return new Date(new Date(v + ':00Z').getTime() - 6 * 3600_000).toISOString()
}

function fmtValue(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'counts_as_worked') return v === true || v === 'true' ? 'да' : 'нет'
  if (k === 'check_in_time' || k === 'check_out_time') {
    const d = new Date(String(v))
    return isNaN(d.getTime()) ? String(v)
      : new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
  }
  if (k === 'status') return STATUSES.find(s => s.v === v)?.l ?? String(v)
  return String(v)
}

export default function CorrectionModal({
  attendanceId, onClose, onSaved,
}: { attendanceId: string; onClose: () => void; onSaved: () => void }) {
  const [rec, setRec] = useState<AttendanceRecord | null>(null)
  const [history, setHistory] = useState<CorrectionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [status, setStatus] = useState('')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [counts, setCounts] = useState(true)
  const [comment, setComment] = useState('')

  useEffect(() => {
    void (async () => {
      const [r, h] = await Promise.all([
        getAttendanceRecord(attendanceId),
        getAttendanceCorrections(attendanceId),
      ])
      if (r) {
        setRec(r)
        setStatus(r.status)
        setCheckIn(toLocalInput(r.check_in_time))
        setCheckOut(toLocalInput(r.check_out_time))
        setCounts(r.counts_as_worked)
      }
      setHistory(h)
      setLoading(false)
    })()
  }, [attendanceId])

  const save = async () => {
    if (comment.trim().length === 0) return
    setSaving(true)
    const res = await correctAttendance(attendanceId, {
      status,
      check_in_time: fromLocalInput(checkIn),
      check_out_time: fromLocalInput(checkOut),
      counts_as_worked: counts,
    }, comment)
    setSaving(false)
    if (res.success) {
      toast.success('Правка сохранена')
      onSaved()
      onClose()
    } else {
      toast.error(res.error)
    }
  }

  const canSave = !saving && comment.trim().length > 0

  return (
    <div style={sheet} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={card}>
        {loading && <div style={{ padding: '10px 0' }}>Загрузка…</div>}

        {!loading && !rec && <div style={{ padding: '10px 0' }}>Запись не найдена</div>}

        {!loading && rec && (
          <>
            <div style={{ fontSize: '17px', fontWeight: 700, marginBottom: '2px' }}>
              Правка дня — {rec.employee_name}
            </div>
            <div style={{ fontSize: '13px', color: '#6b7d8a', marginBottom: '16px' }}>
              {rec.date} · смена по графику {rec.planned_start.slice(0, 5)}–{rec.planned_end.slice(0, 5)}
              {rec.covering_for_name && ` · подмена: ${rec.covering_for_name}`}
            </div>

            {rec.substitution_reason && (
              <div style={note}>Причина подмены: {rec.substitution_reason}</div>
            )}

            <label style={lbl}>Статус дня</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={inp}>
              {STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select>

            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Приход</label>
                <input type="datetime-local" value={checkIn} onChange={e => setCheckIn(e.target.value)} style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Уход</label>
                <input type="datetime-local" value={checkOut} onChange={e => setCheckOut(e.target.value)} style={inp} />
              </div>
            </div>

            <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={counts} onChange={e => setCounts(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer' }} />
              День засчитан как рабочий
            </label>

            <div style={hint}>
              Опоздание, переработку и недоработку пересчитает сервер — от смены,
              записанной в этот день ({rec.planned_start.slice(0, 5)}–{rec.planned_end.slice(0, 5)}),
              а не от текущего графика сотрудника.
            </div>

            <label style={{ ...lbl, color: '#a01722' }}>Причина правки — обязательно</label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={2}
              placeholder="Почему меняете запись"
              style={{ ...inp, resize: 'vertical' }}
            />

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '6px' }}>
              <button onClick={onClose} style={btnGhost}>Отмена</button>
              <button onClick={() => void save()} disabled={!canSave} style={canSave ? btnPrimary : btnDisabled}>
                {saving ? 'Сохранение…' : 'Сохранить правку'}
              </button>
            </div>

            {history.length > 0 && (
              <div style={{ marginTop: '20px', borderTop: '1px solid #eef2f5', paddingTop: '14px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>
                  История правок
                </div>
                {history.map(h => {
                  const changed = Object.keys(h.new_values).filter(
                    k => String(h.old_values[k] ?? '') !== String(h.new_values[k] ?? ''),
                  )
                  return (
                    <div key={h.id} style={histItem}>
                      <div style={{ fontSize: '12px', color: '#0c2136', fontWeight: 600 }}>
                        {h.corrected_by_name}
                        <span style={{ color: '#8494a0', fontWeight: 400 }}>
                          {' · '}{new Date(h.created_at).toLocaleString('ru-RU')}
                        </span>
                      </div>
                      <div style={{ fontSize: '12.5px', color: '#3d5060', margin: '4px 0 6px' }}>
                        «{h.comment}»
                      </div>
                      {changed.length === 0 && (
                        <div style={{ fontSize: '11.5px', color: '#8494a0' }}>значения не изменились</div>
                      )}
                      {changed.map(k => (
                        <div key={k} style={{ fontSize: '11.5px', color: '#647581' }}>
                          {FIELD_LABELS[k] ?? k}: <span style={{ color: '#a01722' }}>{fmtValue(k, h.old_values[k])}</span>
                          {' → '}
                          <span style={{ color: '#1b7a4b' }}>{fmtValue(k, h.new_values[k])}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const sheet: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(12,33,54,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
}
const card: React.CSSProperties = {
  background: '#fff', borderRadius: '16px', padding: '24px 26px', maxWidth: '520px',
  width: '100%', maxHeight: '88vh', overflowY: 'auto',
  boxShadow: '0 20px 60px -20px rgba(12,33,54,0.6)',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: '#0c2136',
}
const lbl: React.CSSProperties = {
  display: 'block', fontSize: '11.5px', fontWeight: 600, color: '#6b7d8a',
  margin: '12px 0 5px', textTransform: 'uppercase', letterSpacing: '0.03em',
}
const inp: React.CSSProperties = {
  width: '100%', background: '#f7f9fa', border: '1.5px solid #dde5ea', borderRadius: '9px',
  padding: '9px 11px', fontSize: '13.5px', color: '#0c2136', fontFamily: 'inherit',
}
const note: React.CSSProperties = {
  background: '#f3f0fb', borderRadius: '9px', padding: '9px 11px',
  fontSize: '12.5px', color: '#5b3fa8', marginBottom: '4px',
}
const hint: React.CSSProperties = {
  background: '#f7f9fa', borderRadius: '9px', padding: '9px 11px',
  fontSize: '11.5px', color: '#6b7d8a', marginTop: '10px', lineHeight: 1.45,
}
const histItem: React.CSSProperties = {
  borderLeft: '2px solid #dde5ea', paddingLeft: '10px', marginBottom: '12px',
}
const btnGhost: React.CSSProperties = {
  border: '1px solid #cdd8df', background: '#fff', color: '#647581', borderRadius: '9px',
  padding: '10px 16px', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const btnPrimary: React.CSSProperties = {
  border: 'none', background: '#0c4d6c', color: '#fff', borderRadius: '9px',
  padding: '10px 18px', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const btnDisabled: React.CSSProperties = { ...btnPrimary, background: '#a2b4c0', cursor: 'default' }
