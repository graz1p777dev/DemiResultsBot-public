# DemiResults: актуальная передача другому Codex

Последнее дополнение: [проверка редактирования и очистка промпта](VERIFICATION_20261024.md). Отсрочка тестов отменена; актуальные результаты и ещё открытые live-gates перечислены там.

Срез на **24 октября 2026, Asia/Bishkek**. Этот файл — актуальная стартовая инструкция. Старые отчёты читать с учётом последующих исправлений, не выдавать исторические результаты за сегодняшнюю проверку.

**Обновление 24.10:** [VOICE_APPROVALS_20261024.md](VOICE_APPROVALS_20261024.md). Новый ключ проверен и подключён отдельно для ASR; исходная запись распознана через `gpt-transcribe`. Telegram упрощён, добавлены reply-bound text/voice previews и подтверждение; CRM переведена на non-mutating preview/accept/discard. Production обновлён. Полные тесты владелец отложил; ниже сведения от 23.10 про непроверенный ключ/блокировку ASR — исторические, не актуальный статус.

## Цель владельца

CRM магазина DemiResults с интерфейсом Самата и ботом-консультантом. WhatsApp — **Green API**, не Meta WhatsApp. Входящие и вложения сохраняются в CRM/backend. Днём 10:00–21:00 Asia/Bishkek AI готовит черновик; сотрудник подтверждает/редактирует/отклоняет через Telegram или CRM, с аудитом автора. Ночью — один шаблон о закрытом магазине, без автономной консультации; входящие сохраняются до утра. Голосовые должны распознаваться на русском и кыргызском. Общий автономный AI не включать.

## Репозитории и границы snapshot

- Публичная кодовая база: https://github.com/graz1p777dev/DemiResultsBot-public
- Исходный приватный snapshot: https://github.com/graz1p777dev/DemiResultsBot
- Production CRM source: https://github.com/graz1p777dev/DemiResultsCRM
- Production backend source: https://github.com/graz1p777dev/Demireusltsn8nbotcopy

Публичная версия объединяет continuation-код outbox/recovery и последние исправления голосовых. Это не побайтовый экспорт production: в публичном API есть recovery diagnostics; его наличие на сервере отдельно перепроверить. Не заменять рабочее приложение целиком этим каталогом. Production Git-истории расходятся с remote, backend содержит изменения, которые нельзя затереть.

Нет production env, полной инфраструктуры/Supabase схемы и миграций, inventory-сервиса, всех обучающих assets и более нового production copilot UI. `qa/compose.yaml` — одноразовый синтетический стенд, не production deployment.

## Топология без публикации доступов

| Компонент | Устройство |
|---|---|
| CRM | Next.js/React/TypeScript, Supabase, systemd `demiresults-crm.service`, loopback 3000 |
| Backend | Python/FastAPI/SQLAlchemy/PostgreSQL, loopback 8001 |
| Фон | Celery worker и beat, Redis |
| Контейнеры | `demi-bot-backend-1`, `demi-bot-worker-1`, `demi-bot-beat-1`, `demi-bot-postgres-1`, `demi-bot-redis-1`, `demi-bot-backup-1` |
| Каналы | Green API, Telegram approvals; legacy Meta/Instagram/Wazzup сохранены |
| AI | OpenAI; существующий DeepSeek fallback только для текста, не аудио/vision |

CRM Supabase и PostgreSQL бота — разные базы. Владелец отдельно передаёт SSH hostname/user/key, URL приложений, абсолютные source/compose paths, rollback locations и разрешённый тестовый контакт. Не добавлять их вместе с env или клиентскими данными в публичный git. На другом компьютере SSH-доступ исходного Mac автоматически не появляется.

Пары конфигурации:

```text
CRM INTERNAL_NOTIFY_TOKEN ↔ backend CRM_NOTIFY_TOKEN
CRM BOT_BACKEND_ADMIN_API_KEY ↔ backend ADMIN_API_KEY
CRM BOT_BACKEND_API_URL → backend
backend CRM_CHANNEL_SEND_URL → CRM /api/internal/channel-send
```

`NEXT_PUBLIC_SUPABASE_URL` должен иметь правильный prefix; в существующем развёртывании использовался `/supabase`. Service role key только server-side. Полные имена backend settings — `backend/app/core/config.py`, CRM — `process.env` в source. Root `.env.example` не является готовой общей конфигурацией двух приложений.

## Подтверждённое состояние

Следующий точечный выпуск: [повторное использование AI-соединений](OPTIMIZATION_20261023.md) установлено на production; 209 backend tests + 16 subtests. [Схема работы бота и backend](SYSTEM_OVERVIEW_RU.md) описывает компоненты, согласование, ночной режим и ограничения.

Последнее точечное изменение: [ускорение Telegram при исчерпанной квоте](TELEGRAM_LATENCY_20261023.md). На production установлен обход лишних quota retries; буфер 30 с. Синтетический AI-замер ускорился с 20.182 до 8.082 с; полный свежий клиентский цикл после установки пока не измерен. Не переотправлять старые сообщения ради проверки.

При последней live-проверке backend healthy, worker/beat запущены, backend `/health` → `{"status":"ok"}`, CRM login → HTTP 200. Production CRM HEAD — `eb79010`.

Ранее живыми проверками подтверждены: входящее WhatsApp без дубля, автоматический приём фото с вложением, обработка очереди Green до нуля без ClearQueue/DeleteNotification, несколько согласованных текстовых ответов со статусом `read`, автоматическое обновление статусов в CRM/backend, доставка Telegram-карточек и approve/edit через CRM API. Это не доказательство всех CRM-сценариев или настоящих Telegram-кликов.

Outbox/reservation, recovery, Telegram update dedup/TTL и fencing реализованы в continuation-коде, см. [RELIABILITY_RU.md](RELIABILITY_RU.md). Синтетические PostgreSQL/Redis/Celery проверки не заменяют живую доставку. Неоднозначные отправки и старые send_failed нельзя повторять вслепую.

Часть реальных browser-сценариев на отдельной QA-базе описана в [BROWSER_QA_RU.md](BROWSER_QA_RU.md): auth владельца/сотрудника, lifecycle сотрудника, consultation CRUD, часть финансового CRUD и отказ по правам. Полная матрица ролей/финансов/HR/мобильных сценариев не закрыта.

## История голосовых на 23.10 — актуальное обновление выше

Исправлено на production 23.10.2026:

1. Убран amoCRM Authorization при загрузке Green media: раньше HTTP 400, без него исходное audio/ogg доступно с HTTP 200.
2. Исправлена очистка `[voice] URL` в summary, extraction, translation и других основных AI serializers, до обрезания текста. Поддержаны префиксы истории, несколько маркеров и multiline transcript.
3. Нераспознанное голосовое в текущей серии пользовательских сообщений блокирует генерацию клиентского ответа и идёт в существующий manual-approval path. Typed greeting в том же буфере не должен скрыть failed voice.
4. Аудио сохраняется, ошибка отражается в raw metadata; в логах только тип исключения. Сообщённая владельцем pending-карточка безопасно переведена в ручное прослушивание, Telegram обновлён, WhatsApp отправок не добавлено.

**Автоматическое распознавание пока не восстановлено.** Установленный на сервере ключ реально вернул `HTTP 429 / credit_balance_exhausted` на transcription-запрос. Это не утверждение об общем балансе аккаунта владельца.

Владелец после этого сообщил, что OpenAI оплачен, и передал новый ключ. **Новый ключ ещё не проверен, не установлен и не включён в этот репозиторий.** Получить его приватно; значение из чата не копировать в docs, fixtures, команды с видимым argv или Git. Предыдущая рекомендация в старом continuation-отчёте «не выполнять новых OpenAI вызовов» относилась к прошлому этапу; затем владелец явно запросил проверку нового ключа и распознавания. Публикация этого snapshot сама по себе не выполняла новых API-вызовов.

Локальные Whisper/Vosk модели проверялись изолированно, но кыргызский текст был недостаточно достоверным. Они не установлены как production fallback, сомнительная расшифровка не записана в CRM. Временные downloads этих проб удалены, а не оставлены на почти полном диске.

### Следующие действия

1. Приватно сравнить новый ключ с активным. Проверить его отдельным transcription-запросом, а не только `/models`; выводить лишь безопасные статус/код ошибки, не ключ/URL/тело запроса.
2. Использовать исходное проблемное голосовое, которое владелец разрешил проверить. Внутренние identifiers и media URL получить из защищённого контекста/у владельца; не публиковать.
3. Сверить актуальную официальную документацию [file transcription](https://developers.openai.com/api/docs/guides/speech-to-text) и доступность модели в аккаунте. На дату проверки документация рекомендует `gpt-transcribe`, JSON и ожидаемые языки через `languages`. Поддержку русского/кыргызского и качество подтвердить реально; не считать название модели доказательством.
4. Если оплаченный ключ и подходящая модель работают, менять сервис только из-за старого ключа не требуется. Если нет — подключить иной согласованный ASR с подтверждённой поддержкой обоих языков, после проверки на записи. Нельзя подменять речь «исправленным» текстовым LLM домыслом.
5. Проверить цепочку: audio → transcript → правильный AI context → draft → отдельное согласование. Клиенту не отправлять тестовый ответ, существующие manager edit/approval не затирать.
6. При успешном восстановлении сохранить исходное вложение и авторство/audit. Перед регенерацией старой карточки проверить её актуальный status и новые сообщения клиента.

## Проверенные версии и локальные тесты

При последней сверке production source/runtime:

```text
0b3011138033ce1184e0707d19b33de313bf07c4863acb9b1a839c7d4f297829  services/openai_service.py
63ec4ec8981dceff17b4345d892f5bf80115f50f36be2c4d25e2446b4ebb1711  tasks/pipeline.py
```

Исходная приватная snapshot-копия: 179 backend tests + 16 subtests. Текущая continuation-копия после quota и connection reuse fix: 209 passed + 16 subtests. Провайдеры mocked; успешный voice live-gate этим не подтверждён. Команды и переносимый offline PG/Redis/Celery QA — в README.md, TESTING_RU.md и qa/README.md. Не загружать production env в pytest/build/QA-браузер.

Основные файлы: `backend/app/api/admin.py`, `backend/app/services/openai_service.py`, `backend/app/tasks/pipeline.py`, `backend/app/services/telegram.py`, `backend/app/services/reply_hours.py`, `crm/src/lib/green-whatsapp.ts`, `crm/src/lib/crm-ingest.ts`.

## Ограничения работы

- Начинать с inventory, Git status/diff и hashes; сохранять чужие изменения. Не выполнять destructive reset, слепой pull/force-push или замену production всем snapshot.
- Перед изменением production — scoped backup, staging, regression, rollback, health и реальный проверяемый smoke. Менять только нужные сервисы, не соседние inventory/shop/Supabase.
- Не ослаблять auth/RLS ради теста. Не очищать Green queue, не переключать WhatsApp на Meta, не включать общий autopilot.
- Живые отправки — только конкретному согласившемуся тестировщику; старый тестовый номер не переиспользовать без актуального подтверждения.
- Диск: при последней проверке около 2 ГБ свободно из 48 ГБ, 96% занято. Не загружать большие модели и не запускать broad Docker prune. План ёмкости — CAPACITY_RU.md.
- Остались реальные Telegram-клики, наблюдаемая ночная смена, Instagram send/receive, voice/vision/media и полная CRM/roles/HR/finance матрица. Сверять статус с последующими отчётами, не закрывать по mock/build.
- В итоговом отчёте отдельно писать: изменено, выполненные live/mock проверки, ограничения и следующий шаг. Не обещать «всё работает» без соответствующего результата.
