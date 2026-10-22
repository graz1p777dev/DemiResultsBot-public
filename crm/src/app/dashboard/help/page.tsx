'use client'

import Image from 'next/image'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FlaskConical,
  HelpCircle,
  MessageCircle,
  Send,
  Settings2,
  Users,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { NAV_GROUPS } from '@/config/nav'
import { HELP_CONTENT } from '@/config/help-content'
import type { UserRole } from '@/types'

const navy = '#0c2136'
const steel = '#8a97a5'

export default function HelpPage() {
  const { user, visibleResources } = useAuth()
  const role = user?.role as UserRole | undefined

  // Показываем только то, что доступно этой роли — ровно как в боковом меню.
  // Саму «Помощь» из списка убираем, чтобы страница не ссылалась на себя.
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter(
      (item) => item.href !== '/dashboard/help' && role && item.roles.includes(role)
        && (role === 'owner' || !item.resource || visibleResources.includes(item.resource))
    ),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="p-4 md:p-8 flex flex-col gap-6 max-w-5xl">
      {/* Шапка */}
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-11 h-11 rounded-2xl shrink-0" style={{ backgroundColor: '#0c4d6c' }}>
          <HelpCircle size={22} color="#fff" />
        </div>
        <div>
          <h1 className="font-bold text-xl" style={{ color: navy }}>Помощь</h1>
          <p className="text-sm mt-0.5" style={{ color: steel }}>
            Что умеет каждый раздел и как туда перейти. Показаны только доступные вам разделы.
          </p>
        </div>
      </div>

      <section className="overflow-hidden rounded-2xl bg-white" style={{ border: '1px solid #d5e8f2' }}>
        <Image
          src="/images/crm-client-guide.svg"
          alt="Шпаргалка по карточкам клиентов, статусам и кнопкам CRM"
          width={1672}
          height={941}
          priority
          className="h-auto w-full"
        />
      </section>

      <section className="overflow-hidden rounded-2xl bg-[#0c2136] p-3 md:p-5">
        <div className="mb-3 px-1">
          <h2 className="text-lg font-bold text-white">Видеообучение по CRM</h2>
          <p className="mt-1 text-sm text-[#b8cad7]">Полный обзор основных разделов и ежедневной работы в системе.</p>
        </div>
        <video controls preload="metadata" className="aspect-video w-full rounded-xl bg-black" src="/help-training/crm-training.mov">
          Ваш браузер не поддерживает видео.
        </video>
      </section>

      <section className="rounded-2xl bg-white p-5 md:p-6" style={{ border: '1px solid #e2eaf0' }}>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: '#e7f2f7' }}>
            <Bot size={20} color="#0c4d6c" />
          </div>
          <div>
            <h2 className="font-bold text-lg" style={{ color: navy }}>Как работает AI-бот</h2>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: '#4b5563' }}>
              В ручном режиме бот не отправляет клиенту текст сам: AI-ответ появляется в «Согласованиях» и прямо внутри диалога.
              Клиент получит его только после подтверждения менеджером в CRM.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-5">
          {[
            { icon: MessageCircle, title: '1. Сообщение клиента', text: 'WhatsApp или Instagram передаёт сообщение боту.' },
            { icon: Bot, title: '2. Черновик AI', text: 'Бот учитывает историю диалога и готовит ответ.' },
            { icon: ClipboardCheck, title: '3. Согласование', text: 'Черновик появляется в CRM и отмечается как неподтверждённый.' },
            { icon: CheckCircle2, title: '4. Решение менеджера', text: 'Ответ можно принять, изменить, сохранить или отклонить.' },
            { icon: Send, title: '5. Отправка', text: 'После принятия сообщение уходит клиенту и появляется в диалоге.' },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl p-4" style={{ backgroundColor: '#f7fafc', border: '1px solid #e5edf2' }}>
              <Icon size={18} color="#0c4d6c" />
              <p className="mt-2 text-sm font-semibold" style={{ color: navy }}>{title}</p>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: steel }}>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 md:p-6" style={{ border: '1px solid #e2eaf0' }}>
        <h2 className="font-bold text-lg" style={{ color: navy }}>Как работать в едином Inbox</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed" style={{ color: '#4b5563' }}>
          <li>Используйте фильтры «Непрочитанные», «Мои» и канал, чтобы не потерять новое обращение.</li>
          <li>Нажмите «Взять», чтобы закрепить диалог за собой. Руководитель увидит имя ответственного.</li>
          <li>Значок булавки поднимает важный диалог наверх. Текст черновика сохраняется автоматически.</li>
          <li>Зелёные сообщения отправил менеджер, тёмно-синие — AI, белые — клиент. Неподтверждённый AI-ответ имеет отдельные кнопки подтверждения и отклонения.</li>
          <li>Кнопка изображения отправляет JPG, PNG или WEBP до 15 МБ. Кнопка микрофона начинает запись; квадрат останавливает её и отправляет файл `.opus`.</li>
          <li>Если клиент задублировался, откройте его карточку и используйте «Объединить дубль». Выбранная карточка останется основной.</li>
        </ol>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-5" style={{ border: '1px solid #e2eaf0' }}>
          <h2 className="font-bold" style={{ color: navy }}>Кнопки в карточке согласования</h2>
          <div className="mt-4 grid gap-3 text-sm">
            {[
              ['✅ Подтвердить', 'Отправляет текущий текст клиенту. Кнопка доступна в очереди и прямо внутри диалога.'],
              ['✏️ Редактировать / 💬 Ответить', 'Позволяют изменить ответ перед отправкой. Используйте, если хотите написать текст сами.'],
              ['❌ Отклонить', 'Не отправляет черновик клиенту.'],
              ['💾 Сохранить', 'Сохраняет ответ как пример для обучения, но не отправляет его.'],
              ['🌐 Перевести', 'Создаёт вариант ответа на нужном языке — перед отправкой его можно проверить.'],
              ['🔁 Повторить отправку', 'Появляется только при ошибке отправки. Повторяет именно этот ответ, а не создаёт новый черновик.'],
            ].map(([title, text]) => (
              <div key={title} className="flex gap-3">
                <span className="min-w-36 font-semibold" style={{ color: '#0c4d6c' }}>{title}</span>
                <p style={{ color: '#4b5563' }}>{text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5" style={{ border: '1px solid #e2eaf0' }}>
          <h2 className="font-bold" style={{ color: navy }}>Где смотреть работу бота в CRM</h2>
          <div className="mt-4 grid gap-4 text-sm">
            <div className="flex gap-3"><MessageCircle size={18} className="shrink-0" color="#0c4d6c" /><p style={{ color: '#4b5563' }}><b style={{ color: navy }}>Диалоги</b> — история переписки, сообщения клиента, AI-черновики и уже отправленные ответы.</p></div>
            <div className="flex gap-3"><ClipboardCheck size={18} className="shrink-0" color="#0c4d6c" /><p style={{ color: '#4b5563' }}><b style={{ color: navy }}>Аналитика и отчёты бота</b> — количество входящих сообщений, согласований, отправок, отклонений и ежедневная сводка.</p></div>
            <div className="flex gap-3"><Settings2 size={18} className="shrink-0" color="#0c4d6c" /><p style={{ color: '#4b5563' }}><b style={{ color: navy }}>Настройки бота</b> — промпт, модель, менеджеры, стоп-слова и чёрный список. Меняйте их только если понимаете эффект.</p></div>
            <div className="flex gap-3"><FlaskConical size={18} className="shrink-0" color="#0c4d6c" /><p style={{ color: '#4b5563' }}><b style={{ color: navy }}>Лаборатория</b> — безопасно проверяет ответы на тестовых клиентах. Тестовые сообщения не уходят настоящим людям и не меняют рабочие карточки.</p></div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl p-5" style={{ backgroundColor: '#fff8e8', border: '1px solid #f4dfad' }}>
        <div className="flex gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" color="#b7791f" />
          <div>
            <h2 className="font-bold" style={{ color: navy }}>Если ответ не ушёл клиенту</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed" style={{ color: '#4b5563' }}>
              <li>Смотрите текст на карточке: «Отправлено» означает, что канал связи подтвердил отправку.</li>
              <li>Если написано «Не отправлено», нажмите «Повторить отправку». Не создавайте второй ответ вручную, пока не проверите карточку.</li>
              <li>Если повтор не помог, откройте «Диалоги» и сообщите владельцу номер AI-ответа из карточки — он сможет увидеть техническую причину в статусе сервера.</li>
              <li>Если карточка вообще не появилась, проверьте, включён ли AI у лида, и нет ли сообщения в стоп-словах или чёрном списке.</li>
            </ol>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 md:p-6" style={{ border: '1px solid #e2eaf0' }}>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: '#eef4f8' }}>
            <BarChart3 size={20} color="#0c4d6c" />
          </div>
          <div>
            <h2 className="font-bold text-lg" style={{ color: navy }}>Как читать главный дашборд</h2>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: '#4b5563' }}>
              Главная страница — это не место для ввода данных, а короткая сводка. Она автоматически считает показатели из записей, продаж, финансов и расписания, доступных вашей роли.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl p-4" style={{ backgroundColor: '#f7fafc', border: '1px solid #e5edf2' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#8a97a5' }}>Слева · итоги месяца</p>
            <div className="mt-3 space-y-3 text-sm" style={{ color: '#4b5563' }}>
              <p><b style={{ color: navy }}>Первичные встречи (ФВ)</b> — сколько первых встреч проведено за текущий месяц и насколько выполнен план.</p>
              <p><b style={{ color: navy }}>Продажи</b> — количество закрытых продаж за месяц.</p>
              <p><b style={{ color: navy }}>Выручка</b> — сумма продаж, которые внесены в систему.</p>
              <p><b style={{ color: navy }}>KPI%</b> — общий процент выполнения плана. Цвет и процент помогают быстро увидеть отставание или выполнение.</p>
              <p><b style={{ color: navy }}>Выручка по неделям</b> — график темпа продаж внутри месяца; по нему видно, в какие недели был рост или спад.</p>
              <p><b style={{ color: navy }}>План vs факт</b> — у владельца и РОПа сравнение по команде, у сотрудника — только его личные цифры.</p>
            </div>
          </div>

          <div className="rounded-xl p-4" style={{ backgroundColor: '#f7fafc', border: '1px solid #e5edf2' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#8a97a5' }}>Справа · сегодня</p>
            <div className="mt-3 space-y-3 text-sm" style={{ color: '#4b5563' }}>
              <p><b style={{ color: navy }}>ФВ сегодня и продажи сегодня</b> — только события текущего дня, не итог месяца.</p>
              <p><b style={{ color: navy }}>Выручка сегодня</b> появляется, когда в сегодняшних продажах есть сумма.</p>
              <p><b style={{ color: navy }}>Записи · лента</b> обновляется автоматически при новой записи: показывает клиента, статус, менеджера, сумму и время.</p>
              <p><b style={{ color: navy }}>Команда сейчас</b> видна руководителю: кто работает и какие показатели у команды сегодня.</p>
              <p><b style={{ color: navy }}>Расписание дня</b> — ближайшие события дня по времени.</p>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Link href="/dashboard/consultations" className="rounded-xl p-4 transition-shadow hover:shadow-md" style={{ border: '1px solid #d9e8ee' }}>
            <CalendarDays size={18} color="#0c4d6c" />
            <p className="mt-2 text-sm font-semibold" style={{ color: navy }}>Нужно добавить или исправить запись?</p>
            <p className="mt-1 text-xs" style={{ color: steel }}>Откройте «Записи». Именно оттуда берутся ФВ, продажи и лента.</p>
          </Link>
          <Link href="/dashboard/finance" className="rounded-xl p-4 transition-shadow hover:shadow-md" style={{ border: '1px solid #d9e8ee' }}>
            <BarChart3 size={18} color="#0c4d6c" />
            <p className="mt-2 text-sm font-semibold" style={{ color: navy }}>Нужно понять деньги?</p>
            <p className="mt-1 text-xs" style={{ color: steel }}>Откройте «Финансы» для движения денег, счетов и детальных операций.</p>
          </Link>
          <Link href="/dashboard/employees" className="rounded-xl p-4 transition-shadow hover:shadow-md" style={{ border: '1px solid #d9e8ee' }}>
            <Users size={18} color="#0c4d6c" />
            <p className="mt-2 text-sm font-semibold" style={{ color: navy }}>Нужно увидеть команду?</p>
            <p className="mt-1 text-xs" style={{ color: steel }}>Откройте «Сотрудники» — там роли, данные и доступы пользователей.</p>
          </Link>
        </div>
      </section>

      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-3">
          <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#a2b4c0' }}>
            {group.label}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {group.items.map((item) => {
              const help = HELP_CONTENT[item.href]
              const Icon = item.icon
              const external = item.href.startsWith('/inventory')
              const cardInner = (
                <div className="flex items-start gap-3 rounded-2xl bg-white p-5 h-full transition-shadow hover:shadow-md">
                  <div className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0" style={{ backgroundColor: '#eef4f8' }}>
                    <Icon size={17} color="#0c4d6c" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-sm" style={{ color: navy }}>{item.label}</span>
                      {external ? (
                        <ExternalLink size={13} color={steel} />
                      ) : (
                        <ArrowRight size={13} color={steel} />
                      )}
                    </div>
                    <p className="mt-1 text-sm" style={{ color: '#4b5563' }}>
                      {help?.summary ?? 'Раздел системы.'}
                    </p>
                    {help?.details && (
                      <p className="mt-1.5 text-xs leading-relaxed" style={{ color: steel }}>
                        {help.details}
                      </p>
                    )}
                    {help?.steps && (
                      <div className="mt-3 rounded-xl bg-[#f7fafc] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#0c4d6c' }}>Как работать</p>
                        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed" style={{ color: '#4b5563' }}>
                          {help.steps.map(step => <li key={step}>{step}</li>)}
                        </ol>
                      </div>
                    )}
                    {help?.tips?.map(tip => (
                      <p key={tip} className="mt-2 text-xs leading-relaxed" style={{ color: '#15803d' }}>Совет: {tip}</p>
                    ))}
                    {help?.troubleshooting?.map(item => (
                      <p key={item} className="mt-2 text-xs leading-relaxed" style={{ color: '#b45309' }}>Если не работает: {item}</p>
                    ))}
                    <span className="mt-2 inline-block text-xs font-medium" style={{ color: '#0c4d6c' }}>
                      Открыть →
                    </span>
                  </div>
                </div>
              )
              // Товароучёт — отдельная зона Multi-Zones, нужен hard navigation.
              return external ? (
                <a key={item.href} href={item.href}>{cardInner}</a>
              ) : (
                <Link key={item.href} href={item.href}>{cardInner}</Link>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
