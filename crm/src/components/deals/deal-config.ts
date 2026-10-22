import { Camera, MessageCircle, PenLine, Send, Workflow } from 'lucide-react'
import type { DealSource, DealStage } from '@/types'

export const DEAL_SOURCE = {
  telegram: { label: 'Telegram', icon: Send, color: '#0369a1', bg: '#e0f2fe' },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, color: '#15803d', bg: '#dcfce7' },
  instagram: { label: 'Instagram', icon: Camera, color: '#be185d', bg: '#fce7f3' },
  amocrm: { label: 'Импорт', icon: Workflow, color: '#0e7490', bg: '#cffafe' },
  site: { label: 'Сайт', icon: Workflow, color: '#075985', bg: '#e0f2fe' },
  manual: { label: 'Вручную', icon: PenLine, color: '#475569', bg: '#f1f5f9' },
} satisfies Record<DealSource, { label: string; icon: typeof Send; color: string; bg: string }>

export function formatStageAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ч`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days} дн` : `${Math.round(days / 30)} мес`
}

export function stageSoft(color: string, alpha = 0.15): string {
  const hex = color.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 'rgba(14, 116, 144, .12)'
  const [r, g, b] = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function stageGuidance(stage: string | Pick<DealStage, 'name' | 'guidance'>): string | null {
  const customGuidance = typeof stage === 'string' ? null : stage.guidance?.trim()
  if (customGuidance) return customGuidance
  const name = typeof stage === 'string' ? stage : stage.name
  const normalized = name.toLocaleLowerCase('ru')
  if (normalized.includes('первичн') || normalized.includes('контакт установлен')) {
    return 'Уточните запрос клиента и зафиксируйте следующий шаг.'
  }
  if (normalized.includes('консультация проведена')) {
    return 'Зафиксируйте результат консультации и поставьте следующую задачу.'
  }
  if (normalized.includes('думает')) {
    return 'Укажите дату решения клиента и запланируйте контакт на этот день.'
  }
  if (normalized.includes('предоплат') || normalized.includes('пердоплат') || normalized.includes('готов к покупке')) {
    return 'Поставьте задачу на проверку оплаты и подтвердите результат.'
  }
  return null
}
