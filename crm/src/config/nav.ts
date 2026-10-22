import type { LucideIcon } from 'lucide-react'
import type { UserRole } from '@/types'
import { FinanceNavIcon } from '@/components/finance/FinanceDesignerIcons'
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  BarChart3,
  Megaphone,
  Calendar,
  CalendarCheck,
  Clock,
  Bell,
  FileText,
  Settings,
  MessageSquare,
  SlidersHorizontal,
  Boxes,
  FlaskConical,
  Server,
  HelpCircle,
  KanbanSquare,
  MessageCircle,
  Handshake,
  Wallet,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: UserRole[]
  exact?: boolean
  resource?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export function isNavItemVisible(
  item: NavItem,
  role: UserRole | undefined,
  visibleResources?: string[],
): boolean {
  if (!role || !item.roles.includes(role)) return false
  if (role === 'owner' || !item.resource || visibleResources === undefined) return true
  return visibleResources.includes(item.resource)
}

export function navItemsForRole(role: UserRole | undefined): (NavItem & { group: string })[] {
  return (isNavItemVisible(WORKSPACE_NAV_ITEM, role) ? [{ ...WORKSPACE_NAV_ITEM, group: '' }] : []).concat(NAV_GROUPS.flatMap(group =>
    group.items
      .filter(item => isNavItemVisible(item, role))
      .map(item => ({ ...item, group: group.label })),
  ))
}

const INVENTORY_URL = '/inventory'
const ALL_STAFF: UserRole[] = ['owner', 'rop', 'mp', 'lmai', 'accountant', 'targetolog']
const SALES_AND_MARKETING: UserRole[] = ['owner', 'rop', 'mp', 'lmai', 'targetolog']

export const WORKSPACE_NAV_ITEM: NavItem = {
  href: '/dashboard', label: 'Рабочий стол', icon: LayoutDashboard, roles: ALL_STAFF, exact: true,
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Продажи',
    items: [
      { href: '/dashboard/deals', label: 'Новые продажи', icon: KanbanSquare, roles: ['owner', 'rop', 'mp', 'lmai'], exact: true, resource: 'deals' },
      { href: '/dashboard/deals/repeat', label: 'Повторные продажи', icon: KanbanSquare, roles: ['owner', 'rop', 'mp', 'lmai'], resource: 'deals' },
      { href: '/dashboard/dialogs', label: 'Диалоги', icon: MessageSquare, roles: SALES_AND_MARKETING, resource: 'inbox' },
      { href: '/dashboard/consultations', label: 'Консультации', icon: CalendarDays, roles: SALES_AND_MARKETING },
      { href: '/dashboard/tasks/kanban', label: 'Задачи', icon: KanbanSquare, roles: ALL_STAFF },
    ],
  },
  {
    label: 'Аналитика',
    items: [
      { href: '/dashboard/analytics', label: 'Вся аналитика', icon: BarChart3, roles: ['owner', 'rop'], resource: 'bot_analytics' },
      { href: '/dashboard/decomposition', label: 'Декомпозиция', icon: BarChart3, roles: SALES_AND_MARKETING },
      { href: '/dashboard/finance', label: 'Финансы', icon: FinanceNavIcon, roles: ['owner', 'accountant'] },
      { href: '/dashboard/salary', label: 'Моя зарплата', icon: Wallet, roles: ['rop', 'mp', 'lmai', 'targetolog'] },
      { href: '/dashboard/marketing', label: 'Маркетинг', icon: Megaphone, roles: ['owner', 'rop', 'targetolog'] },
      { href: '/dashboard/my-time', label: 'Моё время', icon: Clock, roles: ['rop', 'mp', 'lmai', 'targetolog'] },
      { href: '/dashboard/attendance', label: 'Посещаемость', icon: CalendarCheck, roles: ['owner', 'rop', 'accountant'] },
    ],
  },
  {
    label: 'Команда',
    items: [
      { href: '/dashboard/messenger', label: 'Мессенджер', icon: MessageCircle, roles: ALL_STAFF, resource: 'messenger' },
      { href: '/dashboard/employees', label: 'Сотрудники', icon: Users, roles: ['owner', 'rop'] },
      { href: '/dashboard/calendar', label: 'Календарь', icon: Calendar, roles: SALES_AND_MARKETING },
      { href: '/dashboard/notifications', label: 'Уведомления', icon: Bell, roles: ALL_STAFF },
      { href: '/dashboard/documents', label: 'Документы', icon: FileText, roles: ['owner', 'accountant', 'rop'] },
    ],
  },
  {
    label: 'Бизнес',
    items: [
      { href: INVENTORY_URL, label: 'Товароучёт', icon: Boxes, roles: ['owner'], resource: 'inventory' },
      { href: '/dashboard/partners', label: 'Партнёры', icon: Handshake, roles: ['owner', 'rop'], resource: 'partners' },
    ],
  },
  {
    label: 'Система',
    items: [
      { href: '/dashboard/bot-settings', label: 'Настройки бота', icon: SlidersHorizontal, roles: ['owner'], resource: 'bot_settings' },
      { href: '/dashboard/laboratory', label: 'Лаборатория', icon: FlaskConical, roles: ['owner'], resource: 'laboratory' },
      { href: '/dashboard/server-status', label: 'Сервер', icon: Server, roles: ['owner'], resource: 'server_status' },
      { href: '/dashboard/settings', label: 'Настройки', icon: Settings, roles: ['owner'] },
      { href: '/dashboard/help', label: 'Помощь', icon: HelpCircle, roles: ALL_STAFF, resource: 'help' },
    ],
  },
]
