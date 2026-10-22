// Акцентная тема — общий источник правды для сервера (layout.tsx) и клиента
// (панель в Настройках). Хранится в обычной (не httpOnly) cookie на устройстве —
// это чисто визуальная настройка, не связана с аккаунтом пользователя.

export const ACCENT_COOKIE_NAME = 'accent'
export const DEFAULT_ACCENT = 'blue'

export const ACCENT_PRESETS = [
  { id: 'blue', label: 'Синий (классический)', from: '#0c4d6c', to: '#14708f' },
  { id: 'violet', label: 'Фиолетовый', from: '#7c3aed', to: '#9333ea' },
  { id: 'emerald', label: 'Изумрудный', from: '#059669', to: '#10b981' },
  { id: 'rose', label: 'Розовый', from: '#e11d48', to: '#ec4899' },
  { id: 'amber', label: 'Янтарный', from: '#d97706', to: '#f59e0b' },
] as const

export type AccentId = (typeof ACCENT_PRESETS)[number]['id']

const ACCENT_IDS = new Set<string>(ACCENT_PRESETS.map(p => p.id))

export function isAccentId(value: string | undefined): value is AccentId {
  return !!value && ACCENT_IDS.has(value)
}
