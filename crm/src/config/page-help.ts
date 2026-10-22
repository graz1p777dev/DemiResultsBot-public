export type PageHelpItem = {
  number: number
  title: string
  text: string
  audio: string
  image?: string
}

const audio = (number: number, slug: string) => `/help-training/audio/${String(number).padStart(2, '0')}-${slug}.mp3`

export const PAGE_HELP_ITEMS: Record<number, PageHelpItem> = {
  1: { number: 1, title: 'Как читать карточку клиента', text: 'На карточке сразу видны канал клиента, телефон, ответственный сотрудник, последняя активность, задачи и готовность ответа ИИ.', audio: audio(1, 'client-cards'), image: '/images/crm-client-guide.svg' },
  2: { number: 2, title: 'Страница «Сделки»', text: 'Здесь собраны заявки клиентов, последние сообщения и этапы продаж. Колонки можно прокручивать по горизонтали.', audio: audio(2, 'deals-page') },
  3: { number: 3, title: 'Новые и повторные продажи', text: 'Переключатель помогает отдельно посмотреть первую покупку клиента и его повторные обращения.', audio: audio(3, 'new-repeat-sales') },
  4: { number: 4, title: 'Создание новой сделки', text: 'Укажите название, этап, сумму, клиента, ответственного и заметку, затем сохраните карточку.', audio: audio(4, 'create-deal') },
  5: { number: 5, title: 'Поиск клиента', text: 'Клиента можно найти по имени, телефону, Instagram, внутреннему ID CRM или ID-тегу.', audio: audio(5, 'client-search') },
  6: { number: 6, title: 'Фильтры в сделках', text: 'Отберите сделки по источнику, тегу, городу, периоду, этапу, задачам, сотруднику и важности.', audio: audio(6, 'deal-filters') },
  7: { number: 7, title: 'Из сделки в диалог', text: 'Откройте сделку и перейдите к переписке, чтобы сразу продолжить общение с клиентом.', audio: audio(7, 'deal-to-dialog') },
  8: { number: 8, title: 'Диалог с клиентом', text: 'В диалоге доступны сообщения, фотографии, голосовые, смена этапа, карточка клиента и действия менеджера.', audio: audio(8, 'client-dialog') },
  9: { number: 9, title: 'Страница «Задачи»', text: 'Канбан показывает работу по этапам. Здесь можно искать, создавать задачи, задавать приоритет, срок и ответственного.', audio: audio(9, 'tasks-page') },
  10: { number: 10, title: 'Перемещение задачи', text: 'Зажмите карточку мышью и перенесите её в нужную колонку. Подсветка показывает будущий этап.', audio: audio(10, 'task-kanban-move') },
  11: { number: 11, title: 'Дашборд CRM', text: 'Главная страница показывает итоги месяца и дня, план и факт, продажи, обращения, активные сделки, KPI и бонусы.', audio: audio(11, 'dashboard') },
  12: { number: 12, title: 'Консультации', text: 'Создавайте и находите консультации, назначайте дату и статус, следите за новыми записями.', audio: audio(12, 'consultations') },
  13: { number: 13, title: 'Мессенджер', text: 'Сотрудники общаются лично, в группах и каналах. Создать чат можно кнопкой «плюс» в левом верхнем углу.', audio: audio(13, 'messenger') },
  14: { number: 14, title: 'Календарь с аналитикой', text: 'Показывает показатели месяца и дня: выручку, продажи, встречи, рекламу, лиды, доходы и расходы.', audio: audio(14, 'calendar-analytics') },
  16: { number: 16, title: 'Уведомления', text: 'Здесь видны новые сообщения, сделки и важные события. Уведомления можно фильтровать и отмечать прочитанными.', audio: audio(16, 'notifications') },
  17: { number: 17, title: 'Страница «Помощь»', text: 'На этой странице собраны подробные инструкции, обучающее видео и способы устранения частых ошибок.', audio: audio(17, 'help-page') },
}

function routeNumbers(pathname: string): number[] {
  if (pathname === '/dashboard') return [11]
  if (pathname.startsWith('/dashboard/deals')) return [2, 3, 4, 5, 6, 7]
  if (pathname.startsWith('/dashboard/dialogs')) return [8]
  if (pathname.startsWith('/dashboard/tasks')) return [9, 10]
  if (pathname.startsWith('/dashboard/consultations')) return [12]
  if (pathname.startsWith('/dashboard/messenger')) return [13]
  if (pathname.startsWith('/dashboard/calendar')) return [14]
  if (pathname.startsWith('/dashboard/notifications')) return [16]
  if (pathname.startsWith('/dashboard/help')) return [1, 17]
  return []
}

export function getPageHelp(pathname: string): PageHelpItem[] {
  const numbers = routeNumbers(pathname)
  return numbers.map(number => PAGE_HELP_ITEMS[number])
}
