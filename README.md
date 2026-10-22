# DemiResults — передача разработки

Публичный очищенный снимок backend бота, CRM с интерфейсом Самата и локального демо. Состояние передачи: **22 октября 2026**. Это не полная инфраструктурная копия production.

Начните с [статуса и незавершённой работы](STATUS_RU.md), затем прочитайте [инструкции следующему агенту](CONTINUATION_RU.md) и [AGENTS.md](AGENTS.md).

## Быстрый запуск демонстрации

```sh
git clone https://github.com/graz1p777dev/DemiResultsBot-public.git
cd DemiResultsBot-public
python3 demo/server.py --port 8765
```

Откройте http://127.0.0.1:8765/ . Это loopback-only демо по правилам, без LLM, внешних отправок и постоянной БД. Днём демонстрируется согласование ответа; ночью — один фиксированный шаблон. Демо не означает, что production подключён на этом компьютере.

## Проверки на другом компьютере

Нужны Python 3.12+, `uv`, Node.js 22 и npm:

```sh
uv venv --python 3.12 .venv
uv pip sync --python .venv/bin/python backend/requirements-local.lock
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q
python3 -m unittest discover -s demo -p test_demo.py -v
cd crm
npm ci
npm run check:fast
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9/supabase NEXT_PUBLIC_SUPABASE_ANON_KEY=local-placeholder npm run build -- --webpack
```

Backend tests блокируют немокированную внешнюю сеть. Не подставляйте production env для локальных тестов. Тесты с PostgreSQL имеют отдельные ограничения: [TESTING_RU.md](TESTING_RU.md).

`backend/` — FastAPI/Celery, согласования, расписание, AI и отправки через CRM. `crm/` — Next.js, авторизация, Green webhook/transport, бизнес-интерфейс. `demo/` — независимая демонстрация. `.env.example` — только имена параметров, не готовая конфигурация.

Основной WhatsApp transport — **Green API**, не Meta WhatsApp. Legacy Meta/Instagram и Wazzup сохранены, не считайте их проверенными. Днём 10:00–21:00 Asia/Bishkek требуется согласование сотрудника; ночью разрешён только шаблон закрытого магазина. Автономный AI-консультант не включён.

## Что намеренно не опубликовано

Старая приватная Git-история, секреты, env, SSH-доступ, номера реальных людей, provider receipts, базы/переписки, выгрузка действующего системного prompt, персональная иллюстрация CRM и старые внутренние отчёты. Иллюстрация заменена нейтральной схемой, тестовые номера синтетические, адреса production заменены `example.invalid`. Исходный приватный репозиторий сохранён отдельно.

Нет production Supabase схемы/миграций, Docker deployment-конфигурации, inventory-сервиса, записей `public/help-training` и более нового production copilot UI. Для настоящего запуска CRM владелец должен отдельно предоставить инфраструктуру и доступы. **Не заменять production этим каталогом целиком.**

Публикация не предоставляет новую открытую лицензию: отдельная LICENSE здесь не добавлена.
