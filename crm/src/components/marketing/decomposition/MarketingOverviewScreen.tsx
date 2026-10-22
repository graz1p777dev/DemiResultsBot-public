'use client'

// Вкладка «Общая» отдела маркетинга — свод трёх каналов (таргет/органика/партнёры)
// против общего плана обращений (из воронки продаж). Логика факта — без двойного счёта
// (см. getMarketingOverview). Прогноз/светофор переиспользуют PaceForecast из продаж.

import { useState, useEffect, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import { getMarketingOverview, saveChannelPlan, type MarketingOverview, type ChannelKey } from '@/actions/marketing-decomposition'
import { PaceForecast, type PaceMetric } from '@/components/decomposition/PaceBlocks'
import { computePace, periodProgress } from '@/lib/decomposition/pace'
import {
  SectionCard, TileGrid, PrimaryBtn, editInputStyle, LoadingBlocks,
  MONO, INK, ACCENT, MUTE, FAINT, LINE, STEEL, DASH,
} from './skeleton-ui'

const GREEN = '#1b7a4b', RED = '#c0392b', AMBER = '#b5732f'
const fmt  = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const pct  = (n: number | null) => n === null ? DASH : `${fmt1(n)}%`
const CH_LABEL: Record<ChannelKey, string> = { target: 'Таргет', organic: 'Органика', partner: 'Партнёры' }
const CH_ORDER: ChannelKey[] = ['target', 'organic', 'partner']

export default function MarketingOverviewScreen() {
  const [data, setData] = useState<MarketingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [shares, setShares] = useState<Record<ChannelKey, string>>({ target: '', organic: '', partner: '' })
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    let cancelled = false
    getMarketingOverview().then(d => {
      if (cancelled) return
      setData(d); setLoading(false)
      if (d) setShares({
        target:  d.channels.find(c => c.channel === 'target')?.sharePct?.toString() ?? '',
        organic: d.channels.find(c => c.channel === 'organic')?.sharePct?.toString() ?? '',
        partner: d.channels.find(c => c.channel === 'partner')?.sharePct?.toString() ?? '',
      })
    })
    return () => { cancelled = true }
  }, [reloadKey])

  const pace = useMemo<PaceMetric[]>(() => {
    if (!data) return []
    const { daysPassed, daysTotal } = periodProgress(data.period.start, data.period.end)
    const plan = data.totalPlan ?? 0
    const fact = data.totals.appealsFact
    return [{ label: 'Обращения', plan, fact, pace: computePace(plan, fact, daysPassed, daysTotal) }]
  }, [data])

  const shareSum = useMemo(() => CH_ORDER.reduce((s, ch) => s + (Number(shares[ch]) || 0), 0), [shares])

  if (loading && !data) return <LoadingBlocks />
  if (!data) return <SectionCard title="Нет доступа" subtitle="Недостаточно прав для просмотра сводки (marketing.view)." />

  const total = data.totalPlan
  const saveDistribution = () => {
    startSaving(async () => {
      const res = await saveChannelPlan(data.period.start, data.period.end, {
        target: Number(shares.target) || 0, organic: Number(shares.organic) || 0, partner: Number(shares.partner) || 0,
      })
      if (res.success) { toast.success('Распределение сохранено'); setReloadKey(k => k + 1) }
      else toast.error(res.error)
    })
  }

  const pd = (n: number | null) => n === null ? DASH : fmt(n)
  const perChannelPreview = (ch: ChannelKey) => total != null ? Math.round(total * (Number(shares[ch]) || 0) / 100) : null

  return (
    <div style={{ display: 'grid', gap: '24px' }}>

      {/* 1. План по каналам */}
      <SectionCard
        title="План по каналам"
        subtitle="Общий план обращений берётся из декомпозиции продаж. Здесь ты решаешь, с какого канала сколько обращений привести (в %)."
        chip={total != null ? `${fmt(total)} обращений` : 'нет плана продаж'}
      >
        {total == null ? (
          <div style={{ fontSize: '13px', color: MUTE }}>Нет активного плана продаж — распределение недоступно. Создайте план в декомпозиции отдела продаж.</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
              {CH_ORDER.map(ch => (
                <div key={ch} style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '15px 16px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: INK, marginBottom: '10px' }}>{CH_LABEL[ch]}</div>
                  {data.canEdit ? (
                    <>
                      <div style={{ position: 'relative' }}>
                        <input type="number" min={0} max={100} value={shares[ch]}
                          onChange={e => setShares(s => ({ ...s, [ch]: e.target.value }))}
                          placeholder="0" style={{ ...editInputStyle, fontFamily: MONO, paddingRight: '30px' }} />
                        <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: STEEL, fontSize: '13px', fontWeight: 600 }}>%</span>
                      </div>
                      <div style={{ fontSize: '12px', color: FAINT, marginTop: '8px', fontFamily: MONO }}>= {pd(perChannelPreview(ch))} обращений</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontFamily: MONO, fontSize: '22px', fontWeight: 600, color: INK }}>{fmt1(Number(shares[ch]) || 0)}<span style={{ fontSize: '13px', color: STEEL }}>%</span></div>
                      <div style={{ fontSize: '12px', color: FAINT, marginTop: '6px', fontFamily: MONO }}>= {pd(perChannelPreview(ch))} обращений</div>
                    </>
                  )}
                </div>
              ))}
            </div>
            {data.canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryBtn onClick={saveDistribution} disabled={saving}>Сохранить распределение</PrimaryBtn>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: shareSum === 100 ? GREEN : shareSum > 100 ? RED : AMBER }}>
                  Сумма долей: {fmt1(shareSum)}%{shareSum !== 100 ? (shareSum > 100 ? ' — превышение' : ' — не распределено полностью') : ' ✓'}
                </span>
              </div>
            )}
            {!data.hasDistribution && !data.canEdit && (
              <div style={{ fontSize: '12.5px', color: MUTE, marginTop: '12px' }}>Распределение по каналам ещё не задано — показан общий план.</div>
            )}
          </>
        )}
      </SectionCard>

      {/* 2. План vs Факт по каналам */}
      <SectionCard title="План vs Факт по каналам" subtitle="Обращения (план/факт), продажи, выручка, % выполнения. ИТОГО — по трём каналам маркетинга.">
        <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '760px', fontSize: '12px', fontFamily: MONO }}>
            <thead>
              <tr>
                {['Канал', 'Обращения план', 'Обращения факт', 'Продажи', 'Выручка', '% выполнения'].map((h, i) => (
                  <th key={h} style={{ background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', textAlign: i === 0 ? 'left' : 'right', borderLeft: i === 0 ? undefined : '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.channels.map(c => {
                const pc = c.pct
                const color = pc === null ? FAINT : pc >= 100 ? GREEN : pc >= 80 ? AMBER : RED
                return (
                  <tr key={c.channel}>
                    <td style={{ padding: '9px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK }}>{CH_LABEL[c.channel]}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: c.appealsPlan === null ? FAINT : MUTE }}>{c.appealsPlan === null ? DASH : fmt(c.appealsPlan)}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: INK, fontWeight: 500 }}>{fmt(c.appealsFact)}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: c.sales ? INK : FAINT }}>{c.sales ? fmt(c.sales) : DASH}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: c.revenue ? INK : FAINT }}>{c.revenue ? fmt(c.revenue) : DASH}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color, fontWeight: 700 }}>{pct(pc)}</td>
                  </tr>
                )
              })}
              <tr>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#fff', fontFamily: "'Golos Text', sans-serif", fontWeight: 700 }}>ИТОГО</td>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#cfe6f1', textAlign: 'right', fontWeight: 700 }}>{data.totals.appealsPlan === null ? DASH : fmt(data.totals.appealsPlan)}</td>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#fff', textAlign: 'right', fontWeight: 700 }}>{fmt(data.totals.appealsFact)}</td>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#fff', textAlign: 'right', fontWeight: 700 }}>{fmt(data.totals.sales)}</td>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#fff', textAlign: 'right', fontWeight: 700 }}>{fmt(data.totals.revenue)}</td>
                <td style={{ padding: '10px 12px', background: '#14304a', color: '#fff', textAlign: 'right', fontWeight: 700 }}>{pct(data.totals.pct)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* 3. Прогноз + светофор */}
      <PaceForecast metrics={pace} subtitle="Обращения в целом: если темп не изменится — таким будет итог периода" />

      {/* 4. Реальная конверсия по каналам */}
      <SectionCard title="Реальная конверсия по каналам" subtitle="Обращение → продажа и средний чек по каждому каналу — где трафик доходит до денег">
        <TileGrid min={220}>
          {data.channels.map(c => (
            <div key={c.channel} style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '15px 16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: INK, marginBottom: '10px' }}>{CH_LABEL[c.channel]}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: MONO, fontSize: '24px', fontWeight: 600, color: c.conversion === null ? FAINT : ACCENT, lineHeight: 1 }}>{pct(c.conversion)}</div>
                  <div style={{ fontSize: '11px', color: FAINT, marginTop: '5px' }}>обращение → продажа</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: MONO, fontSize: '16px', fontWeight: 600, color: c.avgCheck === null ? FAINT : INK }}>{c.avgCheck === null ? DASH : fmt(c.avgCheck)}</div>
                  <div style={{ fontSize: '11px', color: FAINT, marginTop: '4px' }}>средний чек</div>
                </div>
              </div>
            </div>
          ))}
        </TileGrid>
      </SectionCard>

      {/* 5. Обращения по дням */}
      <SectionCard title="Обращения по дням" subtitle="План (общий поровну на дни) и факт обращений по каналам — сколько обращений пришло каждый день" chip={`${data.daily.length} дн.`}>
        <div style={{ overflow: 'auto', maxHeight: '520px', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '720px', fontSize: '12px', fontFamily: MONO }}>
            <thead>
              <tr>
                {['Дата', 'План', 'Таргет', 'Органика', 'Партнёры', 'Факт'].map((h, i) => (
                  <th key={h} style={{ position: 'sticky', top: 0, zIndex: 1, background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', textAlign: i === 0 ? 'left' : 'right', borderLeft: i === 0 ? undefined : '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.daily.map(d => (
                <tr key={d.date}>
                  <td style={{ padding: '7px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>{d.date.slice(8, 10)}.{d.date.slice(5, 7)}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: MUTE }}>{d.planTotal === null ? DASH : fmt(d.planTotal)}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: d.target ? INK : FAINT }}>{d.target ? fmt(d.target) : DASH}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: d.organic ? INK : FAINT }}>{d.organic ? fmt(d.organic) : DASH}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: d.partner ? INK : FAINT }}>{d.partner ? fmt(d.partner) : DASH}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: d.factTotal ? INK : FAINT, fontWeight: 600 }}>{d.factTotal ? fmt(d.factTotal) : DASH}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700 }}>Итого</td>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#cfe6f1', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{data.totalPlan === null ? DASH : fmt(data.totalPlan)}</td>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(data.channels.find(c => c.channel === 'target')?.appealsFact ?? 0)}</td>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(data.channels.find(c => c.channel === 'organic')?.appealsFact ?? 0)}</td>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(data.channels.find(c => c.channel === 'partner')?.appealsFact ?? 0)}</td>
                <td style={{ position: 'sticky', bottom: 0, background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(data.totals.appealsFact)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

    </div>
  )
}
