# Тесты и ограничения воспроизведения

Основные команды — в README.md. Backend fixture блокирует внешние HTTP-запросы, использует отдельную временную SQLite БД. CRM tests используют mocks; это не полная production Vitest suite. Не подмешивать настоящие env.

`scripts/test_pg_release.py` — шесть concurrency/recovery тестов на настоящем PostgreSQL. Он очищает окружение, меняет cwd, принимает только Unix socket `/var/run/postgresql` и БД `green_release_qa`, требует отсутствие таблиц `public`, затем создаёт схему через SQLAlchemy metadata. Это **не тест применения production migrations**. AI, Telegram и отправки mocked.

Запускать только в новой одноразовой QA-среде с PostgreSQL 16, backend dependencies из lock-файла, без production mounts/env и без внешней сети. В контейнере с доступным локальным PG Unix socket и исходниками:

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin python /workspace/scripts/test_pg_release.py
```

Перед запуском отдельно создать пустую БД с фиксированным именем для локального пользователя postgres. На macOS обычная локальная установка может иметь другой socket/auth — не перенаправлять тест на существующую базу ради удобства. Готовая portable Docker инфраструктура пока отсутствует: это известный пункт backlog. Не выполнять create_all на CRM/Supabase production.

Исторически на изолированной PG 16.14 прошли: конкурирующая генерация с промежуточными commit, конкурирующий approve, независимые leads, release lock на exception, ночь через полночь до утра, recovery после translate failure. Это не нагрузочный тест двух настоящих Celery workers с живым Redis.

Live сценарии из STATUS_RU.md запускать отдельно, только по разрешению владельца и на согласованном тестовом контакте. Скрипт прежней живой отправки с реальным номером в публичный экспорт не включён.
