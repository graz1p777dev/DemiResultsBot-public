// Ярлыки для финансовых справочников. Обычный модуль (НЕ 'use server') — сюда вынесены
// не-функциональные экспорты, которые нельзя держать в server-actions файлах:
// файл с 'use server' может экспортировать только async-функции (иначе загрузчик
// экшенов страницы падает: «A "use server" file can only export async functions»).
// Импортируется и из клиентских компонентов, и из server-экшенов.

import type { ChannelKey } from '@/actions/finance-income'
import type { DebtType } from '@/actions/finance-debts'
import type { PayoutType, RatePeriod } from '@/actions/finance-investors'
import type { CashCategory, AccountType } from '@/actions/finance-cashflow'

export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  target: 'Таргет', organic: 'Органика', partner: 'Партнёры', referral: 'Сарафан', other: 'Прочее',
}

export const DEBT_TYPE_LABEL: Record<DebtType, string> = {
  supplier: 'Поставщику (товар в долг)', business: 'Долг бизнеса',
}

export const PAYOUT_TYPE_LABEL: Record<PayoutType, string> = {
  profit_share: 'Доля прибыли', interest: 'Проценты', principal_return: 'Возврат тела', other: 'Прочее',
}

export const RATE_PERIOD_LABEL: Record<RatePeriod, string> = {
  monthly: 'в месяц', annual: 'в год', term: 'за срок',
}

// Ярлыки движения денег (шаг 7).
export const CASH_CATEGORY_LABEL: Record<CashCategory, string> = {
  revenue: 'Выручка', expense: 'Расход', salary: 'Зарплата', debt_repayment: 'Погашение долга',
  investor_payout: 'Выплата инвестору', transfer: 'Перевод', other: 'Прочее',
}
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Наличные', bank: 'Банк', other: 'Прочее',
}

// Ярлыки статей распределения прибыли (шаг 6). Для custom-статей берётся name из БД.
export const BUCKET_LABEL: Record<string, string> = {
  investors: 'Инвесторам', debt_repayment: 'Погашение долгов', reinvest: 'Реинвестиции', owner: 'Владельцу',
}

// Какие поля-условия показывать в форме для системных типов сделок (по имени из справочника).
// Для пользовательских типов (нет в карте) — показываем все три поля.
export const DEAL_FIELDS_BY_NAME: Record<string, { profit: boolean; fixed: boolean; royalty: boolean }> = {
  'Доля от чистой прибыли': { profit: true, fixed: false, royalty: false },
  'Фиксированный %':        { profit: false, fixed: true, royalty: false },
  'Роялти (% от выручки)':  { profit: false, fixed: false, royalty: true },
  'Смешанный':              { profit: true, fixed: true, royalty: true },
}
