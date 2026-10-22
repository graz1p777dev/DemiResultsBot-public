'use client'

import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  getCompanyPlans,
  upsertCompanyPlan,
  getCompanyFact,
  getCompanyFactDaily,
  getManagerContributions,
  type FunnelFact,
  type DailyFactRow,
  type ManagerContribution,
} from '@/actions/company-plan'
import { computePace, periodProgress } from '@/lib/decomposition/pace'
import { PaceForecast, type PaceMetric } from './PaceBlocks'

// ─── Константы ────────────────────────────────────────────────────────────────

const GREEN = '#1b7a4b'
const RED   = '#c0392b'
const AMBER = '#b5732f'

const MONO = "'IBM Plex Mono', monospace"

const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU')

// ─── Чистые функции расчёта ───────────────────────────────────────────────────

interface FunnelCalc {
  raw:  { obr: number; lid: number; nv: number; fv: number; sale: number }
  plan: { obr: number; lid: number; nv: number; fv: number; sale: number; rev: number }
}

function calcFunnel(
  targetRevenue: number, avgCheck: number,
  cObrLid: number, cLidNv: number, cNvFv: number, cFvSale: number,
): FunnelCalc {
  const pct = (v: number) => (v > 0 ? v / 100 : 0)
  const saleRaw = avgCheck > 0 ? targetRevenue / avgCheck : 0
  const fvRaw   = cFvSale > 0 ? saleRaw / pct(cFvSale) : 0
  const nvRaw   = cNvFv   > 0 ? fvRaw   / pct(cNvFv)   : 0
  const lidRaw  = cLidNv  > 0 ? nvRaw   / pct(cLidNv)  : 0
  const obrRaw  = cObrLid > 0 ? lidRaw  / pct(cObrLid) : 0
  return {
    raw:  { obr: obrRaw, lid: lidRaw, nv: nvRaw, fv: fvRaw, sale: saleRaw },
    plan: {
      obr: Math.ceil(obrRaw), lid: Math.ceil(lidRaw), nv: Math.ceil(nvRaw),
      fv: Math.ceil(fvRaw), sale: Math.ceil(saleRaw), rev: targetRevenue,
    },
  }
}

/** Равномерное распределение: base + остаток на первые дни; сумма = total */
function distEven(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const rem  = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

// ─── Мелкие UI-хелперы ────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(12,33,54,0.08)',
  borderRadius: '16px',
  padding: '24px 26px',
  boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
}

function MoneyInput({ label, value, onChange, disabled, unit }: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
  unit: string
}) {
  return (
    <label style={{ display: 'block', marginBottom: '14px' }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#45596a' }}>{label}</span>
      <div style={{ position: 'relative', marginTop: '6px' }}>
        <input
          type="number"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={{
            width: '100%', padding: '11px 52px 11px 13px', border: '1px solid #d3dde3',
            borderRadius: '10px', fontSize: '15px', fontFamily: MONO, fontWeight: 500,
            background: disabled ? '#f3f6f7' : '#fff', color: '#0c2136', boxSizing: 'border-box',
          }}
        />
        <span style={{ position: 'absolute', right: '13px', top: '50%', transform: 'translateY(-50%)', fontSize: '12px', color: '#a2b4c0', fontWeight: 600 }}>{unit}</span>
      </div>
    </label>
  )
}

// ─── Общая декомпозиция компании ──────────────────────────────────────────────

export function CompanyDecomposition() {
  const { user } = useAuth()
  const isOwner = user?.role === 'owner'

  // Входные параметры (строки — чтобы поля можно было очищать)
  const [planId, setPlanId]       = useState<string | null>(null)
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd]     = useState('')
  const [targetRevenue, setTargetRevenue] = useState('2000000')
  const [avgCheck, setAvgCheck]           = useState('7000')
  const [cObrLid, setCObrLid] = useState('35')
  const [cLidNv, setCLidNv]   = useState('55')
  const [cNvFv, setCNvFv]     = useState('65')
  const [cFvSale, setCFvSale] = useState('45')

  const [factTotals, setFactTotals] = useState<FunnelFact | null>(null)
  const [dailyFact, setDailyFact]   = useState<DailyFactRow[]>([])
  const [contributions, setContributions] = useState<ManagerContribution[]>([])
  const [planLoading, setPlanLoading] = useState(true)
  const [saving, setSaving]           = useState(false)

  // ── Загрузка плана при монтировании ────────────────────────────────────────
  useEffect(() => {
    getCompanyPlans().then(plans => {
      const today = new Date().toISOString().slice(0, 10)
      const active = plans.find(p => p.date_start <= today && today <= p.date_end) ?? plans[0] ?? null
      if (active) {
        setPlanId(active.id)
        setDateStart(active.date_start)
        setDateEnd(active.date_end)
        setTargetRevenue(String(active.target_revenue))
        setAvgCheck(String(active.avg_check))
        setCObrLid(String(active.conv_appeal_lead))
        setCLidNv(String(active.conv_lead_nv))
        setCNvFv(String(active.conv_nv_fv))
        setCFvSale(String(active.conv_fv_sale))
      } else {
        // Дефолт — текущий месяц
        const now = new Date()
        const first = new Date(now.getFullYear(), now.getMonth(), 1)
        const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0)
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        setDateStart(iso(first))
        setDateEnd(iso(last))
      }
      setPlanLoading(false)
    })
  }, [])

  // ── Загрузка факта при смене дат ────────────────────────────────────────────
  useEffect(() => {
    if (!dateStart || !dateEnd || dateEnd < dateStart) return
    let cancelled = false
    Promise.all([
      getCompanyFact(dateStart, dateEnd),
      getCompanyFactDaily(dateStart, dateEnd),
      getManagerContributions(dateStart, dateEnd),
    ]).then(([totals, daily, contrib]) => {
      if (cancelled) return
      setFactTotals(totals)
      setDailyFact(daily)
      setContributions(contrib)
    })
    return () => { cancelled = true }
  }, [dateStart, dateEnd])

  // ── Сохранение плана ────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true)
    const res = await upsertCompanyPlan({
      date_start:       dateStart,
      date_end:         dateEnd,
      target_revenue:   Number(targetRevenue) || 0,
      avg_check:        Number(avgCheck) || 0,
      conv_appeal_lead: Number(cObrLid) || 0,
      conv_lead_nv:     Number(cLidNv) || 0,
      conv_nv_fv:       Number(cNvFv) || 0,
      conv_fv_sale:     Number(cFvSale) || 0,
    }, planId ?? undefined)
    setSaving(false)
    if (res.success) {
      setPlanId(res.id)
      toast.success(planId ? 'План обновлён' : 'План создан')
    } else {
      toast.error(res.error)
    }
  }

  // ── Расчёты ─────────────────────────────────────────────────────────────────
  const funnel = useMemo(() => calcFunnel(
    Number(targetRevenue) || 0, Number(avgCheck) || 0,
    Number(cObrLid) || 0, Number(cLidNv) || 0, Number(cNvFv) || 0, Number(cFvSale) || 0,
  ), [targetRevenue, avgCheck, cObrLid, cLidNv, cNvFv, cFvSale])

  const fact: FunnelFact = factTotals ?? {
    appeals: 0, leads: 0, nv: 0, fv: 0, sales: 0, revenue: 0,
    no_nv_visitors: 0, no_nv_fv: 0, no_nv_sales: 0, no_nv_revenue: 0,
  }

  const top = funnel.raw.obr || 1
  const barW   = (raw: number) => (42 + (raw / top) * 58).toFixed(1) + '%'
  const pctTop = (raw: number) => `${top > 0 ? Math.round((raw / top) * 100) : 0}% от вершины`

  // Порядок сверху вниз: цель (выручка) — первая, под ней разворачивается
  // активность, которая к ней ведёт. Чем ниже этап, тем он шире: от результата
  // к объёму работы, который нужно сделать.
  const funnelStages = [
    { label: 'Продажи',   sub: 'закрытие',      raw: funnel.raw.sale, val: funnel.plan.sale, color: '#1b86b0' },
    { label: 'ФВ',        sub: 'факт. визит',   raw: funnel.raw.fv,   val: funnel.plan.fv,   color: '#146a8f' },
    { label: 'НВ',        sub: 'назнач. визит', raw: funnel.raw.nv,   val: funnel.plan.nv,   color: '#0c4d6c' },
    { label: 'Квалифицированные лиды', sub: 'квалификация', raw: funnel.raw.lid, val: funnel.plan.lid, color: '#123a52' },
    { label: 'Обращения', sub: 'вход воронки',  raw: funnel.raw.obr,  val: funnel.plan.obr,  color: '#0c2136' },
  ]

  // План vs Факт
  const planFactRows = [
    { name: 'Обращения', plan: funnel.plan.obr,  factV: fact.appeals, money: false },
    { name: 'Квалифицированные лиды', plan: funnel.plan.lid, factV: fact.leads, money: false },
    { name: 'НВ',        plan: funnel.plan.nv,   factV: fact.nv,      money: false },
    { name: 'ФВ',        plan: funnel.plan.fv,   factV: fact.fv,      money: false },
    { name: 'Продажи',   plan: funnel.plan.sale, factV: fact.sales,   money: false },
    { name: 'Выручка',   plan: funnel.plan.rev,  factV: fact.revenue, money: true },
  ].map(r => {
    const diff = r.factV - r.plan
    const perc = r.plan > 0 ? (r.factV / r.plan) * 100 : 0
    const ok   = perc >= 100
    const near = perc >= 90 && perc < 100
    const suffix = r.money ? ' сом' : ''
    return {
      name:      r.name,
      planFmt:   fmt(r.plan) + suffix,
      factFmt:   fmt(r.factV) + suffix,
      diffFmt:   (diff >= 0 ? '+' : '') + fmt(diff) + suffix,
      diffColor: diff >= 0 ? GREEN : RED,
      pctFmt:    Math.round(perc) + '%',
      pctColor:  ok ? GREEN : (near ? AMBER : RED),
      barColor:  ok ? GREEN : (near ? AMBER : RED),
      barWidth:  Math.max(0, Math.min(100, perc)).toFixed(0) + '%',
    }
  })

  // Реальная конверсия
  const realConv = [
    { name: 'Обращение → Квалифицированный лид', target: Number(cObrLid) || 0, num: fact.leads, den: fact.appeals },
    { name: 'Квалифицированный лид → НВ',        target: Number(cLidNv)  || 0, num: fact.nv,    den: fact.leads },
    { name: 'НВ → ФВ',         target: Number(cNvFv)   || 0, num: fact.fv,    den: fact.nv },
    { name: 'ФВ → Продажа',    target: Number(cFvSale) || 0, num: fact.sales, den: fact.fv },
  ].map(c => {
    const factConv = c.den > 0 ? (c.num / c.den) * 100 : null
    const dev = factConv !== null ? factConv - c.target : null
    const above = dev !== null && dev >= 0
    return {
      name:      c.name,
      factFmt:   factConv !== null ? factConv.toFixed(1) + '%' : '—',
      targetFmt: c.target + '%',
      devFmt:    dev !== null ? Math.abs(dev).toFixed(1) + ' п.п.' : '',
      devArrow:  dev === null ? '' : (above ? '▲' : '▼'),
      devColor:  above ? GREEN : RED,
      factColor: factConv === null ? '#8a9aa6' : (above ? '#0c2136' : RED),
      tileBg:    factConv === null ? '#fff' : (above ? '#f4faf6' : '#fdf5f4'),
    }
  })

  // Таблица по дням: план — равномерно по календарным дням, факт — из БД
  const nDays = dailyFact.length
  const stagePlans = useMemo(() => ({
    appeals: distEven(funnel.plan.obr,  nDays),
    leads:   distEven(funnel.plan.lid,  nDays),
    nv:      distEven(funnel.plan.nv,   nDays),
    fv:      distEven(funnel.plan.fv,   nDays),
    sales:   distEven(funnel.plan.sale, nDays),
    revenue: distEven(funnel.plan.rev,  nDays),
  }), [funnel, nDays])

  const STAGE_KEYS = ['appeals', 'leads', 'nv', 'fv', 'sales', 'revenue'] as const
  const NO_NV_KEYS = ['no_nv_visitors', 'no_nv_sales', 'no_nv_revenue'] as const
  const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

  // ── Прогноз по текущему темпу (п.3) ────────────────────────────────────────
  // Считаем по календарным дням: план компании задан на календарный период.
  const { daysPassed, daysTotal } = periodProgress(dateStart, dateEnd)
  const paceMetrics: PaceMetric[] = [
    { label: 'Выручка',  plan: funnel.plan.rev,  fact: fact.revenue, money: true,
      pace: computePace(funnel.plan.rev,  fact.revenue, daysPassed, daysTotal) },
    { label: 'Продажи',  plan: funnel.plan.sale, fact: fact.sales,
      pace: computePace(funnel.plan.sale, fact.sales,   daysPassed, daysTotal) },
    { label: 'ФВ',       plan: funnel.plan.fv,   fact: fact.fv,
      pace: computePace(funnel.plan.fv,   fact.fv,      daysPassed, daysTotal) },
  ]

  const convFields = [
    { label: 'Обращение → Квалифицированный лид', value: cObrLid, set: setCObrLid },
    { label: 'Квалифицированный лид → НВ',        value: cLidNv,  set: setCLidNv },
    { label: 'НВ → ФВ',         value: cNvFv,   set: setCNvFv },
    { label: 'ФВ → Продажа',    value: cFvSale, set: setCFvSale },
  ]

  if (planLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#e6ebee', padding: '20px' }}>
        {[110, 300, 240, 400].map((h, i) => (
          <div key={i} className="animate-pulse" style={{ height: h, background: '#dde4e9', borderRadius: '16px', marginBottom: '16px' }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#e6ebee', paddingBottom: '56px', fontFamily: "'Golos Text', system-ui, sans-serif", color: '#0c2136' }}>

      {/* ===== HEADER ===== */}
      <header style={{ background: '#0c2136', color: '#fff', padding: '20px 40px', display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap', boxShadow: '0 2px 20px rgba(12,33,54,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, minWidth: '260px' }}>
          <div style={{ width: '46px', height: '46px', borderRadius: '12px', background: '#0c4d6c', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3px', flexShrink: 0 }}>
            <span style={{ display: 'block', width: '22px', height: '3px', borderRadius: '2px', background: '#e6ebee' }} />
            <span style={{ display: 'block', width: '15px', height: '3px', borderRadius: '2px', background: '#a2b4c0' }} />
            <span style={{ display: 'block', width: '8px', height: '3px', borderRadius: '2px', background: '#a2b4c0' }} />
          </div>
          <div>
            <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Demi Results OS</div>
            <div style={{ fontSize: '21px', fontWeight: 700, letterSpacing: '-0.01em', marginTop: '2px' }}>Общая декомпозиция отдела продаж</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '14px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Начало периода</span>
            <input
              type="date"
              value={dateStart}
              onChange={e => setDateStart(e.target.value)}
              disabled={!isOwner}
              style={{ background: '#14304a', border: '1px solid #2a4661', color: '#fff', borderRadius: '9px', padding: '9px 12px', fontSize: '14px', colorScheme: 'dark' }}
            />
          </label>
          <span style={{ color: '#a2b4c0', fontSize: '18px', paddingBottom: '9px' }}>→</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Конец периода</span>
            <input
              type="date"
              value={dateEnd}
              onChange={e => setDateEnd(e.target.value)}
              disabled={!isOwner}
              style={{ background: '#14304a', border: '1px solid #2a4661', color: '#fff', borderRadius: '9px', padding: '9px 12px', fontSize: '14px', colorScheme: 'dark' }}
            />
          </label>
          {isOwner && (
            <button
              onClick={handleSave}
              disabled={saving}
              style={{ background: saving ? '#5c6f7c' : (planId ? '#0c4d6c' : '#1b86b0'), color: '#fff', border: 'none', borderRadius: '9px', padding: '11px 20px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
            >
              <span style={{ fontSize: '16px', lineHeight: 1 }}>{planId ? '✎' : '+'}</span>
              {saving ? 'Сохранение…' : (planId ? 'Сохранить план' : 'Создать план')}
            </button>
          )}
        </div>
      </header>

      <div style={{ maxWidth: '1440px', margin: '0 auto', padding: '32px 40px 0' }}>

        {/* ===== TOP ROW: INPUTS + FUNNEL ===== */}
        <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: '24px', alignItems: 'start' }}>

          {/* INPUTS */}
          <section style={{ ...cardStyle, padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Входные параметры</h2>
              <span style={{ fontSize: '11px', fontWeight: 600, padding: '4px 9px', borderRadius: '999px', background: isOwner ? '#e2eef4' : '#eef1f3', color: isOwner ? '#0c4d6c' : '#8a9aa6', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                {isOwner ? '🔓 Владелец' : '🔒 Наблюдатель'}
              </span>
            </div>
            <p style={{ margin: '0 0 18px', fontSize: '12.5px', color: '#6b7d8a' }}>
              {isOwner ? 'Вы можете изменять параметры декомпозиции' : 'Только владелец может изменять параметры'}
            </p>

            <MoneyInput label="Целевая выручка" value={targetRevenue} onChange={setTargetRevenue} disabled={!isOwner} unit="сом" />
            <MoneyInput label="Средний чек" value={avgCheck} onChange={setAvgCheck} disabled={!isOwner} unit="сом" />

            <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#0c4d6c', margin: '20px 0 12px', paddingTop: '4px', borderTop: '1px solid #eef2f4' }}>Ориентиры конверсии</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              {convFields.map(cf => (
                <label key={cf.label} style={{ display: 'block' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#45596a' }}>{cf.label}</span>
                  <div style={{ position: 'relative', marginTop: '6px' }}>
                    <input
                      type="number"
                      value={cf.value}
                      onChange={e => cf.set(e.target.value)}
                      disabled={!isOwner}
                      style={{ width: '100%', padding: '10px 36px 10px 12px', border: '1px solid #d3dde3', borderRadius: '10px', fontSize: '15px', fontFamily: MONO, fontWeight: 500, background: isOwner ? '#fff' : '#f3f6f7', color: '#0c2136', boxSizing: 'border-box' }}
                    />
                    <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: '#a2b4c0', fontWeight: 600 }}>%</span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* FUNNEL */}
          <section style={{ background: '#0c2136', borderRadius: '16px', padding: '26px 30px 22px', boxShadow: '0 8px 30px rgba(12,33,54,0.22)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#fff' }}>Расчётная воронка</h2>
                <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#a2b4c0' }}>Декомпозиция цели по выручке в необходимую активность — пересчёт мгновенно</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Нужно обращений</div>
                <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600, color: '#7fc4e0' }}>{fmt(funnel.plan.obr)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* ЦЕЛЬ — первой строкой: от неё вниз разворачивается активность */}
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '14px' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#7fc4e0' }}>Выручка</div>
                  <div style={{ fontSize: '11px', color: '#6f8598' }}>цель периода</div>
                </div>
                <div style={{ background: 'linear-gradient(90deg, #0c4d6c, #146a8f)', borderRadius: '8px', padding: '15px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid #1b86b0' }}>
                  <span style={{ fontFamily: MONO, fontSize: '22px', fontWeight: 600, color: '#fff' }}>{fmt(funnel.plan.rev)}</span>
                  <span style={{ fontSize: '12px', color: '#cfe6f1', fontWeight: 500 }}>сом</span>
                </div>
              </div>

              {/* Разделитель «чтобы этого достичь, нужно:» */}
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '14px', margin: '2px 0 4px' }}>
                <div />
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '11px', color: '#6f8598', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    ↓ чтобы её получить, нужно
                  </span>
                  <span style={{ flex: 1, height: '1px', background: '#1c3a52' }} />
                </div>
              </div>

              {funnelStages.map(st => (
                <div key={st.label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '14px' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#e6ebee' }}>{st.label}</div>
                    <div style={{ fontSize: '11px', color: '#6f8598' }}>{st.sub}</div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: barW(st.raw), minWidth: '120px', background: st.color, borderRadius: '8px', padding: '13px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', transition: 'width 0.35s cubic-bezier(.4,0,.2,1)' }}>
                      <span style={{ fontFamily: MONO, fontSize: '19px', fontWeight: 600, color: '#fff' }}>{fmt(st.val)}</span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>{pctTop(st.raw)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ===== PLAN VS FACT ===== */}
        <section style={{ ...cardStyle, marginTop: '24px' }}>
          <h2 style={{ margin: '0 0 18px', fontSize: '16px', fontWeight: 700 }}>План vs Факт</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr 1.1fr', gap: 0, fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8a9aa6', fontWeight: 600, padding: '0 4px 10px', borderBottom: '1px solid #eef2f4' }}>
            <div>Этап</div>
            <div style={{ textAlign: 'right' }}>План</div>
            <div style={{ textAlign: 'right' }}>Факт</div>
            <div style={{ textAlign: 'right' }}>Разница</div>
            <div style={{ textAlign: 'right' }}>% выполнения</div>
          </div>
          {planFactRows.map(r => (
            <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr 1.1fr', gap: 0, alignItems: 'center', padding: '13px 4px', borderBottom: '1px solid #f2f5f7' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#0c2136' }}>{r.name}</div>
              <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: '14px', color: '#45596a' }}>{r.planFmt}</div>
              <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: '14px', color: '#0c2136', fontWeight: 500 }}>{r.factFmt}</div>
              <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: '14px', fontWeight: 600, color: r.diffColor }}>{r.diffFmt}</div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', justifyContent: 'flex-end' }}>
                  <span style={{ width: '54px', height: '6px', borderRadius: '4px', background: '#eef2f4', overflow: 'hidden', display: 'inline-block', position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: r.barWidth, background: r.barColor, borderRadius: '4px' }} />
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 600, color: r.pctColor, minWidth: '44px', textAlign: 'right' }}>{r.pctFmt}</span>
                </span>
              </div>
            </div>
          ))}
        </section>

        {/* ===== REAL CONVERSION + WITHOUT NV ===== */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: '24px', marginTop: '24px', alignItems: 'start' }}>

          <section style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Реальная конверсия</h2>
            <p style={{ margin: '0 0 18px', fontSize: '12.5px', color: '#6b7d8a' }}>Факт по каждому переходу воронки рядом с ориентиром</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              {realConv.map(c => (
                <div key={c.name} style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '15px 16px', background: c.tileBg }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#0c2136', marginBottom: '12px' }}>{c.name}</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontFamily: MONO, fontSize: '26px', fontWeight: 600, color: c.factColor, lineHeight: 1 }}>{c.factFmt}</div>
                      <div style={{ fontSize: '11px', color: '#8a9aa6', marginTop: '5px' }}>ориентир {c.targetFmt}</div>
                    </div>
                    {c.devArrow && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 700, color: c.devColor }}>
                        <span style={{ fontSize: '14px' }}>{c.devArrow}</span>{c.devFmt}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '4px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Посетители без записи</h2>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '3px 9px', borderRadius: '999px' }}>только факт</span>
            </div>
            <p style={{ margin: '0 0 18px', fontSize: '12.5px', color: '#6b7d8a' }}>Случайные клиенты — вне плановой воронки</p>

            <div style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' }}>
              <div style={{ fontSize: '12px', color: '#8a9aa6', fontWeight: 600 }}>Посетители без записи</div>
              <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 600, color: '#0c2136', marginTop: '4px' }}>{fmt(fact.no_nv_visitors)}</div>
            </div>
            <div style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' }}>
              <div style={{ fontSize: '12px', color: '#8a9aa6', fontWeight: 600 }}>Продажи без записи</div>
              <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 600, color: '#0c2136', marginTop: '4px' }}>{fmt(fact.no_nv_sales)}</div>
            </div>
            <div style={{ border: '1px solid #eef2f4', borderRadius: '12px', padding: '16px 18px', background: '#f6f9fa' }}>
              <div style={{ fontSize: '12px', color: '#8a9aa6', fontWeight: 600 }}>Выручка без записи</div>
              <div style={{ fontFamily: MONO, fontSize: '28px', fontWeight: 600, color: '#0c4d6c', marginTop: '4px' }}>
                {fmt(fact.no_nv_revenue)} <span style={{ fontSize: '14px', color: '#a2b4c0' }}>сом</span>
              </div>
            </div>
          </section>
        </div>

        {/* ===== ПРОГНОЗ + ВКЛАД МЕНЕДЖЕРОВ ===== */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '24px', marginTop: '24px', alignItems: 'start' }}>
          <PaceForecast
            metrics={paceMetrics}
            subtitle={`Прошло ${daysPassed} из ${daysTotal} дней периода. Если темп не изменится — таким будет итог.`}
          />

          {/* Вклад менеджеров (п.4) */}
          <section style={{ ...cardStyle }}>
            <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Вклад менеджеров</h2>
            <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#6b7d8a' }}>
              Кто сколько принёс за период — по факту продаж и выручки
            </p>

            {contributions.length === 0 ? (
              <div style={{ padding: '22px', textAlign: 'center', color: '#8a9aa6', fontSize: '13px', background: '#f4f7f9', borderRadius: '12px' }}>
                Нет активных менеджеров по продажам
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '8px' }}>
                {contributions.map((c, i) => (
                  <div key={c.employeeId} style={{ display: 'grid', gridTemplateColumns: '26px 1fr auto', gap: '12px', alignItems: 'center', padding: '11px 13px', borderRadius: '12px', background: i === 0 ? '#e6f4ec' : '#f4f7f9' }}>
                    <span style={{ fontFamily: MONO, fontSize: '13px', fontWeight: 700, color: i === 0 ? GREEN : '#8a9aa6', textAlign: 'center' }}>
                      {i + 1}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#0c2136', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      <div style={{ marginTop: '5px', height: '5px', borderRadius: '3px', background: '#e2e8ec', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(c.sharePct, 100)}%`, background: i === 0 ? GREEN : '#0c4d6c', borderRadius: '3px' }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontFamily: MONO, fontSize: '14px', fontWeight: 700, color: '#0c2136' }}>{fmt(c.revenue)}</div>
                      <div style={{ fontSize: '11px', color: '#6b7d8a', marginTop: '2px' }}>
                        {fmt(c.sales)} прод. · {Math.round(c.sharePct)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ===== DAILY TABLE ===== */}
        <section style={{ ...cardStyle, marginTop: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>План / Факт по дням</h2>
              <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#6b7d8a' }}>Дневной план = план периода, разделённый поровну на календарные дни. Выручка — в сомах.</p>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#0c4d6c', background: '#e2eef4', padding: '4px 10px', borderRadius: '999px' }}>{nDays} дн.</span>
          </div>

          <div style={{ overflow: 'auto', maxHeight: '560px', border: '1px solid #eef2f4', borderRadius: '12px' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: '1240px', fontSize: '11.5px', fontFamily: MONO, tableLayout: 'fixed' }}>
              {/* Ширины заданы явно: колонки «план/факт/разница» — рабочие, их читают
                  постоянно, поэтому шире. Колонки «без записи» — только справочный
                  факт, им хватает узких. Раньше всё делилось поровну и цифры
                  плана/факта жались. */}
              <colgroup>
                <col style={{ width: '86px' }} />
                {STAGE_KEYS.map(k => (
                  ['plan', 'fact', 'diff'].map(sub => (
                    <col key={`${k}-${sub}`} style={{ width: k === 'revenue' ? '86px' : '64px' }} />
                  ))
                ))}
                {NO_NV_KEYS.map(k => (
                  <col key={k} style={{ width: k === 'no_nv_revenue' ? '62px' : '48px' }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ position: 'sticky', left: 0, top: 0, zIndex: 4, background: '#0c2136', color: '#fff', textAlign: 'left', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', letterSpacing: '0.04em', minWidth: '78px' }}>Дата</th>
                  {['Обращения', 'Квал. лиды', 'НВ', 'ФВ', 'Продажи'].map(h => (
                    <th key={h} colSpan={3} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', borderLeft: '2px solid #24425c' }}>{h}</th>
                  ))}
                  <th colSpan={3} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#0c4d6c', color: '#fff', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '11px', borderLeft: '2px solid #1b86b0' }}>Выручка</th>
                  {['Посетители без записи', 'Продажи без записи', 'Выручка без записи'].map(h => (
                    <th key={h} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#123a52', color: '#cfe6f1', padding: '7px 8px', fontFamily: "'Golos Text', sans-serif", fontSize: '10px', borderLeft: '2px solid #24425c', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
                <tr>
                  {STAGE_KEYS.map(k => (
                    ['План', 'Факт', 'Разн.'].map((sub, j) => (
                      <th key={`${k}-${sub}`} style={{ position: 'sticky', top: '32px', zIndex: 3, background: '#eef2f4', color: '#6b7d8a', fontFamily: "'Golos Text', sans-serif", fontWeight: 600, fontSize: '10px', padding: '5px 8px', textAlign: 'right', borderLeft: j === 0 ? '2px solid #dbe3e8' : undefined }}>{sub}</th>
                    ))
                  ))}
                  {NO_NV_KEYS.map(k => (
                    <th key={`${k}-fact`} style={{ position: 'sticky', top: '32px', zIndex: 3, background: '#eef2f4', color: '#6b7d8a', fontFamily: "'Golos Text', sans-serif", fontWeight: 600, fontSize: '10px', padding: '5px 8px', textAlign: 'right', borderLeft: '2px solid #dbe3e8' }}>Факт</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dailyFact.map((d, i) => {
                  const dt = new Date(d.date + 'T00:00:00')
                  const weekend = dt.getDay() === 0 || dt.getDay() === 6
                  return (
                    <tr key={d.date}>
                      <td style={{ position: 'sticky', left: 0, zIndex: 2, background: weekend ? '#f5f8f9' : '#ffffff', padding: '5px 10px', borderBottom: '1px solid #f2f5f7', whiteSpace: 'nowrap', fontFamily: "'Golos Text', sans-serif" }}>
                        <span style={{ fontWeight: 600, color: '#0c2136' }}>{String(dt.getDate()).padStart(2, '0')}.{String(dt.getMonth() + 1).padStart(2, '0')}</span>
                        <span style={{ color: weekend ? '#b06a5a' : '#8a9aa6', fontSize: '10px', marginLeft: '5px' }}>{DOW[dt.getDay()]}</span>
                      </td>
                      {STAGE_KEYS.map(k => {
                        const p = stagePlans[k][i] ?? 0
                        const f = d[k]
                        return <DayCells key={k} p={p} f={f} />
                      })}
                      {NO_NV_KEYS.map(k => (
                        <td key={k} style={{ padding: '5px 8px', textAlign: 'right', color: '#0c2136', fontWeight: 500, borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(d[k])}</td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 3, background: '#0c2136', color: '#fff', padding: '8px 10px', fontFamily: "'Golos Text', sans-serif", fontWeight: 700, fontSize: '12px' }}>Итого</td>
                  {STAGE_KEYS.map(k => {
                    const p = stagePlans[k].reduce((a, b) => a + b, 0)
                    const f = dailyFact.reduce((a, d) => a + d[k], 0)
                    return <TotalCells key={k} p={p} f={f} />
                  })}
                  {NO_NV_KEYS.map(k => (
                    <td key={k} style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>
                      {fmt(dailyFact.reduce((a, d) => a + d[k], 0))}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

// ─── Ячейки таблицы по дням ───────────────────────────────────────────────────

function DayCells({ p, f }: { p: number; f: number }) {
  const diff = f - p
  return (
    <>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8a9aa6', borderBottom: '1px solid #f2f5f7', borderLeft: '2px solid #f0f3f5' }}>{fmt(p)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#0c2136', fontWeight: 500, borderBottom: '1px solid #f2f5f7' }}>{fmt(f)}</td>
      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: diff >= 0 ? GREEN : RED, borderBottom: '1px solid #f2f5f7' }}>{(diff >= 0 ? '+' : '') + fmt(diff)}</td>
    </>
  )
}

function TotalCells({ p, f }: { p: number; f: number }) {
  const diff = f - p
  return (
    <>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#cfe6f1', padding: '8px', textAlign: 'right', fontWeight: 600, borderLeft: '2px solid #24425c' }}>{fmt(p)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', color: '#fff', padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmt(f)}</td>
      <td style={{ position: 'sticky', bottom: 0, zIndex: 2, background: '#14304a', padding: '8px', textAlign: 'right', fontWeight: 700, color: diff >= 0 ? '#7ed6a5' : '#f0a094' }}>{(diff >= 0 ? '+' : '') + fmt(diff)}</td>
    </>
  )
}
