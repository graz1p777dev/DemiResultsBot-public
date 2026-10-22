import type { ReactNode } from 'react'

type BadgeVariant =
  | 'money'
  | 'expense'
  | 'growth'
  | 'percent'
  | 'target'
  | 'chat'
  | 'people'
  | 'campaign'
  | 'check'
  | 'box'
  | 'truck'
  | 'sync'
  | 'eye'
  | 'calendar'
  | 'funnel'
  | 'ban'
  | 'default'

const VARIANT_TONES: Record<BadgeVariant, { bg: string; fg: string; accent: string }> = {
  money: { bg: 'linear-gradient(135deg,#15b981 0%,#0c4d6c 100%)', fg: '#ffffff', accent: '#bbf7d0' },
  expense: { bg: 'linear-gradient(135deg,#f97316 0%,#ef4444 100%)', fg: '#ffffff', accent: '#fed7aa' },
  growth: { bg: 'linear-gradient(135deg,#0c4d6c 0%,#10b981 100%)', fg: '#ffffff', accent: '#bdf4e5' },
  percent: { bg: 'linear-gradient(135deg,#2563eb 0%,#0c4d6c 100%)', fg: '#ffffff', accent: '#bfdbfe' },
  target: { bg: 'linear-gradient(135deg,#7c3aed 0%,#2563eb 100%)', fg: '#ffffff', accent: '#ddd6fe' },
  chat: { bg: 'linear-gradient(135deg,#06b6d4 0%,#0c4d6c 100%)', fg: '#ffffff', accent: '#cffafe' },
  people: { bg: 'linear-gradient(135deg,#6366f1 0%,#0c4d6c 100%)', fg: '#ffffff', accent: '#c7d2fe' },
  campaign: { bg: 'linear-gradient(135deg,#ec4899 0%,#7c3aed 100%)', fg: '#ffffff', accent: '#fbcfe8' },
  check: { bg: 'linear-gradient(135deg,#16a34a 0%,#0f766e 100%)', fg: '#ffffff', accent: '#bbf7d0' },
  box: { bg: 'linear-gradient(135deg,#0891b2 0%,#0c4d6c 100%)', fg: '#ffffff', accent: '#a5f3fc' },
  truck: { bg: 'linear-gradient(135deg,#f59e0b 0%,#c2410c 100%)', fg: '#ffffff', accent: '#fde68a' },
  sync: { bg: 'linear-gradient(135deg,#475569 0%,#0c2136 100%)', fg: '#ffffff', accent: '#cbd5e1' },
  eye: { bg: 'linear-gradient(135deg,#0f766e 0%,#14b8a6 100%)', fg: '#ffffff', accent: '#99f6e4' },
  calendar: { bg: 'linear-gradient(135deg,#0891b2 0%,#2563eb 100%)', fg: '#ffffff', accent: '#a5f3fc' },
  funnel: { bg: 'linear-gradient(135deg,#f59e0b 0%,#ef4444 100%)', fg: '#ffffff', accent: '#fde68a' },
  ban: { bg: 'linear-gradient(135deg,#ef4444 0%,#0c2136 100%)', fg: '#ffffff', accent: '#fecaca' },
  default: { bg: 'linear-gradient(135deg,#64748b 0%,#0c2136 100%)', fg: '#ffffff', accent: '#e2e8f0' },
}

function resolveVariant(name: string): BadgeVariant {
  const n = name.toLowerCase()
  if (/revenue|avgcheck|avg-check|receipt|ср\. чек|выруч|чек|money/.test(n)) return 'money'
  if (/expense|spend|cost|расход|доставка|drr|cpc|cpm|cpl/.test(n)) return 'expense'
  if (/profit|romi|growth|приб|рост/.test(n)) return 'growth'
  if (/margin|ctr|percent|rate|процент|марж|дрр/.test(n)) return 'percent'
  if (/target|plan|goal|план|цель/.test(n)) return 'target'
  if (/appeals|message|обращ|dialog|chat/.test(n)) return 'chat'
  if (/people|payroll|consult|lead|фот|консульт|лиды/.test(n)) return 'people'
  if (/marketing|campaign|megaphone|реклам|кампан/.test(n)) return 'campaign'
  if (/sales|check|qualified|hot|продаж|квал/.test(n)) return 'check'
  if (/supplies|rent|other|box|аренд|проч|расходники/.test(n)) return 'box'
  if (/truck|delivery|достав/.test(n)) return 'truck'
  if (/conv|conversion|sync|конв/.test(n)) return 'sync'
  if (/impressions|reach|click|views|number|показы|охват|клики/.test(n)) return 'eye'
  return 'default'
}

function Glyph({ variant, fg, accent }: { variant: BadgeVariant; fg: string; accent: string }): ReactNode {
  switch (variant) {
    case 'money':
      return (
        <>
          <path d="M8 17.5h8M12 17.5V6.7" stroke={fg} strokeWidth="1.9" strokeLinecap="round" />
          <path d="M15.2 8.2c-.7-.6-1.65-.95-2.85-.95-2 0-3.4 1.1-3.4 2.75 0 3.4 6.6 1.55 6.6 4.65 0 1.65-1.45 2.75-3.5 2.75-1.35 0-2.45-.38-3.25-1.05" stroke={accent} strokeWidth="1.75" strokeLinecap="round" />
        </>
      )
    case 'expense':
      return (
        <>
          <path d="M7 8.5h10M7 12h7" stroke={fg} strokeWidth="1.8" strokeLinecap="round" />
          <path d="m14.7 14.2 2.4 2.4 2.4-2.4M17.1 16.6V8.8" stroke={accent} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'growth':
      return <path d="M5.5 16.5 10 12l3 3 5.5-6M15 8.5h3.5V12" stroke={fg} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    case 'percent':
      return (
        <>
          <path d="M7 17 17 7" stroke={fg} strokeWidth="2" strokeLinecap="round" />
          <circle cx="8.5" cy="8.5" r="2" stroke={accent} strokeWidth="1.8" />
          <circle cx="15.5" cy="15.5" r="2" stroke={accent} strokeWidth="1.8" />
        </>
      )
    case 'target':
      return (
        <>
          <circle cx="12" cy="12" r="6.5" stroke={fg} strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3" stroke={accent} strokeWidth="1.8" />
          <circle cx="12" cy="12" r="1" fill={fg} />
        </>
      )
    case 'chat':
      return <path d="M6.5 8.2h11v7.1h-5.4l-3.1 2.2v-2.2H6.5V8.2Z" stroke={fg} strokeWidth="1.8" strokeLinejoin="round" />
    case 'people':
      return (
        <>
          <circle cx="9" cy="9" r="2.25" stroke={accent} strokeWidth="1.8" />
          <circle cx="15.2" cy="9.8" r="1.8" stroke={fg} strokeWidth="1.7" />
          <path d="M5.8 17.2c.6-2.15 1.9-3.3 3.4-3.3s2.8 1.15 3.4 3.3M13 17.2c.45-1.55 1.25-2.35 2.35-2.35 1.15 0 2 .8 2.5 2.35" stroke={fg} strokeWidth="1.75" strokeLinecap="round" />
        </>
      )
    case 'campaign':
      return (
        <>
          <path d="M6.5 13h3.3l7-4.2v8.4l-7-4.2" stroke={fg} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8.8 13.1 10 18M18 10.5l1.8-.9M18 15.5l1.8.9" stroke={accent} strokeWidth="1.7" strokeLinecap="round" />
        </>
      )
    case 'check':
      return <path d="m6.5 12.4 3.5 3.5 7.5-8" stroke={fg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    case 'box':
      return (
        <>
          <path d="M7 9.5 12 6l5 3.5v6.8L12 19l-5-2.7V9.5Z" stroke={fg} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M7.3 9.7 12 12.4l4.7-2.7M12 12.4V19" stroke={accent} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'truck':
      return (
        <>
          <path d="M5.5 9h8.5v6.2H5.5V9ZM14 11h2.7l1.8 2.2v2H14v-4.2Z" stroke={fg} strokeWidth="1.7" strokeLinejoin="round" />
          <circle cx="8" cy="16.4" r="1.3" stroke={accent} strokeWidth="1.5" />
          <circle cx="16.5" cy="16.4" r="1.3" stroke={accent} strokeWidth="1.5" />
        </>
      )
    case 'sync':
      return (
        <>
          <path d="M17.5 9.5A5.9 5.9 0 0 0 7.4 8.1L6 9.5M6.5 14.5a5.9 5.9 0 0 0 10.1 1.4l1.4-1.4" stroke={fg} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M6 6.5v3h3M18 17.5v-3h-3" stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'eye':
      return (
        <>
          <path d="M5.6 12s2.3-4 6.4-4 6.4 4 6.4 4-2.3 4-6.4 4-6.4-4-6.4-4Z" stroke={fg} strokeWidth="1.8" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2" stroke={accent} strokeWidth="1.7" />
        </>
      )
    case 'calendar':
      return (
        <>
          <rect x="5.5" y="7" width="13" height="11.5" rx="2" stroke={fg} strokeWidth="1.8" />
          <path d="M5.5 10.6h13" stroke={fg} strokeWidth="1.6" />
          <path d="M9 5.5v3M15 5.5v3" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="9.3" cy="13.9" r="1.05" fill={accent} />
          <circle cx="12.8" cy="13.9" r="1.05" fill={accent} />
        </>
      )
    case 'funnel':
      return (
        <>
          <path d="M5.8 6.8h12.4l-4.85 5.6v4.9l-2.7 1.6v-6.5L5.8 6.8Z" stroke={fg} strokeWidth="1.75" strokeLinejoin="round" />
          <path d="M8.4 9.3h7.2" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
        </>
      )
    case 'ban':
      return (
        <>
          <circle cx="12" cy="12" r="6.6" stroke={fg} strokeWidth="1.9" />
          <path d="m7.7 7.7 8.6 8.6" stroke={accent} strokeWidth="1.9" strokeLinecap="round" />
        </>
      )
    default:
      return (
        <>
          <circle cx="7.5" cy="12" r="1.8" fill={accent} />
          <circle cx="12" cy="12" r="1.8" fill={fg} />
          <circle cx="16.5" cy="12" r="1.8" fill={accent} />
        </>
      )
  }
}

export function MetricIconBadge({
  name,
  variant: forcedVariant,
  className = '',
}: {
  name: string
  /** Явный вариант — когда имя метрики не должно определять иконку. */
  variant?: BadgeVariant
  className?: string
}) {
  const variant = forcedVariant ?? resolveVariant(name)
  const tone = VARIANT_TONES[variant]

  return (
    <span
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl shadow-sm ${className}`}
      style={{ background: tone.bg, boxShadow: '0 10px 20px rgba(12,33,54,0.14)' }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
        <Glyph variant={variant} fg={tone.fg} accent={tone.accent} />
      </svg>
    </span>
  )
}
