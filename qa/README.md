# Disposable offline QA

From the repository root, build once with Internet access and run offline:

```sh
docker compose -f qa/compose.yaml build
docker compose -f qa/compose.yaml up --abort-on-container-exit --exit-code-from tests
# Run even after a failed test. Deletes only this QA project's resources.
docker compose -f qa/compose.yaml down --volumes
```

Do not pass `--env-file`, host directories, production volumes or Docker socket.
All three runtime services use `network_mode: none`; they share only their own Unix
socket volume. PostgreSQL data and SQLite fixtures in `/tmp` are temporary RAM
filesystems; this avoids slow fsync on a container overlay. The runner clears the environment,
requires an empty `green_release_qa` database, runs real PostgreSQL concurrency
checks, offline backend tests, demo tests, then two actual Celery workers with
Redis. The Celery gate dispatches duplicate generation/approval jobs and kills a
worker after reservation to verify recovery without duplicate provider calls. Rerunning requires `down --volumes`.
No external calls are permitted by test fixtures.

An existing dependency-only Python image can be supplied using
`DEMI_QA_PYTHON_IMAGE`; an existing PG 16 image using `DEMI_QA_POSTGRES_IMAGE`.
This allows reuse of local images on a server with limited disk space. The image
must contain Python 3.12 and the locked requirements to build without Internet.
Do not use production images that contain credentials.

The AI and external transports remain synthetic. This does **not** reproduce
Supabase/Auth/CRM production migrations, browser E2E or real provider delivery.
