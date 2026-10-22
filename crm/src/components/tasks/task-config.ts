import type { LucideIcon } from 'lucide-react'
import { Circle, Timer, Eye, CheckCircle2, Globe, Building2, Lock } from 'lucide-react'
import type { TaskStatus, TaskPriority, TaskVisibility } from '@/types'

// ─── Колонки канбана (фиксированные этапы) ───────────────────────────────────

export interface TaskColumn {
  key: TaskStatus
  label: string
  icon: LucideIcon
  accent: string // цвет заголовка/полоски колонки
  soft: string   // мягкая заливка бейджа-счётчика
}

export const TASK_COLUMNS: TaskColumn[] = [
  { key: 'todo',        label: 'К выполнению', icon: Circle,       accent: '#64748b', soft: 'rgba(100,116,139,0.14)' },
  { key: 'in_progress', label: 'В работе',     icon: Timer,        accent: '#2563eb', soft: 'rgba(37,99,235,0.14)'   },
  { key: 'review',      label: 'На проверке',  icon: Eye,          accent: '#d97706', soft: 'rgba(217,119,6,0.14)'   },
  { key: 'done',        label: 'Готово',       icon: CheckCircle2, accent: '#16a34a', soft: 'rgba(22,163,74,0.14)'   },
]

export const TASK_STATUS_LABEL: Record<TaskStatus, string> =
  Object.fromEntries(TASK_COLUMNS.map((c) => [c.key, c.label])) as Record<TaskStatus, string>

// ─── Приоритеты ──────────────────────────────────────────────────────────────

export const TASK_PRIORITY: Record<
  TaskPriority,
  { label: string; color: string; bg: string }
> = {
  low:    { label: 'Низкий',  color: '#64748b', bg: '#f1f5f9' },
  medium: { label: 'Средний', color: '#0c4d6c', bg: '#dbeafe' },
  high:   { label: 'Высокий', color: '#d97706', bg: '#fef3c7' },
  urgent: { label: 'Срочный', color: '#dc2626', bg: '#fee2e2' },
}

export const TASK_PRIORITY_ORDER: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

// ─── Видимость ───────────────────────────────────────────────────────────────

export const TASK_VISIBILITY: Record<
  TaskVisibility,
  { label: string; icon: LucideIcon; hint: string }
> = {
  all:        { label: 'Все сотрудники', icon: Globe,      hint: 'Задачу видят все' },
  department: { label: 'Только отдел',   icon: Building2,   hint: 'Видят сотрудники отдела' },
  private:    { label: 'Личная',         icon: Lock,        hint: 'Видят автор, исполнитель и участники' },
}

export const TASK_VISIBILITY_ORDER: TaskVisibility[] = ['all', 'department', 'private']
