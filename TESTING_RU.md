# Тесты и ограничения воспроизведения

Последний прогон 24.10: **299 backend tests + 23 subtests, 38 CRM tests**, TypeScript; отдельно живые и браузерные проверки — [VERIFICATION_20261024.md](VERIFICATION_20261024.md). Числа ниже относятся к историческим этапам.

Основные команды — в README.md. Backend fixtures блокируют внешние HTTP-запросы
и используют временную SQLite БД. Не загружайте production env в локальные тесты,
Next build или браузерную QA-копию.

## Изолированные PostgreSQL, Redis и Celery

Готовый одноразовый стенд: [qa/README.md](qa/README.md).

```sh
docker compose -f qa/compose.yaml build
docker compose -f qa/compose.yaml up --abort-on-container-exit --exit-code-from tests
docker compose -f qa/compose.yaml down --volumes
```

Последнюю команду выполнить и после ошибки. Она удаляет ресурсы только этого
QA-проекта. Не добавляйте production mounts, env, Docker socket или внешнюю сеть.
Runtime services используют `network_mode: none` и собственные Unix sockets.

`scripts/test_pg_release.py` содержит 12 проверок реального PostgreSQL: CAS,
конкуренция, advisory lock, fencing, ночь/полночь/утро, outbox recovery и training
finalization. Нужны пустая БД `green_release_qa`, PostgreSQL 16 и Unix socket
`/var/run/postgresql`. Нельзя перенаправлять скрипт на существующую CRM/бот БД.
SQLAlchemy metadata не заменяет проверку production migrations.

`scripts/test_celery_release.py` использует два настоящих worker, Redis и PostgreSQL:
дубли задач, остановка после reservation и восстановление без повторной отправки.
Провайдеры синтетические. Проверенная ограниченная нагрузка не определяет предел
пропускной способности production.

Подтверждённый результат: 122 backend tests + 16 subtests, 12 PostgreSQL checks,
Celery crash/recovery gate и 4 demo tests. Границы: [RELIABILITY_RU.md](RELIABILITY_RU.md).

## CRM и внешние сценарии

Публичный snapshot содержит 24 CRM tests. Отдельная текущая полная CRM прошла
398 tests; 10 live read-only DB smoke выполнены отдельно с ограничением чтения.
Это разные наборы, нельзя выдавать snapshot за полный production suite.

Браузерные проверки выполняются на отдельной пустой QA-базе с синтетическими
аккаунтами и без production env/ключей транспорта. Проверяйте результат после
reload и в БД, а не только toast. Схема существующего тестового стенда может
отличаться от production даже при совпадении всех колонок: сравнивайте функции,
права, конфигурационные fixtures и зависимости.

Live Telegram/WhatsApp/Instagram/media — отдельные проверки с текущим согласившимся
тестировщиком по AGENTS.md. API 200, mock и доставка карточки не доказывают реальный
клик Telegram, доставку сообщения или наблюдение целой ночной смены.
