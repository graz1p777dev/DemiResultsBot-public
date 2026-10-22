// Чистые правила классификации для управленческого P&L. Без 'use server' — сюда
// выносится всё, что не является Server Action (в 'use server'-модуле разрешены
// только async-экспорты).

import type { MarketingSpend } from '@/actions/finance-expenses'

// ─── Коды системных категорий расходов ────────────────────────────────────────
// Классификация P&L идёт ТОЛЬКО по этим кодам. Имя категории — свободный текст,
// владелец вправе переименовать «Маркетинг» в «Реклама и продвижение», и это не
// должно менять ни валовую прибыль, ни строку маркетинга в отчёте.
export const CATEGORY_CODE = {
  cogs: 'cogs',
  marketing: 'marketing',
  payroll: 'payroll',
} as const

export type CategoryLike = { code: string | null }

export const isCogs      = (c: CategoryLike): boolean => c.code === CATEGORY_CODE.cogs
export const isMarketing = (c: CategoryLike): boolean => c.code === CATEGORY_CODE.marketing

// ─── Маркетинг в P&L ──────────────────────────────────────────────────────────
// Единственная величина маркетингового РАСХОДА для P&L — фактический спенд рекламы.
// Пополнения рекламного счёта (topupsSom) — перемещение денег между своими счетами,
// а не трата: их включение задваивало расход (пополнил 100к + потратил 50к = 150к).
export const marketingPnlSpend = (m: MarketingSpend): number => m.targetBudgetSom
