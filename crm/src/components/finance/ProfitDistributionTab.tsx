'use client'

// Вкладка «Распределение прибыли» (шаг 6). Чистая прибыль за месяц (из P&L Обзора)
// раскладывается по долям владельца: инвесторам / долги / реинвест / владельцу / свои.
// Суммы = прибыль × доля%. Сверка с фактическими начислениями инвесторам и долгами.
// Убыток не распределяется (берётся 0). owner — авто-остаток (100 − остальные).

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getProfitDistributionData, saveDistributionRules, fixProfitDistribution,
  type ProfitDistributionData,
} from '@/actions/finance-profit-distribution'
import { BUCKET_LABEL } from '@/lib/finance-labels'

const INK = '#0c2136', ACCENT = '#0c4d6c', GREEN = '#1b7a4b', RED = '#c0392b', AMBER = '#b5732f', MUTE = '#6b7d8a', FAINT = '#8a9aa6', LINE = '#e6ebee', STEEL = '#a2b4c0'
const MONO = "'IBM Plex Mono', monospace"
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number | null) => n === null ? '—' : (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const box: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '14px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' }
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '16px', padding: '20px 22px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)' }

const BUCKET_COLOR: Record<string, string> = { investors: '#0c4d6c', debt_repayment: '#c0392b', reinvest: '#b5732f', owner: '#1b7a4b' }
const bucketColor = (b: string) => BUCKET_COLOR[b] ?? '#5c6f7c'
const bucketLabel = (b: string, name: string) => BUCKET_LABEL[b] ?? name

type RuleRow = { id: string; bucket: string; name: string; share: string; sort_order: number; is_system: boolean }

export default function ProfitDistributionTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const periodMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const [data, setData] = useState<ProfitDistributionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [rules, setRules] = useState<RuleRow[]>([])
  const [saving, startSaving] = useTransition()
  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    getProfitDistributionData(periodMonth).then(d => {
      if (cancelled) return
      setData(d); setLoading(false)
      if (d) setRules(d.rules.map(r => ({ id: r.id, bucket: r.bucket, name: r.name, share: String(r.share_pct), sort_order: r.sort_order, is_system: r.is_system })))
    })
    return () => { cancelled = true }
  }, [periodMonth, reloadKey])

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  const nonOwnerSum = rules.filter(r => r.bucket !== 'owner').reduce((s, r) => s + (Number(r.share) || 0), 0)
  const ownerShare = Math.max(100 - nonOwnerSum, 0)
  const effShare = (r: RuleRow) => r.bucket === 'owner' ? ownerShare : (Number(r.share) || 0)

  const setShare = (id: string, v: string) => setRules(rs => rs.map(r => r.id === id ? { ...r, share: v } : r))
  const setName = (id: string, v: string) => setRules(rs => rs.map(r => r.id === id ? { ...r, name: v } : r))
  const removeRule = (id: string) => setRules(rs => rs.filter(r => r.id !== id))
  const addRule = () => setRules(rs => [...rs, { id: `new-${rs.length}-${rs.reduce((m, r) => Math.max(m, r.sort_order), 0)}`, bucket: 'custom', name: '', share: '0', sort_order: (rs.reduce((m, r) => Math.max(m, r.sort_order), 0) || 0) + 10, is_system: false }])

  const saveRules = () => {
    if (nonOwnerSum > 100) { toast.error('Сумма долей (без владельца) превышает 100%'); return }
    if (rules.some(r => !r.name.trim())) { toast.error('У всех статей должно быть название'); return }
    startSaving(async () => {
      const res = await saveDistributionRules(rules.map(r => ({ bucket: r.bucket, name: r.name.trim(), share_pct: Number(r.share) || 0, sort_order: r.sort_order, is_system: r.is_system })))
      if (res.success) { toast.success('Правила сохранены'); reload() } else toast.error(res.error)
    })
  }
  const fix = () => {
    if (!confirm(`Зафиксировать раскладку за ${MONTHS[month].toLowerCase()} ${year}? Прежний снимок за месяц будет заменён.`)) return
    startSaving(async () => {
      const res = await fixProfitDistribution(periodMonth)
      if (res.success) { toast.success('Раскладка зафиксирована'); reload() } else toast.error(res.error)
    })
  }

  if (loading && !data) return (
    <div style={{ padding: '20px', display: 'grid', gap: '16px' }}>
      {[80, 120, 260, 200].map((h, i) => <div key={i} className="animate-pulse" style={{ height: h, background: '#e9ebee', borderRadius: '16px' }} />)}
    </div>
  )
  if (!data) return (
    <div style={{ padding: '60px 40px', textAlign: 'center', fontFamily: "'Golos Text', sans-serif" }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: INK }}>Нет доступа</div>
      <p style={{ fontSize: '13px', color: MUTE, marginTop: '8px' }}>Раздел доступен при праве на финансы.</p>
    </div>
  )

  const base = Math.max(data.netProfit, 0)
  const amount = (r: RuleRow) => base * (effShare(r) / 100)

  return (
    <div style={{ padding: '20px 20px 56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: INK, display: 'grid', gap: '18px' }}>

      {/* Месяц + чистая прибыль */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <button onClick={prev} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '18px', fontWeight: 700, minWidth: '180px', textAlign: 'center' }}>{MONTHS[month]} {year}</div>
        <button onClick={next} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>→</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Чистая прибыль за месяц</div>
          <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 700, color: data.netProfit >= 0 ? GREEN : RED }}>{fmt(data.netProfit)} <span style={{ fontSize: '13px', color: STEEL }}>сом</span></div>
        </div>
      </div>

      {data.netProfit <= 0 && (
        <div style={{ ...card, padding: '14px 18px', background: '#fdf3ef', border: '1px solid #f0d3c6' }}>
          <span style={{ fontSize: '13px', color: AMBER, fontWeight: 600 }}>Прибыль за месяц ≤ 0 — распределять нечего. Суммы по статьям = 0.</span>
        </div>
      )}

      {/* Правила раскладки */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <div style={{ fontSize: '15px', fontWeight: 700 }}>Правила раскладки</div>
          <div style={{ marginLeft: 'auto', fontSize: '12.5px', fontWeight: 700, color: nonOwnerSum > 100 ? RED : MUTE, fontFamily: MONO }}>
            сумма долей: {fmt1(nonOwnerSum)}% {nonOwnerSum > 100 ? '⚠ >100' : `· владельцу ${fmt1(ownerShare)}%`}
          </div>
        </div>
        <p style={{ fontSize: '12px', color: MUTE, margin: '0 0 14px' }}>Владелец задаёт доли. «Владельцу» — авто-остаток (100 − остальные).</p>

        <div style={{ display: 'grid', gap: '8px' }}>
          {rules.map(r => {
            const isOwner = r.bucket === 'owner'
            const removable = data.canManage && !r.is_system
            return (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '14px 1fr 120px 130px 30px', gap: '10px', alignItems: 'center' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: bucketColor(r.bucket) }} />
                {data.canManage && !r.is_system
                  ? <input value={r.name} onChange={e => setName(r.id, e.target.value)} placeholder="название статьи" style={box} />
                  : <div style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{bucketLabel(r.bucket, r.name)}{r.is_system && <span style={{ fontSize: '10px', color: FAINT, fontWeight: 500 }}> · системная</span>}</div>}
                {isOwner
                  ? <div style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700, color: GREEN, textAlign: 'right' }}>{fmt1(ownerShare)}% <span style={{ fontSize: '10px', color: FAINT }}>остаток</span></div>
                  : data.canManage
                    ? <input type="number" min={0} max={100} value={r.share} onChange={e => setShare(r.id, e.target.value)} style={{ ...box, fontFamily: MONO, textAlign: 'right' }} />
                    : <div style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700 }}>{fmt1(Number(r.share))}%</div>}
                <div style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700, textAlign: 'right', color: INK }}>{fmt(amount(r))} <span style={{ fontSize: '10px', color: STEEL }}>сом</span></div>
                {removable ? (
                  <button
                    type="button"
                    onClick={() => removeRule(r.id)}
                    title="Убрать статью"
                    aria-label="Убрать статью"
                    style={{
                      width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: '#fdf1f0', border: '1px solid #f0d3c6', borderRadius: '50%',
                      color: RED, cursor: 'pointer', fontSize: '14px', fontWeight: 700, lineHeight: 1, padding: 0,
                    }}
                  >✕</button>
                ) : <span />}
              </div>
            )
          })}
        </div>

        {data.canManage && (
          <div style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={saveRules} disabled={saving} style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>Сохранить правила</button>
            <button onClick={addRule} style={{ border: `1px solid ${LINE}`, background: '#fff', color: ACCENT, borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>＋ статья</button>
          </div>
        )}
      </div>

      {/* Раскладка за месяц (по сохранённым правилам) */}
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>Раскладка за {MONTHS[month].toLowerCase()}</div>
        {/* полоса-структура */}
        {base > 0 && (
          <div style={{ display: 'flex', height: '16px', borderRadius: '6px', overflow: 'hidden', marginBottom: '14px' }}>
            {data.computed.filter(l => l.amount > 0).map((l, i) => (
              <div key={i} title={`${bucketLabel(l.bucket, l.name)} ${fmt1(l.share_pct)}%`} style={{ width: `${l.share_pct}%`, background: bucketColor(l.bucket) }} />
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gap: '8px' }}>
          {data.computed.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '14px 1fr auto auto', gap: '12px', alignItems: 'center', padding: '9px 12px', borderRadius: '10px', background: '#f8fafb', border: `1px solid ${LINE}` }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: bucketColor(l.bucket) }} />
              <span style={{ fontSize: '13.5px', fontWeight: 600, color: INK }}>{bucketLabel(l.bucket, l.name)}</span>
              <span style={{ fontFamily: MONO, fontSize: '12.5px', color: MUTE }}>{fmt1(l.share_pct)}%</span>
              <span style={{ fontFamily: MONO, fontSize: '15px', fontWeight: 700, color: bucketColor(l.bucket) }}>{fmt(l.amount)} <span style={{ fontSize: '10px', color: STEEL }}>сом</span></span>
            </div>
          ))}
        </div>
        {data.canManage && (
          <div style={{ marginTop: '14px' }}>
            <button onClick={fix} disabled={saving || base <= 0} style={{ background: base <= 0 ? '#c9d2d8' : GREEN, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: base <= 0 ? 'not-allowed' : 'pointer' }}>Зафиксировать раскладку за месяц</button>
          </div>
        )}
      </div>

      {/* Сверка */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '18px' }}>
        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Сверка: инвесторы</div>
          <p style={{ fontSize: '12px', color: MUTE, margin: '0 0 14px' }}>По правилу vs фактически начислено инвесторам (шаг «Инвесторы»)</p>
          <div style={{ display: 'grid', gap: '9px', fontSize: '13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>По правилу «инвесторам»</span><span style={{ fontFamily: MONO, fontWeight: 700, color: ACCENT }}>{fmt(data.investorsRuleAmount)} сом</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>Фактически начислено</span><span style={{ fontFamily: MONO, fontWeight: 700 }}>{fmt(data.investorsAccrued)} сом</span></div>
            <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: '9px', fontSize: '12.5px', color: FAINT }}>
              {(() => { const d = data.investorsRuleAmount - data.investorsAccrued
                if (Math.abs(d) < 1) return 'Сходится: правило покрывает начисления.'
                return d > 0 ? `По правилу больше на ${fmt(d)} сом — есть запас.` : `По правилу меньше на ${fmt(-d)} сом — начислено больше, чем выделено.` })()}
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>Сверка: долги</div>
          <p style={{ fontSize: '12px', color: MUTE, margin: '0 0 14px' }}>По правилу на погашение vs обязательства (шаг «Долги»)</p>
          <div style={{ display: 'grid', gap: '9px', fontSize: '13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>По правилу «погашение долгов»</span><span style={{ fontFamily: MONO, fontWeight: 700, color: ACCENT }}>{fmt(data.debtRuleAmount)} сом</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTE }}>Всего активных долгов</span><span style={{ fontFamily: MONO, fontWeight: 700, color: data.debtsTotalActiveSom > 0 ? RED : GREEN }}>{fmt(data.debtsTotalActiveSom)} сом</span></div>
            {data.nearestDebt && (
              <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: '9px', fontSize: '12.5px', color: MUTE }}>
                Ближайший возврат: <b style={{ color: INK }}>{data.nearestDebt.creditor}</b> — <span style={{ fontFamily: MONO }}>{fmt(data.nearestDebt.amountSom)}</span>, {ru(data.nearestDebt.dueDate)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Зафиксированный снимок */}
      {data.fixed && (
        <div style={{ ...card, background: '#f4f7f9' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 700, marginBottom: '8px' }}>Зафиксировано {new Date(data.fixed.created_at).toLocaleDateString('ru-RU')} · снимок чистой прибыли {fmt(data.fixed.net_profit_som)} сом</div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12.5px', color: MUTE }}>
            {data.fixed.lines.map((l, i) => (
              <span key={i}>{bucketLabel(l.bucket, l.name)}: <b style={{ color: INK, fontFamily: MONO }}>{fmt(l.amount)}</b> ({fmt1(l.share_pct)}%)</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
