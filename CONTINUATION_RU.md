# Инструкция следующему разработчику / агенту

## Задача владельца

Сохранить интерфейс Самата и исправления безопасности. WhatsApp через Green API: входящие появляются в CRM, ответы реально доставляются; днём 10:00–21:00 Asia/Bishkek ответ согласует сотрудник через Telegram/CRM, сохраняются правки и автор. Ночью один шаблон «Магазин закрыт, ответим утром», без автономной AI-консультации; входящие не теряются. Подготовить автономного консультанта можно отдельно, не включая его всем клиентам.

Текущие подтверждённые результаты и backlog находятся в STATUS_RU.md. Результаты относятся к 22.10.2026, перед новым deployment состояние проверить заново.

## Первые действия на другом компьютере

1. Клонировать публичный репозиторий и запустить локальные тесты/демо по README. Весь внешний транспорт должен быть mocked.
2. Прочитать модели `backend/app/models/entities.py`, pipeline, `services/reply_hours.py`, `services/telegram.py`, `services/openai_service.py`, `services/outgoing.py`; CRM Green transport, webhook route, `crm-ingest.ts`, internal channel-send и `authz.ts`.
3. Не начинать с новой интеграции/переписывания. Первый незакрытый live-сценарий — настоящая Telegram-кнопка с одним тестовым диалогом. Добавить точные доказательства и регрессионный тест, если найдена ошибка.
4. Проверить полномочия на работу с production и получить приватные сведения ниже. Публичная ссылка не предоставляет SSH или право менять любой сервер.

## Что получить у владельца только приватно

- SSH hostname/IP, username и отдельный разрешённый ключ. Пароль/ключ нельзя коммитить даже в private history.
- Адреса frontend/backend, текущие source paths, compose/project name, unit name, канонические backup locations и текущие Git commits. Не полагаться на старые пути из другого компьютера.
- Конфигурацию существующего Green instance: API URL, instance ID, token, webhook token. **Не создавать второй instance, не logout/relogin, не переключать LID mode без отдельной причины.**
- Telegram token/webhook secret, разрешённые manager IDs и тестового сотрудника. Проверять настоящий actor, а не QA-подпись.
- Разрешённый тестовый WhatsApp номер и его актуальное согласие. В публичной версии все номера фиктивные; не отправлять на них. Владелец ранее исправлял номер — не копировать старый из истории.
- Отдельную локальную/стейджинговую PostgreSQL и Supabase схему/миграции, Redis, auth setup; production дамп с персональными данными сюда не добавлять.
- Действующие системные бизнес-инструкции/память, актуальные цены/условия/наличие и доступ к слотам. `demo/knowledge.json` — демонстрационный образец, не база правды. Raw production prompt исключён намеренно.
- AI ключи и состояние баланса. На последней проверке OpenAI balance exhausted, DeepSeek text fallback работал. Стоимости в коде — конфигурационные оценки, не подтверждённый текущий тариф.

Доступы передать через менеджер секретов/защищённый канал. Если их нет, продолжать локальные mock-тесты и точно описать, какой live-gate заблокирован; не придумывать успешный production запуск.

## Важные пары конфигурации

CRM `INTERNAL_NOTIFY_TOKEN` соответствует backend `CRM_NOTIFY_TOKEN`.
CRM `BOT_BACKEND_ADMIN_API_KEY` соответствует backend `ADMIN_API_KEY`.
CRM `BOT_BACKEND_API_URL` указывает на backend; backend `CRM_CHANNEL_SEND_URL` — на CRM `/api/internal/channel-send`.
CRM `NEXT_PUBLIC_SUPABASE_URL` должен включать правильный публичный Supabase prefix (в существующем production использовался `/supabase`). Service role key только server-side, никогда `NEXT_PUBLIC_*`.
Green webhook URL должен соответствовать route `/api/integrations/green-api/webhook/<token>` и текущему secret. Статусы требуют `outgoingAPIMessageWebhook=yes`. Сохранять остальные действующие настройки.

Пример в корне перечисляет часть переменных. Полные имена backend см. `backend/app/core/config.py`; CRM ищет `process.env`. Env хранить отдельно для каждого компонента, не рассчитывать, что root `.env.example` автоматически загрузится в оба приложения.

## Проверка Green и доставок

- Авторизация instance и online; настройки webhook сверять без вывода token в логи (он входит в Green request URL).
- Согласованный тестер пишет уникальную фразу. Проверить один исходный provider ID → одно сообщение в CRM → тот же текст/вложение в backend. Отдельно отметить автоматический приём или manual replay.
- Дневной ответ: одна карточка, реальная Telegram правка, approve от разрешённого сотрудника, audit actor. Повтор callback не отправляет повторно, чужой actor/неверный secret отклоняется.
- `queued`/API 200 — не доставка. Ждать автоматические `sent/delivered/read`, сверить CRM/backend и provider ID. Учитывать canonical c.us/LID mapping; не менять клиентскую phone identity на LID.
- `getWebhooksCount` вызывать редко: 429 на этот read-запрос не доказывает ошибку отправки. Не запускать polling storm.
- При неоднозначном timeout или multipart partial сначала reconciliation, не resend. Никогда не вычищать очередь для ускорения теста.
- Фото: только HTTPS и узкий allowlist. Не разрешать произвольные storage domains ради обхода 400.

## Production deployment — только узкий

Сначала read-only inventory: текущие commits, diff/untracked, service/container mappings, health, свободное место, hashes изменяемых файлов. Frontend история расходилась с remote, backend был dirty до нашей работы: `git pull/reset` и замена всего checkout недопустимы.

Создать owner-only backup выбранных файлов/env и source recovery; проверить его читаемость. Stage build из **текущего production**, наложить только проверенный patch, прогнать regression и сравнить ожидаемые hashes до записи. Рестартовать только нужные CRM/backend/worker/beat, не соседние inventory/shop/Supabase. Контейнерный runtime может отличаться от host source: проверить все три процесса; host copy сама по себе не deployment. Сохранить rollback images/build, проверить health и реальные потоки после рестарта.

Не забирать в публичный git backups/env/live receipts. Не запускать broad docker prune или удаление старых чужих каталогов. Сервер почти заполнен; rollback-артефакты уже сжаты, дальнейшую ёмкость решать отдельно.

## Что считать завершением

Закрывать пункты STATUS_RU.md только по воспроизводимому результату. Для каждого: commit, окружение, команда/шаги, наблюдение, ограничения. Live IDs и номера хранить приватно, в public report только обезличенный результат. Нельзя писать «всё работает», если закрыты только unit/build и несколько ручных отправок.
