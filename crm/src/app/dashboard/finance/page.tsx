'use client'

// Раздел «Финансы» — один пункт меню, вкладки внутри (как отделы в декомпозиции).
// «Обзор» — существующий дашборд. Остальные вкладки (Расходы/Доходы/Зарплаты/Маркетинг/
// Долги/Инвесторы) — рабочие модули (шаги 1–4). Заглушек «Скоро» больше нет.

import { useState } from 'react'
import FinanceOverviewTab from '@/components/finance/FinanceOverviewTab'
import ExpensesTab from '@/components/finance/ExpensesTab'
import IncomeTab from '@/components/finance/IncomeTab'
import MarketingSpendTab from '@/components/finance/MarketingSpendTab'
import DebtsTab from '@/components/finance/DebtsTab'
import InvestorsTab from '@/components/finance/InvestorsTab'
import ProfitDistributionTab from '@/components/finance/ProfitDistributionTab'
import CashFlowTab from '@/components/finance/CashFlowTab'
import SalaryPage from '@/app/dashboard/salary/page'

const INK = '#0c2136', MUTE = '#6b7d8a', LINE = 'rgba(12,33,54,0.10)'

type TabKey = 'overview' | 'expenses' | 'income' | 'salary' | 'marketing' | 'debts' | 'investors' | 'distribution' | 'cashflow'
const TABS: { key: TabKey; label: string; soon?: boolean }[] = [
  { key: 'overview',     label: 'Обзор' },
  { key: 'expenses',     label: 'Расходы' },
  { key: 'income',       label: 'Доходы' },
  { key: 'salary',       label: 'Зарплаты' },
  { key: 'marketing',    label: 'Маркетинг' },
  { key: 'debts',        label: 'Долги' },
  { key: 'investors',    label: 'Инвесторы' },
  { key: 'distribution', label: 'Распределение' },
  { key: 'cashflow',     label: 'Движение денег' },
]

export default function FinancePage() {
  const [tab, setTab] = useState<TabKey>('overview')

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6f8' }}>
      {/* Вкладки */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '14px 20px 0', borderBottom: `1px solid ${LINE}`, background: '#eef1f4' }}>
        {TABS.map(t => {
          const on = t.key === tab
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                background: on ? '#f5f6f8' : 'transparent', border: `1px solid ${on ? LINE : 'transparent'}`,
                borderBottom: on ? '1px solid #f5f6f8' : '1px solid transparent',
                color: on ? INK : MUTE, borderRadius: '11px 11px 0 0', padding: '10px 18px',
                fontSize: '13.5px', fontWeight: on ? 700 : 600, cursor: 'pointer', fontFamily: "'Golos Text', system-ui, sans-serif",
                marginBottom: '-1px',
              }}>
              {t.label}{t.soon && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#a2b4c0' }}>скоро</span>}
            </button>
          )
        })}
      </div>

      {tab === 'overview' && <FinanceOverviewTab />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'income' && <IncomeTab />}
      {tab === 'salary' && <SalaryPage />}
      {tab === 'marketing' && <MarketingSpendTab />}
      {tab === 'debts' && <DebtsTab />}
      {tab === 'investors' && <InvestorsTab />}
      {tab === 'distribution' && <ProfitDistributionTab />}
      {tab === 'cashflow' && <CashFlowTab />}
    </div>
  )
}
