import json
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, text

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.entities import ApprovalRequest, Client, ConsultationReminder, Lead, Setting
from app.services import crm_notify, google_sheets, telegram
from app.tasks.celery_app import celery_app

_log = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.reminders.check_ai_budget")
def check_ai_budget() -> dict:
    """Warn managers when the configured monthly AI budget is running low."""
    with SessionLocal() as db:
        budget_row = db.scalar(select(Setting).where(Setting.key == "monthly_ai_budget_usd"))
        warn_row = db.scalar(select(Setting).where(Setting.key == "ai_budget_warn_percent"))
        budget = float(budget_row.value or 0) if budget_row else 0
        warn_percent = int(warn_row.value or 80) if warn_row else 80
        if budget <= 0:
            return {"skipped": True, "reason": "budget disabled"}
        spent = float(db.scalar(text("SELECT COALESCE(SUM(total_cost),0) FROM ai_usage WHERE created_at >= date_trunc('month', NOW())")) or 0)
        percent = spent / budget * 100
        if percent < warn_percent:
            return {"sent": False, "spent": spent, "percent": percent}
        marker = datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d")
        last_row = db.scalar(select(Setting).where(Setting.key == "ai_budget_last_alert_date"))
        if last_row and last_row.value == marker:
            return {"sent": False, "reason": "already sent today"}
        telegram.send_text_all_managers(
            f"⚠️ <b>Низкий остаток AI-бюджета</b>\n\n"
            f"Использовано: ${spent:.2f} из ${budget:.2f} ({percent:.0f}%).\n"
            "Позвоните владельцу Demi Results и напомните пополнить баланс."
        )
        if last_row:
            last_row.value = marker
        else:
            db.add(Setting(key="ai_budget_last_alert_date", value=marker, is_secret=False))
        db.commit()
        return {"sent": True, "spent": spent, "percent": percent}


@celery_app.task(name="app.tasks.reminders.send_daily_consultation_reminders")
def send_daily_consultation_reminders() -> dict:
    """Runs at 10:00 Bishkek. Sends a card to all managers for each today's consultation."""
    if not settings.google_sheets_enabled:
        return {"skipped": True, "reason": "sheets disabled"}

    today = datetime.now(ZoneInfo(settings.timezone)).strftime("%d.%m.%Y")
    consultations = google_sheets.get_todays_consultations()
    if not consultations:
        telegram.send_text_all_managers(
            f"📅 <b>Консультации на {today}</b>\n\nЗаписей нет."
        )
        return {"sent": 0, "date": today}

    # Send summary header
    telegram.send_text_all_managers(
        f"📅 <b>Консультации на сегодня ({today})</b>\n"
        f"Всего: {len(consultations)} запись(ей)"
    )

    db = SessionLocal()
    sent = 0
    try:
        for c in consultations:
            if c.get("reminder_sent") == "Да":
                continue

            # Check if we already created a DB record for this row
            existing = db.scalar(
                select(ConsultationReminder).where(
                    ConsultationReminder.sheet_name == c["sheet_name"],
                    ConsultationReminder.row_number == c["row_number"],
                )
            )
            if existing and existing.status != "pending":
                continue

            if not existing:
                reminder = ConsultationReminder(
                    sheet_name=c["sheet_name"],
                    row_number=c["row_number"],
                    consultation_date=c["date"],
                    consultation_time=c["time"],
                    client_name=c.get("name"),
                    client_phone=c.get("phone"),
                    lead_id_amo=c.get("lead_id"),
                    status="pending",
                )
                db.add(reminder)
                db.flush()
                crm_notify.notify(
                    type="consultation_booked",
                    title="Запись на консультацию",
                    body=f"{c.get('name') or 'Клиент'} · {c['date']} в {c['time']}",
                )
            else:
                reminder = existing

            # Send individual card
            message_ids = telegram.send_consultation_reminder_card(c, reminder.id)
            if message_ids:
                reminder.telegram_message_ids = json.dumps(message_ids)
                google_sheets.mark_reminder_sent(c["sheet_name"], c["row_number"])
                sent += 1

        db.commit()
    except Exception:
        db.rollback()
        _log.exception("Error in send_daily_consultation_reminders")
        raise
    finally:
        db.close()

    return {"sent": sent, "date": today}


@celery_app.task(name="app.tasks.reminders.check_consultation_results")
def check_consultation_results() -> dict:
    """Runs every 30 min. Sends follow-up cards for consultations that ended but have no result."""
    if not settings.google_sheets_enabled:
        return {"skipped": True}

    unresolved = google_sheets.get_past_consultations_without_result()
    if not unresolved:
        return {"checked": 0}

    db = SessionLocal()
    notified = 0
    try:
        for c in unresolved:
            existing = db.scalar(
                select(ConsultationReminder).where(
                    ConsultationReminder.sheet_name == c["sheet_name"],
                    ConsultationReminder.row_number == c["row_number"],
                )
            )
            if existing:
                if existing.status != "pending":
                    continue
                reminder = existing
            else:
                reminder = ConsultationReminder(
                    sheet_name=c["sheet_name"],
                    row_number=c["row_number"],
                    consultation_date=c["date"],
                    consultation_time=c["time"],
                    client_name=c.get("name"),
                    client_phone=c.get("phone"),
                    lead_id_amo=c.get("lead_id"),
                    status="pending",
                )
                db.add(reminder)
                db.flush()

            message_ids = telegram.send_consultation_reminder_card(c, reminder.id)
            if message_ids:
                reminder.telegram_message_ids = json.dumps(message_ids)
                notified += 1

        db.commit()
    except Exception:
        db.rollback()
        _log.exception("Error in check_consultation_results")
        raise
    finally:
        db.close()

    return {"notified": notified}


_UPCOMING_WINDOW_MINUTES = 30


@celery_app.task(name="app.tasks.reminders.check_upcoming_consultations")
def check_upcoming_consultations() -> dict:
    """Runs every 5 min. Notifies the CRM once per consultation starting within 30 min.

    Bounded window (see google_sheets.get_upcoming_consultations_within) plus a
    per-row flag committed immediately after each notify — not batched at the
    end of the loop. Both are direct lessons from the 10.07 overdue-approvals
    incident (§12 в HANDOFF.md): an open-ended query and an end-of-loop commit
    are exactly what turned one late run into hundreds of messages.
    """
    if not settings.google_sheets_enabled:
        return {"skipped": True}

    upcoming = google_sheets.get_upcoming_consultations_within(_UPCOMING_WINDOW_MINUTES)
    if not upcoming:
        return {"checked": 0}

    db = SessionLocal()
    notified = 0
    try:
        for c in upcoming:
            reminder = db.scalar(
                select(ConsultationReminder).where(
                    ConsultationReminder.sheet_name == c["sheet_name"],
                    ConsultationReminder.row_number == c["row_number"],
                )
            )
            if reminder is None:
                reminder = ConsultationReminder(
                    sheet_name=c["sheet_name"],
                    row_number=c["row_number"],
                    consultation_date=c["date"],
                    consultation_time=c["time"],
                    client_name=c.get("name"),
                    client_phone=c.get("phone"),
                    lead_id_amo=c.get("lead_id"),
                    status="pending",
                )
                db.add(reminder)

            if reminder.notify_30min_sent:
                continue

            crm_notify.notify(
                type="consultation_reminder",
                title="Через 30 минут консультация",
                body=f"{c.get('name') or 'Клиент'} · {c['date']} в {c['time']}",
                is_important=True,
            )
            reminder.notify_30min_sent = True
            db.commit()
            notified += 1
    except Exception:
        db.rollback()
        _log.exception("Error in check_upcoming_consultations")
        raise
    finally:
        db.close()

    return {"notified": notified}


# ─── Клиенты, ожидающие ответа ───────────────────────────────────────────────
# Здесь стояла задача check_overdue_approvals: каждые 5 минут она выбирала все
# pending-заявки старше 15 минут и слала по отдельному сообщению на каждую.
# Нижняя граница возраста была, верхней — нет, поэтому на базе с накопленными
# заявками один-единственный запуск означал сотни сообщений подряд. Её заменяет
# одна сводка в сутки: номера в общий чат не уходят, список приходит в личку
# тому менеджеру, который нажал кнопку, и собирается в момент нажатия.

# Заявка, провисевшая месяц, — это уже не «клиент ждёт ответа», а мусор в базе.
_MAX_AGE_DAYS = 30


def _client_contact(phone: str | None, name: str | None, extracted: dict | None) -> str | None:
    """Контакт клиента в том же порядке, в каком его ищут карточки в telegram.py.

    clients.phone на практике пустой у всех записей: бот его не заполняет.
    Реальный контакт достаёт AI и кладёт в extracted_fields['contacts'] —
    там либо номер, либо ник в инстаграме.
    """
    if phone:
        return phone
    if telegram.looks_like_phone(name):
        return name
    contact = (extracted or {}).get("contacts")
    return str(contact).strip() or None if contact else None


def collect_waiting_clients(db) -> list[tuple[str | None, str]]:
    """Клиенты с неотвеченной заявкой, от самых давних: (контакт | None, amocrm_lead_id)."""
    cutoff = datetime.now(ZoneInfo("UTC")) - timedelta(days=_MAX_AGE_DAYS)

    rows = db.execute(
        select(
            Client.phone,
            Client.name,
            ApprovalRequest.extracted_fields,
            Lead.amocrm_lead_id,
        )
        .select_from(ApprovalRequest)
        .join(Lead, Lead.id == ApprovalRequest.lead_id)
        .outerjoin(Client, Client.id == Lead.client_id)
        .where(
            ApprovalRequest.status == "pending",
            ApprovalRequest.created_at >= cutoff,
        )
        .order_by(ApprovalRequest.created_at)
    ).all()

    seen: set[str] = set()
    contacts: list[tuple[str | None, str]] = []
    for phone, name, extracted, amocrm_lead_id in rows:
        contact = _client_contact(phone, name, extracted)
        # На одного клиента может висеть несколько заявок — контакт нужен один раз.
        key = contact or f"lead:{amocrm_lead_id}"
        if key in seen:
            continue
        seen.add(key)
        contacts.append((contact, amocrm_lead_id))
    return contacts


@celery_app.task(name="app.tasks.reminders.send_waiting_clients_digest")
def send_waiting_clients_digest() -> dict:
    """09:00 Бишкек: ровно одно сообщение на чат. Сами номера — только по кнопке."""
    db = SessionLocal()
    try:
        total = len(collect_waiting_clients(db))
    except Exception:
        _log.exception("Error in send_waiting_clients_digest")
        return {"waiting": 0, "error": True}
    finally:
        db.close()

    telegram.send_waiting_clients_digest(total)
    return {"waiting": total}
