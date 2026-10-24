import json
import logging
import re
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from tenacity import RetryError

_log = logging.getLogger(__name__)

from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.entities import (
    ActionLog,
    AIExtractedFields,
    AIUsage,
    ApprovalRequest,
    Blacklist,
    Client,
    ClientMemory,
    ConsultationSlot,
    Lead,
    Message,
    MessageBuffer,
    Setting,
    TrainingExample,
)
from app.services import amocrm, crm_notify, google_sheets, telegram, outbox, pipeline_fence
from app.services.openai_service import AIResult, ai_edit_reply, classify_sales_intent, detect_and_translate, detect_language, extract_fields, generate_purchase_template, generate_reply, strip_voice_marker, summarize_dialogue, verify_reply
from app.services.message_policy import is_plus_only_message, is_service_message
from app.services.outgoing import message_delay_seconds, split_outgoing_messages
from app.services.slots import check_consultation_slots
from app.services.reply_hours import reply_hours_policy
from app.tasks.celery_app import celery_app


def log_action(db, lead_id: int | None, action: str, status: str, request=None, response=None, error=None) -> None:
    db.add(
        ActionLog(
            lead_id=lead_id,
            action=action,
            status=status,
            request_payload=request,
            response_payload=response,
            error=str(error) if error else None,
        )
    )
    db.commit()


def save_ai_usage(db, lead_id: int, result: AIResult, message_id: int | None = None) -> None:
    model_name = (result.model or "").lower()
    if model_name.startswith("deepseek"):
        provider = "deepseek"
    elif model_name.startswith("gemini"):
        provider = "google"
    elif model_name == "deterministic":
        provider = "internal"
    else:
        provider = "openai"
    db.add(
        AIUsage(
            lead_id=lead_id,
            message_id=message_id,
            provider=provider,
            model=result.model,
            purpose=result.purpose,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            total_tokens=result.total_tokens,
            input_cost=result.input_cost,
            output_cost=result.output_cost,
            total_cost=result.total_cost,
            latency_ms=result.latency_ms,
            raw_usage=result.raw_usage,
        )
    )
    db.commit()


def _looks_like_openai_quota_error(error: Exception) -> bool:
    pending = [error]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        value = str(current).lower()
        if any(marker in value for marker in (
            "insufficient_quota", "credit_balance_exhausted",
            "you have no credits remaining", "billing_hard_limit_reached",
        )):
            return True
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if isinstance(current, RetryError):
            underlying = current.last_attempt.exception()
            if underlying is not None:
                pending.append(underlying)
    return False


def _notify_openai_quota_once(db, error: Exception) -> None:
    """Send one Telegram warning per day when OpenAI rejects generation by quota."""
    if not _looks_like_openai_quota_error(error):
        return

    marker = datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d")
    row = db.scalar(select(Setting).where(Setting.key == "openai_quota_last_alert_date"))
    if row and row.value == marker:
        return

    try:
        telegram.send_text_all_managers(
            "⚠️ <b>OpenAI квота закончилась</b>\n\n"
            "Бот не может генерировать AI-ответы, потому что провайдер вернул ошибку баланса/квоты.\n"
            "Заявки не потеряются: CRM продолжит создавать согласования, но менеджеру нужно написать ответ вручную.\n\n"
            "Позвоните владельцу Demi Results и напомните пополнить баланс OpenAI."
        )
    except Exception as notify_error:
        log_action(db, None, "telegram.openai_quota_alert", "error", error=notify_error)
        return

    if row:
        row.value = marker
    else:
        db.add(Setting(key="openai_quota_last_alert_date", value=marker, is_secret=False))
    log_action(db, None, "telegram.openai_quota_alert", "success", request={"date": marker})
    db.commit()


def _is_test(lead: Lead | None) -> bool:
    """Лид из AI-лаборатории: наружу от него ничего не уходит.

    Пайплайн при этом отрабатывает целиком — классификация, ответ ИИ, карточка
    менеджеру, кнопки. Разница только в том, что вместо вызова amoCRM / Sheets
    мы пишем в action_logs статус dry_run: в терминале лаборатории видно, что
    бот СОБИРАЛСЯ сделать, а прод-данные при этом не трогаются.
    """
    return bool(lead is not None and lead.is_test)


def _dialogue_from_remote_history(remote_history: list[dict]) -> list[dict]:
    """Keep chronology, time and who sent every message in the AI context."""
    labels = {"client": "клиент", "manager": "менеджер", "bot": "бот"}
    dialogue: list[dict] = []
    for item in remote_history:
        content = str(item.get("content") or "").strip()
        if not content or is_service_message(content):
            continue
        created_at = item.get("created_at")
        time_label = created_at.astimezone(ZoneInfo(settings.timezone)).strftime("%d.%m %H:%M") if created_at else ""
        speaker = labels.get(item.get("speaker"), "клиент" if item.get("role") == "user" else "менеджер")
        prefix = f"[{speaker} · {time_label}]" if time_label else f"[{speaker}]"
        dialogue.append({"role": item["role"], "content": f"{prefix} {content}"})
    return dialogue


def _outgoing_after_client(remote_history: list[dict], client_timestamp: datetime) -> dict | None:
    """Return the latest outgoing message if it already answered this client turn."""
    relevant = [
        item for item in remote_history
        if item.get("created_at") and item.get("content") and not is_service_message(item["content"])
    ]
    if not relevant:
        return None
    latest = max(relevant, key=lambda item: item["created_at"])
    # amoCRM timestamps have one-second precision while webhook buffers may keep
    # microseconds, so allow one second when ordering the same turn.
    if latest.get("role") == "assistant" and latest["created_at"] + timedelta(seconds=1) >= client_timestamp:
        return latest
    return None


def _buffers_after_latest_outgoing(buffers: list, remote_history: list[dict]) -> list:
    """Keep only client buffers that belong to the turn after the latest reply.

    A manager can answer while the debounce window is still collecting client
    messages. In that case the old question and the later "спасибо" used to be
    concatenated into one new request. amo message IDs are the reliable boundary;
    timestamps are only a fallback because amo stores them with second precision.
    """
    relevant = [
        item for item in remote_history
        if item.get("created_at") and item.get("content") and not is_service_message(item["content"])
    ]
    outgoing_indexes = [index for index, item in enumerate(relevant) if item.get("role") == "assistant"]
    if not outgoing_indexes:
        return buffers

    boundary_index = outgoing_indexes[-1]
    boundary = relevant[boundary_index]
    remote_ids = {str(item.get("message_id") or "") for item in relevant}
    client_ids_after = {
        str(item.get("message_id") or "")
        for item in relevant[boundary_index + 1:]
        if item.get("role") == "user" and item.get("message_id")
    }
    return [
        item for item in buffers
        if str(item.message_id) in client_ids_after
        or (
            str(item.message_id) not in remote_ids
            and item.timestamp > boundary["created_at"]
        )
    ]


_CLOSING_ACK_RE = re.compile(
    r"^(?:(?:понял[аи]?|ясно|хорошо|ладно|ок(?:ей)?|вс[её]\s+понятно)\s*[,!.]?\s*)?"
    r"(?:спасибо|благодарю|рахмат)"
    r"(?:\s*[,!.]?\s*(?:понял[аи]?|ясно|хорошо|ладно|ок(?:ей)?|вс[её]\s+понятно))?"
    r"[\s!.🙏👍]*$",
    re.IGNORECASE,
)


def _is_closing_acknowledgement(text: str, previous_reply: str | None = None) -> bool:
    """True only for a short acknowledgement that contains no new request."""
    value = str(text or "").strip()
    if _CLOSING_ACK_RE.fullmatch(value):
        return True
    # A short agreement can answer a real question. Only close it when the
    # previous outgoing statement did not ask the client anything.
    if previous_reply is None or "?" in previous_reply:
        return False
    return bool(re.fullmatch(
        r"(?:(?:хорошо|ладно|ок(?:ей)?|ok(?:ay)?|понял[аи]?|ясно|вс[её]\s+понятно|макул|жакшы|ооба|оба)[\s.!,🙏👍👌🙂😊✅]*|[👍👌🙏✅❤️♥️]+)",
        value, re.IGNORECASE,
    ))


def move_lead_status(db, lead: Lead, status_id: int | None, reason: str) -> None:
    if not status_id:
        return
    if _is_green_whatsapp_lead(lead) or _is_instagram_meta_lead(lead):
        lead.status_id = status_id
        client = lead.client
        try:
            response = crm_notify.sync_deal({
                "lead_id": int(lead.amocrm_lead_id),
                "pipeline_id": 10355262,
                "status_id": int(status_id),
                "title": (client.name if client else None) or f"Сделка #{lead.amocrm_lead_id}",
                "amount": None,
                "customer_name": client.name if client else None,
                "customer_phone": client.phone if client else None,
                "customer_username": None,
                "source": _crm_deal_source(client.source if client else None),
                "created_at": lead.created_at.isoformat(),
                "updated_at": datetime.now(ZoneInfo("UTC")).isoformat(),
            })
            log_action(db, lead.id, "crm.move_lead_status", "success", {"reason": reason, "status_id": status_id}, response)
        except Exception as exc:
            log_action(db, lead.id, "crm.move_lead_status", "error", {"reason": reason, "status_id": status_id}, error=exc)
        db.commit()
        return
    if _is_test(lead):
        lead.status_id = status_id
        log_action(db, lead.id, "amocrm.move_lead_status", "dry_run", {"reason": reason, "status_id": status_id})
        return
    automatic_sources: dict[str, set[int | None]] = {
        "non_sales_message": {None, settings.amocrm_status_unsorted},
        "sales_message": {
            None,
            settings.amocrm_status_unsorted,
            settings.amocrm_status_primary_contact,
        },
        "lead_qualified": {
            None,
            settings.amocrm_status_unsorted,
            settings.amocrm_status_primary_contact,
            settings.amocrm_status_qualified,
        },
        "purchase_intent": {
            None,
            settings.amocrm_status_unsorted,
            settings.amocrm_status_primary_contact,
            settings.amocrm_status_qualified,
            settings.amocrm_status_purchase,
        },
        "consultation_confirmed": {
            None,
            settings.amocrm_status_unsorted,
            settings.amocrm_status_primary_contact,
            settings.amocrm_status_qualified,
            settings.amocrm_status_purchase,
            settings.amocrm_status_consultation_scheduled,
        },
    }
    allowed = automatic_sources.get(reason)
    if allowed is not None and lead.status_id not in allowed:
        log_action(
            db,
            lead.id,
            "amocrm.move_lead_status",
            "skipped",
            {"reason": reason, "status_id": status_id, "current_status_id": lead.status_id},
        )
        return
    try:
        response = amocrm.patch_lead_status(lead.amocrm_lead_id, status_id)
        lead.status_id = status_id
        log_action(
            db,
            lead.id,
            "amocrm.move_lead_status",
            "success",
            {"reason": reason, "status_id": status_id},
            response,
        )
        client = lead.client
        try:
            sync_response = crm_notify.sync_deal({
                "lead_id": int(lead.amocrm_lead_id),
                "pipeline_id": 10355262,
                "status_id": int(status_id),
                "title": (client.name if client else None) or f"Сделка #{lead.amocrm_lead_id}",
                "amount": None,
                "customer_name": client.name if client else None,
                "customer_phone": client.phone if client else None,
                "customer_username": None,
                "source": _crm_deal_source(client.source if client else None),
                "created_at": lead.created_at.isoformat(),
                "updated_at": datetime.now(ZoneInfo("UTC")).isoformat(),
            })
            log_action(db, lead.id, "crm.sync_deal", "success", {"status_id": status_id}, sync_response)
        except Exception as exc:
            log_action(db, lead.id, "crm.sync_deal", "error", {"status_id": status_id}, error=exc)
    except Exception as exc:
        log_action(
            db,
            lead.id,
            "amocrm.move_lead_status",
            "error",
            {"reason": reason, "status_id": status_id},
            error=exc,
        )


def _crm_deal_source(value: str | None) -> str:
    normalized = (value or "").lower()
    if "wapp" in normalized or "whatsapp" in normalized:
        return "whatsapp"
    if "instagram" in normalized:
        return "instagram"
    if "telegram" in normalized:
        return "telegram"
    return "amocrm"


def _reserve_consultation_slot(db, lead: Lead, extracted: dict) -> None:
    slot_date = datetime.strptime(extracted["consultation_date"], "%d.%m.%Y").date()
    slot_time = datetime.strptime(extracted["consultation_time"], "%H:%M").time()
    existing = db.scalar(select(ConsultationSlot).where(
        ConsultationSlot.date == slot_date,
        ConsultationSlot.time == slot_time,
    ))
    if existing and existing.status in ("booked", "blocked") and existing.lead_id != lead.id:
        raise RuntimeError("Consultation slot was already booked")
    if existing:
        existing.status = "booked"
        existing.lead_id = lead.id
        existing.source = "bot"
    else:
        db.add(ConsultationSlot(
            date=slot_date,
            time=slot_time,
            status="booked",
            lead_id=lead.id,
            source="bot",
        ))
    db.commit()


def _lead_stage_snapshot(db, lead: Lead) -> dict:
    # У тестового лида нет соответствия в amoCRM: запрос вернул бы 404 и засорил
    # ленту ошибкой. Этап такого лида живёт только в нашей leads.status_id.
    if not settings.amocrm_access_token or _is_test(lead) or _is_green_whatsapp_lead(lead) or _is_instagram_meta_lead(lead):
        return {}
    try:
        stage = amocrm.lead_stage_snapshot(lead.amocrm_lead_id)
        if stage.get("status_id"):
            lead.status_id = stage["status_id"]
            db.commit()
        return stage
    except Exception as exc:
        log_action(db, lead.id, "amocrm.get_lead_stage", "error", error=exc)
        return {}


def _mark_buffers_processed(db, buffers: list[MessageBuffer]) -> None:
    for item in buffers:
        item.processed = True
    db.commit()


def _manager_took_over(db, lead: Lead, buffers: list[MessageBuffer]) -> bool:
    """Re-check AI state after slow model/API calls to close the takeover race."""
    db.refresh(lead)
    if lead.ai_enabled:
        return False
    _mark_buffers_processed(db, buffers)
    log_action(db, lead.id, "pipeline.manager_takeover", "skipped")
    return True


def _load_templates(db) -> list[dict]:
    try:
        import json as _json
        row = db.scalar(select(Setting).where(Setting.key == "reply_templates"))
        return _json.loads(row.value) if row and row.value else []
    except Exception:
        return []


def _load_extra_manager_ids(db) -> list[str]:
    """Return chat IDs of managers stored in settings table."""
    try:
        row = db.scalar(select(Setting).where(Setting.key == "telegram_managers"))
        if not row or not row.value:
            return []
        import json as _json
        managers = _json.loads(row.value)
        return [str(m["chat_id"]) for m in managers if m.get("chat_id")]
    except Exception:
        return []


def _approval_channel(db) -> str:
    row = db.scalar(select(Setting).where(Setting.key == "approval_channel"))
    value = row.value if row and row.value else "crm"
    return value if value in {"crm", "both", "telegram"} else "crm"


def _approval_uses_telegram(db, lead: Lead | None = None) -> bool:
    # Laboratory leads must exercise the CRM workflow only. Sending their
    # approval cards into real managers' Telegram chats makes a test noisy and
    # defeats the point of an isolated test client.
    return not _is_test(lead) and _approval_channel(db) in {"both", "telegram"}


def _is_green_whatsapp_lead(lead: Lead | None) -> bool:
    source = ((lead.client.source if lead and lead.client else "") or "").lower()
    return "whatsapp" in source or "green_api" in source


def _is_instagram_meta_lead(lead: Lead | None) -> bool:
    source = ((lead.client.source if lead and lead.client else "") or "").lower()
    return "instagram_meta" in source


def _send_green_whatsapp_message(chat_id: str, text: str) -> dict:
    return crm_notify.send_channel_message("whatsapp", chat_id, text)


def _reply_hours():
    return reply_hours_policy(datetime.now(ZoneInfo(settings.timezone)),
                              start_hour=settings.reply_start_hour,
                              end_hour=settings.reply_end_hour, timezone=settings.timezone)


def _night_reply(db, lead, buffers) -> bool:
    """Only a fixed notice at night. Keep buffers for the morning approval queue."""
    if not settings.reply_hours_enabled:
        return False
    decision = _reply_hours()
    if decision.requires_human_approval:
        return False
    if _is_blacklisted(db, lead) or _manager_took_over(db, lead, buffers):
        return True
    marker_key = f"night_resume:{lead.id}"
    if not db.scalar(select(Setting).where(Setting.key == marker_key)):
        db.add(Setting(key=marker_key, value=str(lead.id), is_secret=False))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    trigger = f"night:{lead.id}:{decision.night_key}"
    # The unique Message.message_id reserves this night before the provider call.
    # An ambiguous result is not automatically resent; the inbox stays available.
    send_approved_reply(db, lead, buffers[-1].conversation_id, trigger,
                        decision.reply_text, None)
    return True


@celery_app.task(name="resume_night_inbox")
def resume_night_inbox() -> None:
    """Persistent morning recovery; beat runs this even after worker restart."""
    if not settings.reply_hours_enabled or not _reply_hours().requires_human_approval:
        return
    with SessionLocal() as db:
        markers = db.scalars(select(Setting).where(Setting.key.like("night_resume:%"))).all()
        for marker in markers:
            marker_key = marker.key
            try:
                lead_id = int(marker.value)
                latest = db.scalar(select(MessageBuffer).where(
                    MessageBuffer.lead_id == lead_id, MessageBuffer.processed.is_(False),
                ).order_by(MessageBuffer.timestamp.desc()).limit(1))
                if latest:
                    process_lead_buffer(lead_id, latest.message_id)
                    db.expire_all()
                remaining = db.scalar(select(MessageBuffer.id).where(
                    MessageBuffer.lead_id == lead_id, MessageBuffer.processed.is_(False),
                ).limit(1))
                if not remaining:
                    db.delete(marker)
                    db.commit()
            except Exception:
                db.rollback()
                _log.exception("Inbox recovery failed for marker %s", marker_key)


# Lead is qualified when the bot knows enough for the amoCRM card:
# the skin problem plus where the client is and the consultation format.
QUALIFICATION_FIELDS = ("skin_problem", "city", "consultation_format")

PLUS_WELCOME_REPLY = (
    "Здравствуйте! 👋 Вы написали в Demi Results — мы помогаем подобрать "
    "профессиональный уход за кожей и проводим консультации косметолога. "
    "Расскажите, пожалуйста, что вас беспокоит, или, если удобно, отправьте "
    "фото лица при хорошем освещении — мы посмотрим и подскажем, с чего начать."
)


def _is_qualified(extracted: dict) -> bool:
    return all(extracted.get(key) for key in QUALIFICATION_FIELDS)


def apply_sales_stage_from_extracted(db, lead: Lead, extracted: dict) -> None:
    if extracted.get("consultation_confirmed"):
        move_lead_status(
            db,
            lead,
            settings.amocrm_status_consultation_scheduled,
            "consultation_confirmed",
        )
        return
    if _is_qualified(extracted):
        move_lead_status(db, lead, settings.amocrm_status_qualified, "lead_qualified")


def _get_client_phone(lead: Lead) -> str | None:
    """Returns client phone from client.phone, or from client.name if it looks like a number."""
    if not lead.client:
        return None
    if lead.client.phone:
        return lead.client.phone
    name = lead.client.name or ""
    digits = re.sub(r"\D", "", name)
    if digits and len(digits) >= 9 and digits == re.sub(r"\s", "", name):
        return name
    return None


def _is_blacklisted(db, lead: Lead) -> bool:
    phone = _get_client_phone(lead)
    if not phone:
        return False
    return db.scalar(select(Blacklist).where(Blacklist.phone == phone)) is not None


def _check_stop_words(db, text: str) -> str:
    """Returns the matched stop word if any, empty string otherwise."""
    setting = db.scalar(select(Setting).where(Setting.key == "stop_words"))
    if not setting or not setting.value.strip():
        return ""
    for word in setting.value.split(","):
        word = word.strip().lower()
        if word and word in text.lower():
            return word
    return ""


def _count_repeat_leads(db, lead: Lead) -> int:
    """Returns total lead count for this client's phone number."""
    phone = _get_client_phone(lead)
    if not phone:
        return 1
    from sqlalchemy import func as sqlfunc
    count = db.scalar(
        select(sqlfunc.count(Lead.id))
        .join(Client, Lead.client_id == Client.id)
        .where((Client.phone == phone) | (Client.name == phone))
    )
    return count or 1


# Fields persisted in client_memory (long-term, across leads)
MEMORY_FIELDS = [
    "name", "age", "city", "skin_type", "skin_problem", "goal", "problem_duration",
    "uses_care", "allergies", "consultation_confirmed", "bought_before",
    "products_used", "what_helped", "what_not_helped", "last_action",
]


def merge_client_memory(db, lead: Lead, extracted: dict, all_messages: list) -> dict:
    """Merge freshly extracted fields with the client's stored long-term memory.

    Stored values fill gaps in the new extraction; new non-empty values
    overwrite stored ones. Returns the merged dict (used for the card),
    and persists updates to client_memory.
    """
    if not lead.client_id:
        return extracted
    try:
        rows = db.scalars(
            select(ClientMemory).where(ClientMemory.client_id == lead.client_id)
        ).all()
        stored = {r.key: r for r in rows}
        merged = dict(extracted)
        for key in MEMORY_FIELDS:
            new_val = extracted.get(key)
            new_empty = new_val in (None, "", [], False)
            if new_empty and key in stored:
                old_raw = stored[key].value
                merged[key] = json.loads(old_raw) if old_raw.startswith(("[", "{")) or old_raw in ("true", "false") else old_raw
            elif not new_empty:
                val_str = json.dumps(new_val, ensure_ascii=False) if isinstance(new_val, (list, dict, bool)) else str(new_val)
                if key in stored:
                    stored[key].value = val_str
                else:
                    db.add(ClientMemory(client_id=lead.client_id, lead_id=lead.id, key=key, value=val_str, source="ai"))
        # Contact dates from message history
        if all_messages:
            _tz = ZoneInfo(settings.timezone)
            merged["_first_contact"] = all_messages[0].created_at.astimezone(_tz).strftime("%d.%m.%Y") if all_messages[0].created_at else None
            merged["_last_contact"] = all_messages[-1].created_at.astimezone(_tz).strftime("%d.%m.%Y") if all_messages[-1].created_at else None
        db.commit()
        return merged
    except Exception as exc:
        _log.warning("merge_client_memory failed lead=%s: %s", lead.id, exc)
        db.rollback()
        return extracted


@celery_app.task(name="process_lead_buffer", autoretry_for=(Exception,), retry_backoff=300, retry_jitter=False, max_retries=3)
def process_lead_buffer(lead_pk: int, triggering_message_id: str) -> None:
    db = SessionLocal()
    lock_connection = None
    fence_guard = None
    try:
        if db.get_bind().dialect.name == "postgresql":
            # Session advisory lock survives every pipeline commit. Detach so
            # close physically releases the lock instead of returning it pooled.
            lock_connection = db.get_bind().connect()
            lock_connection = lock_connection.execution_options(isolation_level="AUTOCOMMIT")
            lock_connection.detach()
            lock_connection.execute(text("SET statement_timeout = '60s'"))
            lock_connection.execute(
                text("SELECT pg_advisory_lock(:namespace, :lead_id)"),
                {"namespace": 0x44454D49, "lead_id": lead_pk},
            )
            fence_guard = pipeline_fence.install(db, lead_pk)
        lead = db.get(Lead, lead_pk)
        if not lead or not lead.ai_enabled:
            return
        buffers = db.scalars(
            select(MessageBuffer)
            .where(MessageBuffer.lead_id == lead.id, MessageBuffer.processed.is_(False))
            .order_by(MessageBuffer.timestamp.asc())
        ).all()
        if not buffers or buffers[-1].message_id != triggering_message_id:
            return
        existing_reply = db.scalar(
            select(Message).where(
                Message.lead_id == lead.id,
                Message.message_id == f"ai:{triggering_message_id}",
            )
        )
        if existing_reply:
            return
        if _night_reply(db, lead, buffers):
            return
        remote_history: list[dict] = []
        if not _is_test(lead) and not _is_green_whatsapp_lead(lead) and not _is_instagram_meta_lead(lead):
            try:
                remote_history = amocrm.get_chat_history(lead.chat_id or "")
                newest_outgoing = max(
                    (
                        item["created_at"]
                        for item in remote_history
                        if item["role"] == "assistant" and not is_service_message(item["content"])
                    ),
                    default=None,
                )
                if newest_outgoing:
                    externally_answered = db.scalars(
                        select(ApprovalRequest).where(
                            ApprovalRequest.lead_id == lead.id,
                            ApprovalRequest.status.in_(["pending", "edited"]),
                            ApprovalRequest.created_at < newest_outgoing,
                        )
                    ).all()
                    for item in externally_answered:
                        item.status = "answered_external"
                        item.approved_at = newest_outgoing
                    if externally_answered:
                        db.commit()
                        log_action(
                            db,
                            lead.id,
                            "amocrm.reconcile_outgoing",
                            "success",
                            response={"closed_approvals": len(externally_answered)},
                        )
                log_action(
                    db,
                    lead.id,
                    "amocrm.chat_history",
                    "success",
                    response={"messages": len(remote_history)},
                )
            except Exception as exc:
                log_action(db, lead.id, "amocrm.chat_history", "error", error=exc)

        existing_approval = db.scalar(
            select(ApprovalRequest).where(
                ApprovalRequest.lead_id == lead.id,
                ApprovalRequest.status.in_(["pending", "edited"]),
            )
        )
        if existing_approval:
            # The beat sweep also resumes daytime follow-ups once the card closes.
            marker_key = f"night_resume:{lead.id}"
            if not db.scalar(select(Setting).where(Setting.key == marker_key)):
                db.add(Setting(key=marker_key, value=str(lead.id), is_secret=False))
                try:
                    db.commit()
                except IntegrityError:
                    db.rollback()
            return

        active_buffers = _buffers_after_latest_outgoing(buffers, remote_history)
        active_ids = {item.id for item in active_buffers}
        for item in buffers:
            if item.id not in active_ids:
                item.processed = True
        usable_buffers = [item for item in active_buffers if item.text and not is_service_message(item.text)]
        if not usable_buffers:
            _mark_buffers_processed(db, buffers)
            log_action(db, lead.id, "pipeline.no_client_turn_after_outgoing", "skipped")
            return
        combined_text = " ".join(item.text for item in usable_buffers).strip()
        conversation_id = active_buffers[-1].conversation_id

        previous_reply = next((str(item.get("content") or "") for item in reversed(remote_history)
                               if item.get("role") == "assistant"), None)
        if previous_reply is None:
            previous_reply = db.scalar(select(Message.text).where(
                Message.lead_id == lead.id,
                Message.role.in_(['assistant', 'manager']),
                Message.direction == 'outgoing',
                Message.status.in_(['sent', 'delivered', 'read']),
            ).order_by(Message.created_at.desc(), Message.id.desc()).limit(1))
        if _is_closing_acknowledgement(combined_text, previous_reply=previous_reply) and previous_reply is not None:
            _mark_buffers_processed(db, buffers)
            log_action(
                db,
                lead.id,
                "pipeline.closing_ack_after_outgoing",
                "skipped",
                {"message": combined_text},
            )
            return

        answered_after_client = _outgoing_after_client(remote_history, active_buffers[-1].timestamp)
        if answered_after_client:
            _mark_buffers_processed(db, buffers)
            log_action(
                db,
                lead.id,
                "pipeline.skip_after_outgoing",
                "skipped",
                response={
                    "speaker": answered_after_client.get("speaker", "manager"),
                    "author_name": answered_after_client.get("author_name"),
                    "client_at": active_buffers[-1].timestamp.isoformat(),
                    "outgoing_at": answered_after_client["created_at"].isoformat(),
                },
            )
            return

        # Blacklist check
        if _is_blacklisted(db, lead):
            _mark_buffers_processed(db, buffers)
            log_action(db, lead.id, "pipeline.blacklisted", "skipped", {"phone": _get_client_phone(lead)})
            return

        all_messages = db.scalars(
            select(Message)
            .where(Message.lead_id == lead.id)
            .order_by(Message.created_at.asc())
        ).all()
        if remote_history:
            full_dialogue = _dialogue_from_remote_history(remote_history)
        else:
            full_dialogue = [
                {"role": m.role, "content": m.text}
                for m in all_messages
                if m.text and not is_service_message(m.text)
            ]
        remote_message_ids = {str(item.get("message_id") or "") for item in remote_history}
        triggering_is_remote = str(triggering_message_id) in remote_message_ids or any(
            item.get("role") == "user"
            and str(item.get("content") or "").strip() == str(usable_buffers[-1].text or "").strip()
            and item.get("created_at")
            and abs((item["created_at"] - active_buffers[-1].timestamp).total_seconds()) <= 2
            for item in remote_history
        )
        local_message_ids = {str(message.message_id) for message in all_messages if message.role == 'user'}
        triggering_is_local = not remote_history and (
            all(str(item.message_id) in local_message_ids for item in usable_buffers)
            or (full_dialogue and full_dialogue[-1].get('role') == 'user'
                and str(full_dialogue[-1].get('content') or '').strip() == combined_text)
        )
        if combined_text and not triggering_is_remote and not triggering_is_local:
            full_dialogue.append({"role": "user", "content": combined_text})

        # last 30 messages for reply generation
        dialogue = full_dialogue[-30:]

        # Time of the current client message is shown on every approval card.
        _current_msg_bk = active_buffers[-1].timestamp.astimezone(ZoneInfo(settings.timezone))
        _last_msg_display = _current_msg_bk.strftime("%H:%M %d.%m.%Y")

        stage = _lead_stage_snapshot(db, lead)
        if (
            settings.amocrm_status_consultation_scheduled
            and stage.get("status_id") == settings.amocrm_status_consultation_scheduled
        ):
            _mark_buffers_processed(db, buffers)
            log_action(
                db,
                lead.id,
                "pipeline.skip_scheduled_consultation",
                "skipped",
                {"status_id": stage.get("status_id"), "stage_name": stage.get("stage_name")},
            )
            return

        plus_request = is_plus_only_message(combined_text)
        if plus_request:
            intent_result = AIResult(
                content={"is_sales": True, "is_purchase": False, "is_complex": False,
                         "reason": "plus_opt_in"},
                model="deterministic",
                purpose="sales_intent",
            )
        else:
            intent_result = classify_sales_intent(dialogue, combined_text)
            save_ai_usage(db, lead.id, intent_result)
        intent = dict(intent_result.content)
        log_action(
            db,
            lead.id,
            "openai.sales_intent",
            "success",
            request={"latest_message": combined_text},
            response={"intent": intent, "usage": intent_result.model_dump(exclude={"content"})},
        )
        if not intent.get("is_sales", True):
            client = lead.client
            try:
                crm_notify.sync_deal({
                    "lead_id": int(lead.amocrm_lead_id),
                    "pipeline_id": 10355262,
                    "stage_name": "Нестандартный запрос",
                    "title": (client.name if client else None) or f"Сделка #{lead.amocrm_lead_id}",
                    "amount": None,
                    "customer_name": client.name if client else None,
                    "customer_phone": client.phone if client else None,
                    "customer_username": None,
                    "source": _crm_deal_source(client.source if client else None),
                    "created_at": lead.created_at.isoformat(),
                    "updated_at": datetime.now(ZoneInfo("UTC")).isoformat(),
                })
                crm_notify.notify(
                    type="sale_lead",
                    title="Нестандартный запрос клиента",
                    body=f"{(client.name if client else None) or 'Клиент'}: {combined_text[:180]}",
                    is_important=True,
                    action_url=f"/dashboard/dialogs?lead={lead.amocrm_lead_id}",
                    source_type="deal",
                    source_id=str(lead.amocrm_lead_id),
                )
            except Exception as exc:
                log_action(db, lead.id, "crm.route_nonstandard", "error", {"message": combined_text}, error=exc)
            _mark_buffers_processed(db, buffers)
            log_action(
                db,
                lead.id,
                "pipeline.non_sales_routed",
                "skipped",
                {"reason": intent.get("reason"), "message": combined_text},
            )
            return

        # Purchase intent — client definitely wants to buy a product:
        # no AI reply, straight to the manager + dedicated amoCRM stage
        if intent.get("is_purchase") and (settings.human_approval_enabled or settings.reply_hours_enabled):
            if _manager_took_over(db, lead, buffers):
                return
            move_lead_status(db, lead, settings.amocrm_status_purchase, "purchase_intent")
            stage = _lead_stage_snapshot(db, lead)
            repeat_count = _count_repeat_leads(db, lead)
            extra_managers = _load_extra_manager_ids(db)
            _templates_exist = bool(_load_templates(db))
            purchase_template, _tpl_usage = generate_purchase_template(dialogue, combined_text)
            if _tpl_usage:
                save_ai_usage(db, lead.id, _tpl_usage)
            approval = ApprovalRequest(
                lead_id=lead.id,
                chat_id=lead.chat_id or "",
                client_message=combined_text,
                ai_reply="",
                status="pending",
                extracted_fields={"_purchase_intent": True, "_purchase_template": purchase_template},
                amocrm_pipeline_id=stage.get("pipeline_id"),
                amocrm_status_id=stage.get("status_id"),
                amocrm_stage_name=stage.get("stage_name"),
            )
            db.add(approval)
            for item in buffers:
                item.processed = True
            db.commit()
            if _approval_uses_telegram(db, lead):
                try:
                    response = telegram.send_approval_card(
                        approval, lead, extra_chat_ids=extra_managers,
                        has_templates=_templates_exist, repeat_count=repeat_count,
                        last_message_time=_last_msg_display,
                    )
                    if response.get("_message_ids"):
                        approval.telegram_message_id = response["_message_ids"]
                    db.commit()
                except Exception as exc:
                    log_action(db, lead.id, "telegram.purchase_card", "error", error=exc)
            if not _is_test(lead):
                client_name = lead.client.name if lead.client else None
                crm_notify.notify(
                    type="sale_lead",
                    title="Клиент хочет купить",
                    body=f"{client_name or 'Клиент'} · заявка №{approval.id:07d}",
                    is_important=True,
                )
            log_action(db, lead.id, "pipeline.purchase_intent", "success", {"message": combined_text})
            return

        # Stop words check — send flagged card without AI reply
        stop_word = _check_stop_words(db, combined_text)
        if stop_word and (settings.human_approval_enabled or settings.reply_hours_enabled):
            if _manager_took_over(db, lead, buffers):
                return
            stage = _lead_stage_snapshot(db, lead)
            repeat_count = _count_repeat_leads(db, lead)
            extra_managers = _load_extra_manager_ids(db)
            _templates_exist = bool(_load_templates(db))
            approval = ApprovalRequest(
                lead_id=lead.id,
                chat_id=lead.chat_id or "",
                client_message=combined_text,
                ai_reply="",
                status="pending",
                extracted_fields={"_stop_word": stop_word},
                amocrm_pipeline_id=stage.get("pipeline_id"),
                amocrm_status_id=stage.get("status_id"),
                amocrm_stage_name=stage.get("stage_name"),
            )
            db.add(approval)
            for item in buffers:
                item.processed = True
            db.commit()
            if _approval_uses_telegram(db, lead):
                try:
                    response = telegram.send_approval_card(
                        approval, lead, extra_chat_ids=extra_managers,
                        has_templates=_templates_exist, repeat_count=repeat_count,
                        last_message_time=_last_msg_display,
                    )
                    if response.get("_message_ids"):
                        approval.telegram_message_id = response["_message_ids"]
                    db.commit()
                except Exception as exc:
                    log_action(db, lead.id, "telegram.stop_word_card", "error", error=exc)
            return

        move_lead_status(db, lead, settings.amocrm_status_primary_contact, "sales_message")

        slot_context = check_consultation_slots(db)
        log_action(
            db,
            lead.id,
            "consultation_slots.check",
            "success",
            response={
                "date": slot_context.get("requested_date"),
                "free_slots": len(slot_context.get("free_slots") or []),
                "local_booked": slot_context.get("local_booked", 0),
                "sheet_booked": slot_context.get("sheet_booked", 0),
            },
        )
        _now_bk = datetime.now(ZoneInfo(settings.timezone))
        slot_context["now_bishkek"] = _now_bk.strftime("%H:%M")
        slot_context["date_bishkek"] = _now_bk.strftime("%d.%m.%Y")
        slot_context["is_working_hours"] = _reply_hours().requires_human_approval
        slot_context["client_language"] = detect_language(strip_voice_marker(combined_text))

        # Minutes since previous client message (for greeting logic)
        _prev_user_msgs = [m for m in all_messages if m.role == "user" and m.created_at]
        if _prev_user_msgs:
            _prev_last_bk = _prev_user_msgs[-1].created_at.astimezone(ZoneInfo(settings.timezone))
            _minutes_since = int((_now_bk - _prev_last_bk).total_seconds() / 60)
        else:
            _minutes_since = 9999
        slot_context["minutes_since_last_message"] = _minutes_since
        custom_prompt = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt"))
        bot_memory = db.scalar(select(Setting).where(Setting.key == "bot_memory"))
        _is_complex = bool(intent.get("is_complex", True))
        _model_key = "bot_model_sales" if _is_complex else "bot_model_simple"
        _model_setting = db.scalar(select(Setting).where(Setting.key == _model_key))
        try:
            if plus_request:
                reply_result = AIResult(
                    content=PLUS_WELCOME_REPLY,
                    model="deterministic",
                    purpose="sales_agent",
                    reasoning="Плюс считается обычным запросом клиента узнать подробнее.",
                )
            else:
                reply_result = generate_reply(
                    dialogue,
                    slot_context,
                    system_prompt=custom_prompt.value if custom_prompt else None,
                    memory_context=bot_memory.value if bot_memory else None,
                    use_sales_model=_is_complex,
                    model_override=_model_setting.value if _model_setting and _model_setting.value else None,
                )
        except Exception as exc:
            _notify_openai_quota_once(db, exc)
            if _manager_took_over(db, lead, buffers):
                return
            stage = _lead_stage_snapshot(db, lead)
            extra_managers = _load_extra_manager_ids(db)
            approval = ApprovalRequest(
                lead_id=lead.id,
                chat_id=lead.chat_id or "",
                client_message=combined_text,
                ai_reply="",
                status="pending",
                extracted_fields={"_ai_error": str(exc)[:500]},
                amocrm_pipeline_id=stage.get("pipeline_id"),
                amocrm_status_id=stage.get("status_id"),
                amocrm_stage_name=stage.get("stage_name"),
                ai_reasoning="AI не смог сгенерировать ответ. Менеджеру нужно написать текст вручную.",
            )
            db.add(approval)
            for item in buffers:
                item.processed = True
            db.commit()
            if _approval_uses_telegram(db, lead):
                try:
                    response = telegram.send_approval_card(
                        approval,
                        lead,
                        messages_count=len(dialogue),
                        extra_chat_ids=extra_managers,
                        last_message_time=_last_msg_display,
                        repeat_count=_count_repeat_leads(db, lead),
                        has_templates=bool(_load_templates(db)),
                    )
                    message_ids_json = response.get("_message_ids")
                    if message_ids_json:
                        approval.telegram_message_id = message_ids_json
                    log_action(db, lead.id, "telegram.approval_request", "success", response=response)
                except Exception as telegram_exc:
                    log_action(db, lead.id, "telegram.approval_request", "error", error=telegram_exc)
            log_action(db, lead.id, "openai.sales_agent", "error", request={"latest_message": combined_text}, error=exc)
            db.commit()
            return
        reply = str(reply_result.content)
        reply_reasoning = reply_result.reasoning
        if reply_result.model != "deterministic":
            save_ai_usage(db, lead.id, reply_result)
        # Self-check pass: fix repeats, extra questions, premature consult offers
        reply, _check_usage = (reply, None) if plus_request else verify_reply(
            dialogue, reply,
            slot_context=slot_context,
            business_instructions="\n\n".join(value for value in (
                custom_prompt.value if custom_prompt else None,
                bot_memory.value if bot_memory else None,
            ) if value),
        )
        if _check_usage:
            save_ai_usage(db, lead.id, _check_usage)
        log_action(
            db,
            lead.id,
            "openai.sales_agent",
            "success",
            request={"dialogue_messages": len(dialogue), "slot_context": slot_context},
            response=reply_result.model_dump(exclude={"content"}),
        )

        updated_dialogue = dialogue + [{"role": "assistant", "content": reply}]
        extracted_result = extract_fields(updated_dialogue, lead.client.name if lead.client else None)
        extracted = dict(extracted_result.content)
        save_ai_usage(db, lead.id, extracted_result)
        _legacy_cols = {
            "skin_problem", "age", "consultation_format", "city", "experience",
            "consultation_confirmed", "consultation_date", "consultation_time",
            "name", "contacts",
        }
        db.add(AIExtractedFields(
            lead_id=lead.id, raw_output=extracted,
            **{k: v for k, v in extracted.items() if k in _legacy_cols},
        ))
        db.commit()
        extracted = merge_client_memory(db, lead, extracted, all_messages)
        log_action(
            db,
            lead.id,
            "openai.extract_fields",
            "success",
            response={"fields": extracted, "usage": extracted_result.model_dump(exclude={"content"})},
        )

        # TODO(bot_mode=autonomous): when the "autonomous" bot mode is fully specified,
        # this is where a real implementation would skip the human approval queue
        # entirely and auto-send `reply` straight to the client. Deliberately NOT
        # implemented yet — doing so without an explicit go-ahead risks silently
        # auto-messaging real customers with no human in the loop. For now
        # "autonomous" is only a storable bot_mode value (see /admin/bot-mode).
        if settings.human_approval_enabled or settings.reply_hours_enabled:
            if _manager_took_over(db, lead, buffers):
                return
            stage = _lead_stage_snapshot(db, lead)
            repeat_count = _count_repeat_leads(db, lead)
            _user_msgs = [m for m in full_dialogue if m.get("role") == "user"]
            conv_summary, hypervisor_usage = summarize_dialogue(full_dialogue) if len(_user_msgs) > 1 else ("", None)
            if hypervisor_usage:
                save_ai_usage(db, lead.id, hypervisor_usage)
            translations = detect_and_translate(combined_text, reply)
            if _manager_took_over(db, lead, buffers):
                return
            extra_managers = _load_extra_manager_ids(db)
            approval = ApprovalRequest(
                lead_id=lead.id,
                chat_id=lead.chat_id or "",
                client_message=combined_text,
                ai_reply=reply,
                status="pending",
                extracted_fields=extracted,
                amocrm_pipeline_id=stage.get("pipeline_id"),
                amocrm_status_id=stage.get("status_id"),
                amocrm_stage_name=stage.get("stage_name"),
                conversation_summary=conv_summary or None,
                client_message_translation=translations["client_translation"],
                ai_reply_translation=translations["ai_reply_translation"],
                ai_reasoning=reply_reasoning,
            )
            db.add(approval)
            for item in buffers:
                item.processed = True
            db.commit()
            if _approval_uses_telegram(db, lead):
                try:
                    _templates_exist = bool(_load_templates(db))
                    response = telegram.send_approval_card(
                        approval, lead, messages_count=len(dialogue),
                        extra_chat_ids=extra_managers, last_message_time=_last_msg_display,
                        repeat_count=repeat_count,
                        has_templates=_templates_exist,
                    )
                    message_ids_json = response.get("_message_ids")
                    if message_ids_json:
                        approval.telegram_message_id = message_ids_json
                    log_action(db, lead.id, "telegram.approval_request", "success", response=response)
                except Exception as exc:
                    log_action(db, lead.id, "telegram.approval_request", "error", error=exc)
            db.commit()
            return

        _mark_buffers_processed(db, buffers)
        send_approved_reply(db, lead, conversation_id, triggering_message_id, reply, extracted)
    except pipeline_fence.StalePipelineFence:
        db.rollback()
        # A successor owns recovery; this worker must not write a marker or send.
        return
    except Exception:
        db.rollback()
        # Keep failed utility/model work discoverable after Celery retries end.
        # Never replay buffers already consumed by a committed approval/send.
        if settings.reply_hours_enabled and db.scalar(select(MessageBuffer.id).where(
            MessageBuffer.lead_id == lead_pk, MessageBuffer.processed.is_(False),
        ).limit(1)):
            marker_key = f"night_resume:{lead_pk}"
            if not db.scalar(select(Setting).where(Setting.key == marker_key)):
                db.add(Setting(key=marker_key, value=str(lead_pk), is_secret=False))
                try:
                    db.commit()
                except IntegrityError:
                    db.rollback()
        raise
    finally:
        pipeline_fence.remove(db, fence_guard)
        try:
            db.close()
        finally:
            if lock_connection is not None:
                lock_connection.close()


def send_approved_reply(
    db,
    lead: Lead,
    conversation_id: int,
    triggering_message_id: str,
    reply: str,
    extracted: dict | None,
    approval: ApprovalRequest | None = None,
) -> bool:
    try:
        assistant_message = outbox.reserve(db, lead.id, conversation_id,
            triggering_message_id, reply, approval.id if approval else None, extracted)
        db.commit()
    except (IntegrityError, ValueError):
        db.rollback()
        return False
    if outbox.complete(assistant_message):
        if approval and approval.status == "approved":
            approval.status = "sent"
            db.commit()
        return True
    if not outbox.claim(db, assistant_message):
        return False
    # Use the immutable approved snapshot, never a fresh caller-supplied reply.
    reply_parts = assistant_message.raw_payload["outbox"]["parts"]
    stored_reply = assistant_message.text

    # Тестовый лид: ответ уже лежит в messages, значит и лаборатория, и история
    # чата его покажут. В amoCRM он не уходит — этого клиента там не существует.
    if _is_test(lead):
        assistant_message.status = "sent"
        if approval:
            approval.status = "sent"
        log_action(
            db,
            lead.id,
            "amocrm.send_message",
            "dry_run",
            {"text": stored_reply, "parts": len(reply_parts)},
        )
        db.commit()
        outbox.checkpoint(db, assistant_message, "completed")
        if extracted:
            update_integrations_after_approval(db, lead, extracted)
        return True

    if _is_green_whatsapp_lead(lead):
        try:
            responses = []
            for index, part in enumerate(reply_parts):
                if index:
                    time.sleep(message_delay_seconds(part))
                outbox.checkpoint(db, assistant_message, "sending", active_part=index)
                responses.append(_send_green_whatsapp_message(lead.chat_id or "", part))
                # Persist each provider id before the next delay, so an early
                # delivery webhook can already find this message.
                db.refresh(assistant_message, with_for_update=True)
                if assistant_message.status not in {"sent", "delivered", "read", "failed"}:
                    assistant_message.status = "queued"
                assistant_message.raw_payload = {**(assistant_message.raw_payload or {}), "provider": "green_api", "green_expected_parts": len(reply_parts), "green_message_ids": [item["messageId"] for item in responses]}
                db.commit()
            outbox.checkpoint(db, assistant_message, "completed", active_part=None)
            if approval:
                approval.status = "sent"
            log_action(
                db,
                lead.id,
                "green_api.send_message",
                "success",
                {"text": stored_reply, "parts": len(reply_parts)},
                {"responses": responses},
            )
            db.commit()
            return True
        except Exception:
            db.rollback()
            outbox.checkpoint(db, assistant_message, "uncertain")
            assistant_message.status = "send_failed"
            if approval:
                approval.status = "failed"
            log_action(
                db,
                lead.id,
                "green_api.send_message",
                "error",
                {"text": stored_reply, "parts": len(reply_parts)},
                error="Transport outcome unknown; reconciliation required",
            )
            db.commit()
            return False

    if _is_instagram_meta_lead(lead):
        try:
            responses = []
            for index, part in enumerate(reply_parts):
                if index:
                    time.sleep(message_delay_seconds(part))
                outbox.checkpoint(db, assistant_message, "sending", active_part=index)
                responses.append(crm_notify.send_channel_message("instagram", lead.chat_id or "", part))
            outbox.checkpoint(db, assistant_message, "completed", active_part=None)
            assistant_message.status = "sent"
            if approval:
                approval.status = "sent"
            log_action(
                db,
                lead.id,
                "instagram.send_message",
                "success",
                {"parts": len(reply_parts)},
                {"responses": responses},
            )
            db.commit()
            return True
        except Exception:
            db.rollback()
            outbox.checkpoint(db, assistant_message, "uncertain")
            assistant_message.status = "send_failed"
            if approval:
                approval.status = "failed"
            log_action(
                db,
                lead.id,
                "instagram.send_message",
                "error",
                {"parts": len(reply_parts)},
                error="Transport outcome unknown; reconciliation required",
            )
            db.commit()
            return False

    try:
        session = amocrm.create_chat_session()
        responses = []
        for index, part in enumerate(reply_parts):
            if index:
                time.sleep(message_delay_seconds(part))
            outbox.checkpoint(db, assistant_message, "sending", active_part=index)
            responses.append(
                amocrm.send_chat_message(
                    session,
                    lead.chat_id or "",
                    lead.amocrm_lead_id,
                    lead.contact_id,
                    part,
                )
            )
        outbox.checkpoint(db, assistant_message, "completed", active_part=None)
        assistant_message.status = "sent"
        if approval:
            approval.status = "sent"
        log_action(
            db,
            lead.id,
            "amocrm.send_message",
            "success",
            {"text": stored_reply, "parts": len(reply_parts)},
            {"responses": responses},
        )
    except Exception:
        db.rollback()
        outbox.checkpoint(db, assistant_message, "uncertain")
        assistant_message.status = "send_failed"
        if approval:
            approval.status = "failed"
        log_action(
            db,
            lead.id,
            "amocrm.send_message",
            "error",
            {"text": stored_reply, "parts": len(reply_parts)},
            error="Transport outcome unknown; reconciliation required",
        )
        db.commit()
        return False
    db.commit()

    if extracted:
        update_integrations_after_approval(db, lead, extracted)
    return True


@celery_app.task(name="resume_outgoing")
def resume_outgoing() -> None:
    """Recover committed, never-started sends. Sending/uncertain require review."""
    with SessionLocal() as db:
        ids = db.scalars(select(Message.id).where(
            Message.direction == "outgoing", Message.status == "pending_dispatch",
        ).order_by(Message.id).limit(100)).all()
        approvals = db.scalars(select(ApprovalRequest.id).where(
            ApprovalRequest.status == "approved",
        ).order_by(ApprovalRequest.id).limit(100)).all()
        for approval_id in approvals:
            message_id = db.scalar(select(Message.id).where(Message.message_id == f"ai:{approval_id}"))
            if message_id is not None and message_id not in ids:
                ids.append(message_id)
    for identifier in ids:
        with SessionLocal() as db:
            try:
                message = db.get(Message, identifier)
                raw = (message.raw_payload or {}).get("outbox") or {}
                if raw.get("state") not in {"ready", "completed"}:
                    continue
                if raw.get("state") == "ready" and message.message_id.startswith("ai:night:"):
                    decision = _reply_hours()
                    if decision.requires_human_approval or message.message_id.rsplit(":", 1)[-1] != decision.night_key:
                        outbox.checkpoint(db, message, "cancelled", reason="night_window_expired")
                        message.status = "cancelled"
                        db.commit()
                        continue
                lead = db.get(Lead, message.lead_id)
                approval = db.get(ApprovalRequest, raw["approval_id"]) if raw.get("approval_id") else None
                if not lead or (approval and approval.status != "approved"):
                    continue
                ok = send_approved_reply(db, lead, message.conversation_id,
                    message.message_id.removeprefix("ai:"), message.text,
                    raw.get("extracted"), approval)
                if ok and approval:
                    approval.status = "sent"
                    db.commit()
                    clear_claim(db, approval.id)
                    move_lead_status(db, lead, settings.amocrm_status_on_approve, "approval_accepted")
                    save_training_example(db, approval)
                    _update_card_or_notify(approval, lead, "✅ Отправлено",
                        _load_manager_name(db, approval.manager_telegram_id or ""))
            except Exception:
                db.rollback()
                _log.error("Outbox recovery failed for message row %s", identifier)


def update_integrations_after_approval(db, lead: Lead, extracted: dict) -> None:
    # Тестовый лид: показываем в терминале, что бот записал бы в карточку и
    # в таблицу, но ни одного внешнего вызова не делаем. Этап двигаем — он
    # хранится у нас в leads.status_id, наружу move_lead_status тоже не пойдёт.
    if _is_test(lead):
        log_action(db, lead.id, "amocrm.patch_lead", "dry_run", extracted)
        if extracted.get("consultation_confirmed") and extracted.get("consultation_date"):
            log_action(db, lead.id, "google_sheets.update_consultation", "dry_run", extracted)
        apply_sales_stage_from_extracted(db, lead, extracted)
        return

    if settings.amocrm_access_token:
        try:
            fields = amocrm.get_lead_fields()
            patch = amocrm.build_lead_patch(lead.amocrm_lead_id, extracted, fields)
            if patch:
                response = amocrm.patch_lead(patch)
                log_action(db, lead.id, "amocrm.patch_lead", "success", patch, response)
            else:
                log_action(db, lead.id, "amocrm.patch_lead", "skipped", extracted, {"reason": "no fields"})
        except Exception as exc:
            log_action(db, lead.id, "amocrm.patch_lead", "error", extracted, error=exc)

    if extracted.get("consultation_confirmed") and extracted.get("consultation_date") and extracted.get("consultation_time"):
        try:
            _reserve_consultation_slot(db, lead, extracted)
            response = google_sheets.update_consultation_sheet(
                extracted, lead.amocrm_lead_id, chat_id=lead.chat_id or ""
            )
            log_action(db, lead.id, "google_sheets.update_consultation", "success", extracted, response)
            crm_response = crm_notify.sync_consultation({
                "lead_id": int(lead.amocrm_lead_id),
                "date": extracted["consultation_date"],
                "time": extracted["consultation_time"],
                "name": extracted.get("name") or (lead.client.name if lead.client else None) or f"Клиент #{lead.amocrm_lead_id}",
                "phone": extracted.get("contacts") or (lead.client.phone if lead.client else None),
                "format": extracted.get("consultation_format"),
                "comment": (str(extracted.get("goal") or extracted.get("skin_problem") or extracted.get("last_action") or "")[:2000] or None),
            })
            log_action(db, lead.id, "crm.sync_consultation", "success", extracted, crm_response)
        except Exception as exc:
            log_action(db, lead.id, "google_sheets.update_consultation", "error", extracted, error=exc)

    apply_sales_stage_from_extracted(db, lead, extracted)


def _load_manager_name(db, manager_id: str) -> str:
    try:
        row = db.scalar(select(Setting).where(Setting.key == "telegram_managers"))
        if not row or not row.value:
            return f"Telegram ID {manager_id}"
        for m in json.loads(row.value):
            if str(m.get("chat_id", "")) == manager_id:
                return m.get("name") or f"Telegram ID {manager_id}"
    except Exception:
        pass
    return f"Telegram ID {manager_id}"


SESSION_TTL_SECONDS = 30 * 60


def _session_value(setting) -> str | None:
    if not setting:
        return None
    try:
        envelope = json.loads(setting.value)
    except (ValueError, TypeError):
        envelope = None
    if isinstance(envelope, dict) and "expires_at" in envelope and "value" in envelope:
        if datetime.now(ZoneInfo("UTC")).timestamp() >= envelope["expires_at"]:
            return None
        return envelope["value"]
    # Legacy sessions have no envelope: bound their lifetime using updated_at.
    updated = setting.updated_at
    if updated and (datetime.now(ZoneInfo("UTC")) - updated.replace(tzinfo=updated.tzinfo or ZoneInfo("UTC"))).total_seconds() >= SESSION_TTL_SECONDS:
        return None
    return setting.value


def _get_session(db, key: str) -> str | None:
    return _session_value(db.scalar(select(Setting).where(Setting.key == key)))


def _set_session(db, key: str, value: str) -> None:
    actions = ("edit", "ai_edit", "note", "purchase_answer", "purchase_edit", "reject_reason", "translate")
    prefix, _, actor = key.rpartition(":")
    if prefix in {f"telegram_{action}_session" for action in actions}:
        db.execute(delete(Setting).where(Setting.key.in_([
            f"telegram_{action}_session:{actor}" for action in actions
            if prefix != f"telegram_{action}_session"
        ])))
    envelope = json.dumps({"value": value,
        "expires_at": datetime.now(ZoneInfo("UTC")).timestamp() + SESSION_TTL_SECONDS})
    changed = db.execute(update(Setting).where(Setting.key == key).values(value=envelope))
    if not changed.rowcount:
        db.add(Setting(key=key, value=envelope, is_secret=False))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        db.execute(update(Setting).where(Setting.key == key).values(value=envelope))
        db.commit()


def _pop_session(db, key: str) -> str | None:
    # DELETE RETURNING makes consuming a session atomic across workers.
    row = db.execute(delete(Setting).where(Setting.key == key).returning(
        Setting.value, Setting.updated_at)).first()
    value = _session_value(row)
    db.commit()
    return value


def set_edit_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_edit_session:{manager_id}", str(approval_id))


def pop_edit_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_edit_session:{manager_id}")
    return int(value) if value else None


def set_ai_edit_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_ai_edit_session:{manager_id}", str(approval_id))


def pop_ai_edit_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_ai_edit_session:{manager_id}")
    return int(value) if value else None


def set_edit_prompt_msg(db, manager_id: str, message_id: int) -> None:
    _set_session(db, f"telegram_edit_prompt_msg:{manager_id}", str(message_id))


def pop_edit_prompt_msg(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_edit_prompt_msg:{manager_id}")
    return int(value) if value else None


def set_note_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_note_session:{manager_id}", str(approval_id))


def pop_note_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_note_session:{manager_id}")
    return int(value) if value else None


def set_purchase_answer_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_purchase_answer_session:{manager_id}", str(approval_id))


def pop_purchase_answer_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_purchase_answer_session:{manager_id}")
    return int(value) if value else None


def set_purchase_edit_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_purchase_edit_session:{manager_id}", str(approval_id))


def pop_purchase_edit_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_purchase_edit_session:{manager_id}")
    return int(value) if value else None


def set_reject_reason_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_reject_reason_session:{manager_id}", str(approval_id))


def pop_reject_reason_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_reject_reason_session:{manager_id}")
    return int(value) if value else None


def set_translate_session(db, manager_id: str, approval_id: int) -> None:
    _set_session(db, f"telegram_translate_session:{manager_id}", str(approval_id))


def pop_translate_session(db, manager_id: str) -> int | None:
    value = _pop_session(db, f"telegram_translate_session:{manager_id}")
    return int(value) if value else None


def set_claim(db, approval_id: int, manager_id: str, manager_name: str = "") -> None:
    payload = json.dumps({"id": manager_id, "name": manager_name})
    _set_session(db, f"claimed:{approval_id}", payload)


def get_claim(db, approval_id: int) -> tuple[str, str] | None:
    value = _get_session(db, f"claimed:{approval_id}")
    if not value:
        return None
    try:
        data = json.loads(value)
        return data.get("id", ""), data.get("name", "")
    except (json.JSONDecodeError, TypeError):
        return value, ""


def clear_claim(db, approval_id: int) -> None:
    _pop_session(db, f"claimed:{approval_id}")


def apply_ai_edited_reply(db, approval_id: int, manager_id: str, edit_prompt: str) -> ApprovalRequest | None:
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {"pending", "edited"}:
        return None
    lead = db.get(Lead, approval.lead_id)
    snapshot = approval.edited_reply
    original = approval.edited_reply or approval.ai_reply
    result = ai_edit_reply(original, approval.client_message, edit_prompt)
    new_reply = str(result.content)
    save_ai_usage(db, approval.lead_id, result)
    changed = db.execute(update(ApprovalRequest).where(
        ApprovalRequest.id == approval_id, ApprovalRequest.status.in_(("pending", "edited")),
        ApprovalRequest.edited_reply == snapshot,
    ).values(edited_reply=new_reply, status="edited", manager_telegram_id=manager_id))
    if changed.rowcount != 1:
        db.rollback()
        return None
    db.commit()
    db.refresh(approval)
    if lead:
        move_lead_status(db, lead, settings.amocrm_status_on_edit, "approval_ai_edited")
    log_action(
        db,
        approval.lead_id,
        "telegram.approval_ai_edited",
        "success",
        {"approval_id": approval_id, "edit_prompt": edit_prompt, "new_reply": new_reply, "actor_id": manager_id},
    )
    return approval


def _update_card_or_notify(
    approval: ApprovalRequest,
    lead: Lead,
    decision: str,
    manager_name: str = "",
    retry: bool = False,
) -> None:
    try:
        decision_display = f"{decision} · {manager_name}" if manager_name else decision
        if approval.telegram_message_id:
            telegram.edit_approval_card(approval, lead, decision=decision_display, retry=retry)
        else:
            telegram.send_text(
                settings.telegram_manager_chat_id,
                f"{decision_display} — Lead {lead.amocrm_lead_id}",
            )
    except Exception:
        pass


def approve_request(db, approval_id: int, manager_id: str, *,
    expected_reply: str | None = None, check_snapshot: bool = False) -> bool:
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {"pending", "edited"}:
        return False
    lead = db.get(Lead, approval.lead_id)
    if not lead:
        return False

    # Purchase-intent cards hold a fill-in template, not a real reply. Approving one
    # before a manager edited it would send the placeholder to the client verbatim.
    is_purchase = bool((approval.extracted_fields or {}).get("_purchase_intent"))
    if is_purchase and not approval.edited_reply:
        _log.warning("approve blocked: purchase approval %s has no edited reply", approval_id)
        return False

    latest_user_message = db.scalar(
        select(Message)
        .where(Message.lead_id == lead.id, Message.role == "user")
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    if not latest_user_message or not split_outgoing_messages(approval.edited_reply if approval.edited_reply is not None else approval.ai_reply):
        return False

    claim = update(ApprovalRequest).where(
        ApprovalRequest.id == approval_id,
        ApprovalRequest.status.in_(("pending", "edited")),
    )
    if check_snapshot:
        claim = claim.where(ApprovalRequest.edited_reply == expected_reply)
    claimed = db.execute(claim.values(status="approved", manager_telegram_id=manager_id,
             approved_at=datetime.now(ZoneInfo(settings.timezone))))
    if claimed.rowcount != 1:
        db.rollback()
        return False
    db.refresh(approval)
    try:
        db.add(ActionLog(lead_id=lead.id, action="telegram.approval_approved", status="success",
            request_payload={"approval_id": approval_id, "actor_id": manager_id,
                "actor_name": _load_manager_name(db, manager_id), "to_status": "approved"}))
        outbox.reserve(db, lead.id, latest_user_message.conversation_id, str(approval.id),
            approval.edited_reply if approval.edited_reply is not None else approval.ai_reply,
            approval.id, approval.extracted_fields)
        db.commit()
    except (IntegrityError, ValueError):
        db.rollback()
        return False
    db.refresh(approval)
    clear_claim(db, approval_id)
    db.commit()

    ok = send_approved_reply(
        db,
        lead,
        latest_user_message.conversation_id,
        str(approval.id),
        approval.edited_reply or approval.ai_reply,
        approval.extracted_fields,
        approval,
    )
    manager_name = _load_manager_name(db, manager_id)
    if not ok:
        _update_card_or_notify(approval, lead,
            "⏳ Отправка обрабатывается" if approval.status == "approved" else "⚠️ Статус отправки требует проверки; повтор заблокирован",
            manager_name, retry=False)
        return False

    move_lead_status(db, lead, settings.amocrm_status_on_approve, "approval_accepted")
    save_training_example(db, approval)
    _update_card_or_notify(approval, lead, "✅ Отправлено", manager_name)
    return True


def save_training_example(db, approval: ApprovalRequest) -> None:
    # Foreground and recovery workers may finalize the same accepted send.
    # Serialize the check/insert without adding a production schema migration.
    db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.id == approval.id).with_for_update())
    existing = db.scalar(
        select(TrainingExample).where(TrainingExample.approval_request_id == approval.id)
    )
    if existing:
        return
    final_reply = approval.edited_reply or approval.ai_reply
    db.add(
        TrainingExample(
            approval_request_id=approval.id,
            lead_id=approval.lead_id,
            client_message=approval.client_message,
            ai_reply=approval.ai_reply,
            final_reply=final_reply,
            was_edited=bool(approval.edited_reply),
            manager_telegram_id=approval.manager_telegram_id,
            amocrm_stage_name=approval.amocrm_stage_name,
            extracted_fields=approval.extracted_fields,
            quality_label="accepted",
        )
    )
    db.commit()
    log_action(
        db,
        approval.lead_id,
        "training.example_saved",
        "success",
        {
            "approval_id": approval.id,
            "was_edited": bool(approval.edited_reply),
            "quality_label": "accepted",
        },
    )


def reject_request(db, approval_id: int, manager_id: str, reason: str) -> bool:
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {"pending", "edited"}:
        return False
    changed = db.execute(update(ApprovalRequest).where(
        ApprovalRequest.id == approval_id, ApprovalRequest.status.in_(("pending", "edited")),
    ).values(status="rejected", manager_telegram_id=manager_id, reject_reason=reason))
    if changed.rowcount != 1:
        db.rollback()
        return False
    db.commit()
    db.refresh(approval)
    clear_claim(db, approval_id)
    db.commit()
    lead = db.get(Lead, approval.lead_id)
    if lead:
        move_lead_status(db, lead, settings.amocrm_status_on_reject, "approval_rejected")
        _update_card_or_notify(approval, lead, "❌ Отклонено", _load_manager_name(db, manager_id))
    save_rejected_training_example(db, approval, reason)
    log_action(db, approval.lead_id, "telegram.approval_rejected", "success", {"approval_id": approval_id, "reject_reason": reason, "actor_id": manager_id})
    _maybe_calibrate_prompt(db, approval, reason)
    return True


def save_rejected_training_example(db, approval: ApprovalRequest, reason: str) -> None:
    # Foreground and recovery workers may finalize the same accepted send.
    # Serialize the check/insert without adding a production schema migration.
    db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.id == approval.id).with_for_update())
    existing = db.scalar(
        select(TrainingExample).where(TrainingExample.approval_request_id == approval.id)
    )
    if existing:
        return
    db.add(
        TrainingExample(
            approval_request_id=approval.id,
            lead_id=approval.lead_id,
            client_message=approval.client_message,
            ai_reply=approval.ai_reply,
            # final_reply is the reason, not a corrected reply — nothing was sent to
            # the client, so there is no "final" text; the reason is what carries
            # the learning signal here, and extracted_fields keeps a structured copy.
            final_reply=reason,
            was_edited=False,
            manager_telegram_id=approval.manager_telegram_id,
            amocrm_stage_name=approval.amocrm_stage_name,
            extracted_fields={**(approval.extracted_fields or {}), "reject_reason": reason},
            quality_label="rejected",
        )
    )
    db.commit()
    log_action(
        db,
        approval.lead_id,
        "training.example_saved",
        "success",
        {"approval_id": approval.id, "quality_label": "rejected", "reject_reason": reason},
    )


def _maybe_calibrate_prompt(db, approval: ApprovalRequest, reason: str) -> None:
    """Aggressive mode only: auto-patch the live system prompt after this single reject.

    Deliberately conservative — this runs unattended after every reject, so a
    calibration failure must never break the reject flow, and the patch itself
    must stay small (see calibrate_prompt_from_single_reject's own prompt).
    """
    mode = db.scalar(select(Setting).where(Setting.key == "bot_mode"))
    if not mode or mode.value != "aggressive":
        return
    try:
        from app.services.openai_service import calibrate_prompt_from_single_reject
        from app.services.prompts import SALES_AGENT_SYSTEM_PROMPT

        prompt_row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt"))
        current_prompt = prompt_row.value if prompt_row else SALES_AGENT_SYSTEM_PROMPT
        result = calibrate_prompt_from_single_reject(
            approval.client_message, approval.ai_reply, reason, current_prompt
        )
        data = result.content if isinstance(result.content, dict) else {}
        patch = (data.get("prompt_patch") or "").strip()
        reasoning = data.get("reasoning") or ""
        save_ai_usage(db, approval.lead_id, result)
        if not patch:
            return
        new_prompt = f"{current_prompt}\n\n{patch}"
        if prompt_row:
            prompt_row.value = new_prompt
        else:
            db.add(Setting(key="bot_system_prompt", value=new_prompt, is_secret=False))

        history_row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt_history"))
        history = json.loads(history_row.value) if history_row and history_row.value else []
        history.append({
            "at": datetime.now(ZoneInfo(settings.timezone)).isoformat(),
            "approval_id": approval.id,
            "patch": patch,
            "reasoning": reasoning,
        })
        history = history[-200:]
        if history_row:
            history_row.value = json.dumps(history, ensure_ascii=False)
        else:
            db.add(Setting(key="bot_system_prompt_history", value=json.dumps(history, ensure_ascii=False), is_secret=False))
        db.commit()
        log_action(
            db, approval.lead_id, "pipeline.prompt_auto_calibrated", "success",
            {"approval_id": approval.id, "patch": patch, "reasoning": reasoning},
        )
    except Exception as exc:
        _log.warning("prompt auto-calibration failed for approval_id=%s: %s", approval.id, exc)


def save_request(db, approval_id: int, manager_id: str) -> bool:
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {"pending", "edited"}:
        return False
    changed = db.execute(update(ApprovalRequest).where(
        ApprovalRequest.id == approval_id, ApprovalRequest.status.in_(("pending", "edited")),
    ).values(status="saved", manager_telegram_id=manager_id))
    if changed.rowcount != 1:
        db.rollback()
        return False
    db.commit()
    db.refresh(approval)
    lead = db.get(Lead, approval.lead_id)
    if lead:
        move_lead_status(db, lead, settings.amocrm_status_on_save, "approval_saved_unsorted")
        _update_card_or_notify(approval, lead, "💾 Сохранено", _load_manager_name(db, manager_id))
    log_action(db, approval.lead_id, "telegram.approval_saved", "success", {"approval_id": approval_id, "actor_id": manager_id})
    return True


def apply_edited_reply(db, approval_id: int, manager_id: str, text: str, *,
    expected_reply: str | None = None, check_snapshot: bool = False,
    expected_ai_reply: str | None = None) -> ApprovalRequest | None:
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {"pending", "edited"}:
        return None
    query = update(ApprovalRequest).where(
        ApprovalRequest.id == approval_id, ApprovalRequest.status.in_(("pending", "edited")),
    )
    if check_snapshot:
        query = query.where(ApprovalRequest.edited_reply == expected_reply)
        if expected_ai_reply is not None:
            query = query.where(ApprovalRequest.ai_reply == expected_ai_reply)
    changed = db.execute(query.values(edited_reply=text, status="edited", manager_telegram_id=manager_id))
    if changed.rowcount != 1:
        db.rollback()
        return None
    db.commit()
    db.refresh(approval)
    lead = db.get(Lead, approval.lead_id)
    if lead:
        move_lead_status(db, lead, settings.amocrm_status_on_edit, "approval_edited")
    log_action(
        db,
        approval.lead_id,
        "telegram.approval_edited",
        "success",
        {"approval_id": approval_id, "edited_reply": text, "actor_id": manager_id},
    )
    return approval
