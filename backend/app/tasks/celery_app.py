from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery("demi_results_bot", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone=settings.timezone,
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    # Часы в crontab() ниже — по timezone выше (Asia/Bishkek), а не по UTC:
    # beat сверяется с app.timezone, а enable_utc влияет только на то, в каком
    # виде метки времени едут внутри сообщений брокера.
    beat_schedule={
        "resume-night-inbox": {
            "task": "resume_night_inbox",
            "schedule": crontab(minute="*/5"),
        },
        # 10:00 Bishkek
        "daily-consultation-reminders": {
            "task": "app.tasks.reminders.send_daily_consultation_reminders",
            "schedule": crontab(hour=10, minute=0),
        },
        # Every 30 min — check who came
        "check-consultation-results": {
            "task": "app.tasks.reminders.check_consultation_results",
            "schedule": crontab(minute="*/30"),
        },
        # Every 5 min — CRM notification for consultations starting within 30 min.
        # Bounded window + per-row idempotency flag, see task docstring.
        "check-upcoming-consultations": {
            "task": "app.tasks.reminders.check_upcoming_consultations",
            "schedule": crontab(minute="*/5"),
        },
        # 09:00 Bishkek — одна сводка в день по клиентам, ждущим ответа.
        "daily-waiting-clients": {
            "task": "app.tasks.reminders.send_waiting_clients_digest",
            "schedule": crontab(hour=9, minute=0),
        },
        "check-ai-budget": {
            "task": "app.tasks.reminders.check_ai_budget",
            "schedule": crontab(hour="10,16", minute=0),
        },
    },
)
celery_app.autodiscover_tasks(["app.tasks.pipeline", "app.tasks.reminders"])
