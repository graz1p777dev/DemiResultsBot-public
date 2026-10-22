'use client'

// ─── Вкладка «Объяснительные» ─────────────────────────────────────────────────
//
// Два разных вопроса на одном экране:
//   1. КТО ДОЛЖЕН БУМАГУ — дни с опозданием свыше 15 минут, за которые фото
//      объяснительной не приложено. Долг нигде не хранится: он вычисляется из
//      фактов, поэтому правка дня задним числом сразу меняет и список.
//   2. ЧТО ЧЕЛОВЕК ГОВОРИЛ — все причины опозданий одного сотрудника подряд.
//      Владелец просил видеть их в одном месте: одна причина ничего не значит,
//      а пять одинаковых — уже разговор.
//
// Система не делит причины на уважительные и неуважительные и ничего не решает
// сама. Она показывает сказанное; выводы делает человек.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  getExplanationStatus, getLateReasons, getExplanationUrl,
  type ExplanationRow, type LateReasonRow,
} from '@/actions/attendance-explanations'

const panel: React.CSSProperties = {
  background: '#fff', borderRadius: '14px', padding: '18px 20px',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: '#0c2136',
}

function ruDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

const GRADE_LABEL: Record<string, string> = {
  late_soft:     'до 15 мин',
  late_hard:     'свыше 15 мин',
  late_critical: 'день не засчитан',
}

interface Props { year: number; month: number }

export default function ExplanationsTab({ year, month }: Props) {
  const [rows, setRows] = useState<ExplanationRow[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [openEmp, setOpenEmp] = useState<{ id: string; name: string } | null>(null)
  const [reasons, setReasons] = useState<LateReasonRow[] | null>(null)

  const load = useCallback(async () => {
    const res = await getExplanationStatus(year, month)
    if (res.ok) { setRows(res.rows); setDenied(false) }
    else { setRows([]); setDenied(true) }
  }, [year, month])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const openReasons = async (id: string, name: string) => {
    setOpenEmp({ id, name })
    setReasons(null)
    const res = await getLateReasons(id, 3)
    setReasons(res.ok ? res.rows : [])
  }

  const openFile = async (path: string) => {
    const url = await getExplanationUrl(path)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('Не удалось открыть файл')
  }

  if (denied) {
    return (
      <div style={panel}>
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>Нет доступа</div>
        <div style={{ fontSize: '13.5px', color: '#6b7d8a' }}>
          Раздел доступен тем, кто ведёт учёт по отделу или по компании.
        </div>
      </div>
    )
  }

  if (rows === null) return <div style={panel}>Загрузка…</div>

  const owed = rows.filter(r => !r.uploaded)
  const done = rows.filter(r => r.uploaded)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={panel}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '2px' }}>
          Должны объяснительную{owed.length > 0 ? ` · ${owed.length}` : ''}
        </div>
        <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '0 0 10px' }}>
          Опоздания свыше 15 минут за {ruDate(`${year}-${String(month).padStart(2, '0')}-01`).slice(3)}, по которым бумага не сдана.
        </p>

        {/* Два разных «пусто», которые нельзя путать: сдали всё — или таких дней
            не было вовсе. Второе бывает, пока учёт никому не включён, и говорить
            тогда «все сданы» — значит отчитываться за работу, которой не было. */}
        {owed.length === 0 && (
          <div style={{ fontSize: '13.5px', color: '#6b7d8a' }}>
            {done.length > 0
              ? 'Все объяснительные сданы.'
              : 'Нет дней, за которые нужна объяснительная.'}
          </div>
        )}

        {owed.map(r => (
          <div key={r.attendance_id} style={{ borderTop: '1px solid #edf1f4', padding: '10px 0', display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ background: '#f7ddd2', color: '#9c3d12', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap' }}>
              {r.late_minutes} мин
            </span>
            <div style={{ flex: '1 1 200px' }}>
              <button
                onClick={() => void openReasons(r.employee_id, r.employee_name)}
                style={{ border: 'none', background: 'none', padding: 0, fontSize: '13.5px', fontWeight: 600, color: '#0c4d6c', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
              >
                {r.employee_name}
              </button>
              <div style={{ fontSize: '12.5px', color: '#6b7d8a' }}>{ruDate(r.date)}</div>
              {r.reason && <div style={{ fontSize: '13px', marginTop: '4px' }}>«{r.reason}»</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={panel}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '10px' }}>
          Сдано{done.length > 0 ? ` · ${done.length}` : ''}
        </div>
        {done.length === 0 && <div style={{ fontSize: '13.5px', color: '#6b7d8a' }}>Пока ничего.</div>}
        {done.map(r => (
          <div key={r.attendance_id} style={{ borderTop: '1px solid #edf1f4', padding: '10px 0', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ background: '#eaf4ee', color: '#1b6b45', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
              сдана
            </span>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{r.employee_name}</div>
              <div style={{ fontSize: '12.5px', color: '#6b7d8a' }}>{ruDate(r.date)} · {r.late_minutes} мин</div>
            </div>
            {r.storage_path && (
              <button
                onClick={() => void openFile(r.storage_path as string)}
                style={{ border: '1px solid #cdd8df', background: '#fff', color: '#0c4d6c', borderRadius: '8px', padding: '7px 13px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Посмотреть
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Все причины одного человека — то, что владелец просил видеть в одном месте. */}
      {openEmp && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(12,33,54,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
          onClick={() => setOpenEmp(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ ...panel, maxWidth: '520px', width: '100%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px -20px rgba(12,33,54,0.6)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>{openEmp.name}</div>
              <button
                onClick={() => setOpenEmp(null)}
                style={{ border: 'none', background: 'none', fontSize: '20px', color: '#a2b4c0', cursor: 'pointer', lineHeight: 1 }}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <p style={{ fontSize: '12.5px', color: '#6b7d8a', margin: '0 0 12px' }}>
              Причины опозданий за последние 3 месяца — так, как их записал сам сотрудник
              в момент прихода. Изменить их задним числом нельзя.
            </p>

            {reasons === null && <div style={{ fontSize: '13.5px', color: '#6b7d8a' }}>Загрузка…</div>}
            {reasons?.length === 0 && <div style={{ fontSize: '13.5px', color: '#6b7d8a' }}>Опозданий не было.</div>}

            {(reasons ?? []).map(r => (
              <div key={r.attendance_id} style={{ borderTop: '1px solid #edf1f4', padding: '10px 0' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>{ruDate(r.date)}</span>
                  <span style={{ fontSize: '12.5px', color: '#9c3d12', fontWeight: 600 }}>{r.late_minutes} мин</span>
                  <span style={{ fontSize: '12px', color: '#6b7d8a' }}>{GRADE_LABEL[r.late_grade] ?? ''}</span>
                  {r.needs_note && (
                    <span style={{ fontSize: '12px', fontWeight: 600, color: r.note_uploaded ? '#1b6b45' : '#9c3d12' }}>
                      {r.note_uploaded ? 'объяснительная сдана' : 'объяснительная не сдана'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '13px', marginTop: '4px' }}>
                  {r.reason ? `«${r.reason}»` : <span style={{ color: '#a2b4c0' }}>причина не записана</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
