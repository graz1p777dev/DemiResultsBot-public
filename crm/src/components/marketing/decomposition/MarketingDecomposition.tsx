'use client'

// Контейнер декомпозиции отдела маркетинга. Открывается при выборе отдела
// «Маркетинг» в верхнем селекторе (уровень «Вся компания»). Навигация между
// четырьмя экранами — вкладками, единообразно с фирменным стилем проекта.
// КАРКАС: только структура; расчёты/данные/сохранение — следующая задача.

import { useState } from 'react'
import { Shell, MarketingHeader, Tabs, ContentWrap, type TabDef } from './skeleton-ui'
import MarketingOverviewScreen from './MarketingOverviewScreen'
import TargetScreen from './TargetScreen'
import ContentScreen from './ContentScreen'
import PartnersScreen from './PartnersScreen'
import BudgetPlanScreen from './BudgetPlanScreen'

const TABS: TabDef[] = [
  { key: 'overview', label: 'Общая' },
  { key: 'target',   label: 'Таргет' },
  { key: 'content',  label: 'Контент' },
  { key: 'partners', label: 'Партнёры' },
  { key: 'budget',   label: 'Планирование бюджета · скоро' },
]

const META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: 'Общая декомпозиция отдела маркетинга', subtitle: 'Сводка по каналам привлечения: Таргет · Органика · Партнёры' },
  target:   { title: 'Таргет — платный трафик',              subtitle: 'Ежедневные показатели рекламного кабинета и метрики эффективности' },
  content:  { title: 'Контент — органика',                   subtitle: 'Выпуск публикаций и их отдача' },
  partners: { title: 'Партнёры',                             subtitle: 'Партнёрские источники обращений и их выхлоп' },
  budget:   { title: 'Планирование бюджета маркетинга',      subtitle: 'План затрат на месяц по каналам — макет, логика появится позже' },
}

export default function MarketingDecomposition() {
  const [tab, setTab] = useState('overview')
  const meta = META[tab] ?? META.overview

  return (
    <Shell>
      <MarketingHeader title={meta.title} subtitle={meta.subtitle} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {/* Полоска-основание вкладок */}
      <div style={{ height: '1px', background: 'rgba(12,33,54,0.10)', margin: '-1px 40px 0' }} />
      <ContentWrap>
        {tab === 'overview' && <MarketingOverviewScreen />}
        {tab === 'target'   && <TargetScreen />}
        {tab === 'content'  && <ContentScreen />}
        {tab === 'partners' && <PartnersScreen />}
        {tab === 'budget'   && <BudgetPlanScreen />}
      </ContentWrap>
    </Shell>
  )
}
