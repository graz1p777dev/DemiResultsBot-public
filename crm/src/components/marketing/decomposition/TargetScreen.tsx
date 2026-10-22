'use client'

// Экран «Таргет» — платный трафик (один таргетолог, селектор внутри вкладки).
// Логика этапа 1: ежедневный ввод (бюджет в $ → сомы по курсу пополнения),
// метрики (CPI/ДРР/конверсия/чек), сверка кабинет↔ЛМ, таблица по дням, реестр пополнений.
// Выручка/продажи канала — из consultations source='target' (атрибуция, миграция 061).

import { useState, useEffect, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getMarketingTargetologs, getTargetTabData, saveMarketingDaily, createMarketingTopup,
  type TargetologOption, type TargetTabData,
} from '@/actions/marketing-decomposition'
import { SectionCard, TileGrid, StatTile, cardStyle, LoadingBlocks, MONO, INK, ACCENT, MUTE, FAINT, LINE, STEEL, DASH } from './skeleton-ui'

const fmt  = (n: number) => Math.round(n).toLocaleString('ru-RU')
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const pct  = (n: number | null) => n === null ? DASH : `${fmt1(n)}%`

const monthBounds = () => {
  const now = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) }
}

const editBox: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #d3dde3', borderRadius: '10px',
  fontSize: '14px', fontFamily: MONO, fontWeight: 500, background: '#fff', color: INK, boxSizing: 'border-box',
}
const lbl: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#45596a', display: 'block', marginBottom: '6px' }

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={lbl}>{label}</span>
      <input type="number" min={0} value={value} onChange={e => onChange(e.target.value)} placeholder="0" style={editBox} />
    </label>
  )
}

const emptyDaily = { date: '', active_campaigns: '', reach: '', clicks: '', budget_usd: '', ad_appeals: '', lm_appeals: '' }
const emptyTopup = { date: '', amount_usd: '', amount_som: '', note: '' }

export default function TargetScreen() {
  const [period, setPeriod] = useState(monthBounds)
  const [targetologs, setTargetologs] = useState<TargetologOption[]>([])
  const [selected, setSelected] = useState('')
  const [data, setData] = useState<TargetTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [daily, setDaily] = useState(emptyDaily)
  const [topup, setTopup] = useState(emptyTopup)
  const [saving, startSaving] = useTransition()

  const reload = () => setReloadKey(k => k + 1)

  useEffect(() => {
    getMarketingTargetologs().then(list => {
      setTargetologs(list)
      setSelected(prev => prev || (list[0]?.id ?? ''))
      if (list.length === 0) setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    getTargetTabData(selected, period.start, period.end).then(d => {
      if (!cancelled) { setData(d); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [selected, period.start, period.end, reloadKey])

  // ── Метрики периода ─────────────────────────────────────────────────────────
  const m = useMemo(() => {
    const rows = data?.daily ?? []
    const budgetSom = rows.reduce((s, r) => s + r.budget, 0)
    const budgetUsd = rows.reduce((s, r) => s + r.budget_usd, 0)
    const adAppeals = rows.reduce((s, r) => s + r.ad_appeals, 0)
    const lmAppeals = rows.reduce((s, r) => s + r.lm_appeals, 0)
    const daysWithBudget = rows.filter(r => r.budget_usd > 0).length
    const revenue = data?.targetRevenue ?? 0
    const sales   = data?.targetSales ?? 0
    const cpi     = adAppeals > 0 ? budgetSom / adAppeals : null
    return {
      budgetSom, budgetUsd, adAppeals, lmAppeals, revenue, sales,
      cpi,
      drr:       revenue > 0 ? (budgetSom / revenue) * 100 : null,
      convSale:  adAppeals > 0 ? (sales / adAppeals) * 100 : null,
      avgCheck:  sales > 0 ? revenue / sales : null,
      appealsForBudget: cpi && cpi > 0 ? budgetSom / cpi : null,
      avgBudgetDay: daysWithBudget > 0 ? budgetSom / daysWithBudget : null,
      gapAbs:    adAppeals - lmAppeals,
      gapPct:    adAppeals > 0 ? ((adAppeals - lmAppeals) / adAppeals) * 100 : null,
    }
  }, [data])

  // ── Сохранение дневного ввода ─────────────────────────────────────────────────
  const saveDaily = () => {
    if (!selected) { toast.error('Выберите таргетолога'); return }
    if (!daily.date) { toast.error('Укажите дату'); return }
    startSaving(async () => {
      const res = await saveMarketingDaily(selected, daily.date, {
        active_campaigns: Number(daily.active_campaigns) || 0,
        reach:            Number(daily.reach) || 0,
        clicks:           Number(daily.clicks) || 0,
        ad_appeals:       Number(daily.ad_appeals) || 0,
        lm_appeals:       Number(daily.lm_appeals) || 0,
        budget_usd:       Number(daily.budget_usd) || 0,
      })
      if (res.success) { toast.success('День сохранён'); setDaily(emptyDaily); reload() }
      else toast.error(res.error)
    })
  }

  const saveTopup = () => {
    if (!selected) { toast.error('Выберите таргетолога'); return }
    startSaving(async () => {
      const res = await createMarketingTopup(selected, {
        date: topup.date,
        amount_usd: Number(topup.amount_usd) || 0,
        amount_som: Number(topup.amount_som) || 0,
        note: topup.note || null,
      })
      if (res.success) { toast.success('Пополнение добавлено'); setTopup(emptyTopup); reload() }
      else toast.error(res.error)
    })
  }

  if (loading && !data) {
    return <LoadingBlocks />
  }

  if (targetologs.length === 0) {
    return <SectionCard title="Нет таргетологов" subtitle="В охвате нет активных таргетологов — добавьте сотрудника с ролью «Таргетолог» в отдел маркетинга." />
  }

  return (
    <div style={{ display: 'grid', gap: '24px' }}>

      {/* Панель: таргетолог + период */}
      <section style={{ ...cardStyle, display: 'flex', gap: '18px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'block' }}>
          <span style={lbl}>Таргетолог</span>
          <select value={selected} onChange={e => setSelected(e.target.value)} style={{ ...editBox, minWidth: '220px', fontFamily: 'inherit' }}>
            {targetologs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'block' }}>
          <span style={lbl}>Начало периода</span>
          <input type="date" value={period.start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} style={editBox} />
        </label>
        <label style={{ display: 'block' }}>
          <span style={lbl}>Конец периода</span>
          <input type="date" value={period.end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} style={editBox} />
        </label>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: FAINT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Курс (посл. пополнение)</div>
          <div style={{ fontFamily: MONO, fontSize: '18px', fontWeight: 700, color: ACCENT }}>
            {data?.currentRate != null ? `${fmt1(data.currentRate)} сом/$` : DASH}
          </div>
        </div>
      </section>

      {/* Ежедневный ввод */}
      <SectionCard title="Ежедневный ввод" subtitle="Бюджет вводится в $ — пересчёт в сомы по курсу последнего пополнения">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <label style={{ display: 'block' }}><span style={lbl}>Дата</span>
            <input type="date" value={daily.date} onChange={e => setDaily(d => ({ ...d, date: e.target.value }))} style={editBox} /></label>
          <NumField label="Работающих РК" value={daily.active_campaigns} onChange={v => setDaily(d => ({ ...d, active_campaigns: v }))} />
          <NumField label="Охваты" value={daily.reach} onChange={v => setDaily(d => ({ ...d, reach: v }))} />
          <NumField label="Клики" value={daily.clicks} onChange={v => setDaily(d => ({ ...d, clicks: v }))} />
          <NumField label="Бюджет, $" value={daily.budget_usd} onChange={v => setDaily(d => ({ ...d, budget_usd: v }))} />
          <NumField label="Обращения (кабинет)" value={daily.ad_appeals} onChange={v => setDaily(d => ({ ...d, ad_appeals: v }))} />
          <NumField label="Обращения (ЛМ)" value={daily.lm_appeals} onChange={v => setDaily(d => ({ ...d, lm_appeals: v }))} />
        </div>
        <div style={{ marginTop: '16px' }}>
          <button onClick={saveDaily} disabled={saving}
            style={{ background: saving ? '#5c6f7c' : ACCENT, color: '#fff', border: 'none', borderRadius: '10px', padding: '11px 22px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Сохранение…' : '＋ Сохранить день'}
          </button>
        </div>
      </SectionCard>

      {/* Метрики */}
      <SectionCard title="Метрики" subtitle="За выбранный период. Выручка/продажи — из консультаций с источником «Таргет».">
        <TileGrid min={185}>
          <StatTile label="Цена обращения (CPI)" unit="сом" hint="бюджет ÷ обращения (кабинет)" value={m.cpi != null ? fmt(m.cpi) : null} />
          <StatTile label="Доля рекламных расходов (ДРР)" unit="%" hint="бюджет ÷ выручка" value={m.drr != null ? fmt1(m.drr) : null} />
          <StatTile label="Конверсия обращение → продажа" unit="%" value={m.convSale != null ? fmt1(m.convSale) : null} />
          <StatTile label="Средний чек" unit="сом" value={m.avgCheck != null ? fmt(m.avgCheck) : null} />
          <StatTile label="Хватит бюджета на" unit="обращений" hint="бюджет ÷ CPI" value={m.appealsForBudget != null ? fmt(m.appealsForBudget) : null} />
          <StatTile label="Средний бюджет за день" unit="сом" value={m.avgBudgetDay != null ? fmt(m.avgBudgetDay) : null} />
          <StatTile label="Бюджет за период" unit="сом" hint={`${fmt(m.budgetUsd)} $`} value={fmt(m.budgetSom)} big />
          <StatTile label="Выручка (таргет)" unit="сом" hint={`${fmt(m.sales)} продаж`} value={fmt(m.revenue)} big />
        </TileGrid>
      </SectionCard>

      {/* Сверка кабинет vs ЛМ */}
      <SectionCard title="Сверка обращений: кабинет vs ЛМ" subtitle="Разрыв — это потери на переходе от рекламного кабинета к менеджеру">
        <TileGrid min={200}>
          <StatTile label="Обращения — кабинет" value={fmt(m.adAppeals)} big />
          <StatTile label="Обращения — ЛМ" value={fmt(m.lmAppeals)} big />
          <StatTile label="Разрыв" unit={m.gapPct != null ? `= ${pct(m.gapPct)}` : undefined} hint="кабинет − ЛМ" value={fmt(m.gapAbs)} big />
        </TileGrid>
      </SectionCard>

      {/* Таблица по дням */}
      <SectionCard title="Данные по дням" chip={`${data?.daily.length ?? 0} дн.`}>
        <div style={{ overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: '12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '900px', fontSize: '12px', fontFamily: MONO }}>
            <thead>
              <tr>
                {['Дата', 'РК', 'Охваты', 'Клики', 'Бюджет $', 'Бюджет сом', 'Обр. кабинет', 'Обр. ЛМ', 'CPI'].map((h, i) => (
                  <th key={h} style={{ background: INK, color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', textAlign: i === 0 ? 'left' : 'right', borderLeft: i === 0 ? undefined : '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.daily ?? []).map(r => {
                const cpi = r.ad_appeals > 0 ? r.budget / r.ad_appeals : null
                return (
                  <tr key={r.date}>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>
                      {r.date.slice(8, 10)}.{r.date.slice(5, 7)}
                    </td>
                    {[r.active_campaigns, r.reach, r.clicks].map((v, i) => (
                      <td key={i} style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: v ? INK : FAINT }}>{v ? fmt(v) : DASH}</td>
                    ))}
                    <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: r.budget_usd ? INK : FAINT }}>{r.budget_usd ? fmt(r.budget_usd) : DASH}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: r.budget ? INK : FAINT }}>{r.budget ? fmt(r.budget) : DASH}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: r.ad_appeals ? INK : FAINT }}>{r.ad_appeals ? fmt(r.ad_appeals) : DASH}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: r.lm_appeals ? INK : FAINT }}>{r.lm_appeals ? fmt(r.lm_appeals) : DASH}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: `1px solid ${LINE}`, color: cpi != null ? INK : FAINT }}>{cpi != null ? fmt(cpi) : DASH}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700 }}>Итого</td>
                <td style={{ background: '#14304a' }} />
                <td style={{ background: '#14304a' }} />
                <td style={{ background: '#14304a' }} />
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(m.budgetUsd)}</td>
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(m.budgetSom)}</td>
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(m.adAppeals)}</td>
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(m.lmAppeals)}</td>
                <td style={{ background: '#14304a', color: '#fff', padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{m.cpi != null ? fmt(m.cpi) : DASH}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      {/* Реестр пополнений */}
      <SectionCard title="Пополнения счёта" subtitle="Сомы → доллары по курсу дня. Курс (сом/$) считается автоматически из реально списанной суммы.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px', alignItems: 'end' }}>
          <label style={{ display: 'block' }}><span style={lbl}>Дата</span>
            <input type="date" value={topup.date} onChange={e => setTopup(t => ({ ...t, date: e.target.value }))} style={editBox} /></label>
          <NumField label="Зачислено, $" value={topup.amount_usd} onChange={v => setTopup(t => ({ ...t, amount_usd: v }))} />
          <NumField label="Списано, сом" value={topup.amount_som} onChange={v => setTopup(t => ({ ...t, amount_som: v }))} />
          <label style={{ display: 'block' }}><span style={lbl}>Заметка</span>
            <input type="text" value={topup.note} onChange={e => setTopup(t => ({ ...t, note: e.target.value }))} placeholder="необязательно" style={{ ...editBox, fontFamily: 'inherit' }} /></label>
          <div>
            <button onClick={saveTopup} disabled={saving}
              style={{ background: saving ? '#5c6f7c' : INK, color: '#fff', border: 'none', borderRadius: '10px', padding: '11px 18px', fontSize: '13.5px', fontWeight: 600, cursor: saving ? 'default' : 'pointer', width: '100%' }}>
              ＋ Пополнить
            </button>
          </div>
        </div>

        {(data?.topups.length ?? 0) > 0 && (
          <div style={{ marginTop: '18px', display: 'grid', gap: '8px' }}>
            {data!.topups.map(t => (
              <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1fr', gap: '12px', alignItems: 'center', padding: '10px 14px', borderRadius: '10px', background: '#f4f7f9', border: `1px solid ${LINE}`, fontFamily: MONO, fontSize: '13px' }}>
                <span style={{ fontFamily: "'Golos Text', sans-serif", fontWeight: 600, color: INK }}>{t.date.slice(8, 10)}.{t.date.slice(5, 7)}.{t.date.slice(0, 4)}</span>
                <span style={{ color: MUTE }}>{fmt(t.amount_usd)} <span style={{ color: STEEL }}>$</span></span>
                <span style={{ color: MUTE }}>{fmt(t.amount_som)} <span style={{ color: STEEL }}>сом</span></span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: ACCENT }}>{fmt1(t.rate)} <span style={{ color: STEEL, fontWeight: 400 }}>сом/$</span></span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

    </div>
  )
}
