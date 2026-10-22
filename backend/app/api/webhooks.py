import json as _json
import logging
import secrets
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import desc, select, update as sql_update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.entities import ApprovalRequest, ConsultationReminder, Lead, Setting
from app.schemas.amocrm import parse_amocrm_webhook
from app.services import amocrm, crm_notify, telegram
from app.services.openai_service import transcribe_voice
from app.services.message_policy import service_message_reason
from app.services.repository import upsert_incoming
from app.tasks.pipeline import (
    apply_ai_edited_reply,
    apply_edited_reply,
    approve_request,
    clear_claim,
    log_action,
    pop_ai_edit_session,
    pop_edit_prompt_msg,
    pop_edit_session,
    pop_note_session,
    pop_purchase_answer_session,
    pop_purchase_edit_session,
    pop_reject_reason_session,
    pop_translate_session,
    process_lead_buffer,
    reject_request,
    save_request,
    set_ai_edit_session,
    set_claim,
    set_edit_prompt_msg,
    set_edit_session,
    set_note_session,
    set_purchase_answer_session,
    set_purchase_edit_session,
    set_reject_reason_session,
    set_translate_session,
)

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _load_manager_name(db, manager_id: str) -> str:
    try:
        row = db.scalar(select(Setting).where(Setting.key == "telegram_managers"))
        if not row or not row.value:
            return manager_id
        managers = _json.loads(row.value)
        for m in managers:
            if str(m.get("chat_id", "")) == manager_id:
                return m.get("name", manager_id)
    except Exception:
        pass
    return manager_id


def _load_templates(db) -> list[dict]:
    try:
        row = db.scalar(select(Setting).where(Setting.key == "reply_templates"))
        return _json.loads(row.value) if row and row.value else []
    except Exception:
        return []


def _refresh_purchase_card(db, approval: ApprovalRequest, manager_id: str) -> None:
    """Redraw a 🛒 ХОЧЕТ КУПИТЬ card after the manager wrote the reply.

    The reply is stored but NOT sent — the refreshed card now shows «✅ Принять»,
    so the manager confirms before the client sees anything.
    """
    lead = db.get(Lead, approval.lead_id)
    if not lead:
        return
    db.refresh(approval)
    has_templates = bool(_load_templates(db))
    result = telegram.edit_approval_card(approval, lead, has_templates=has_templates)
    if result.get("skipped") or result.get("_all_failed") or result.get("error"):
        _log.error(
            "edit_approval_card failed after purchase edit approval_id=%s msg_id=%s result=%s",
            approval.id, approval.telegram_message_id, result,
        )
        telegram.send_text(
            manager_id,
            f"⚠️ Не удалось обновить карточку №{approval.id:07d}, но ответ сохранён. "
            "Нажмите «Принять» — он будет отправлен клиенту.",
        )


def _load_db_manager_ids(db) -> set[str]:
    try:
        row = db.scalar(select(Setting).where(Setting.key == "telegram_managers"))
        if not row or not row.value:
            return set()
        return {str(m["chat_id"]) for m in _json.loads(row.value) if m.get("chat_id")}
    except Exception:
        return set()


@router.post("/amocrm")
@router.post("/amocrm/{secret}")
async def amocrm_webhook(
    request: Request,
    secret: str | None = None,
    db: Session = Depends(get_db),
) -> dict:
    if settings.amocrm_webhook_secret:
        header_secret = request.headers.get("x-webhook-secret", "")
        if secret != settings.amocrm_webhook_secret and header_secret != settings.amocrm_webhook_secret:
            raise HTTPException(status_code=401, detail="invalid amocrm webhook secret")
    form = await request.form()
    body = dict(form)
    if not body:
        body = await request.json()
    incoming = parse_amocrm_webhook(body)

    # Outgoing message = the human consultant wrote directly in amoCRM.
    # Store it in the chat history as a consultant message; never run the AI pipeline.
    if incoming.direction == "outgoing":
        from app.services.repository import store_outgoing_message
        stored = store_outgoing_message(db, incoming)
        return {"ok": True, "queued": False, "reason": "outgoing_consultant", "stored": stored}

    service_reason = service_message_reason(incoming.text)
    if service_reason:
        # Never persist credentials themselves in logs. IDs are sufficient for audit.
        log_action(
            db,
            None,
            "pipeline.service_message",
            "skipped",
            {
                "reason": service_reason,
                "message_id": incoming.message_id,
                "amocrm_lead_id": incoming.lead_id,
            },
        )
        return {"ok": True, "queued": False, "reason": "service_message"}

    # Handle voice messages: transcribe with Whisper and let them through the
    # normal pipeline like any text message.
    #
    # This used to auto-reply to the client and drop the message whenever
    # Whisper's own language guess wasn't "ru"/"ky" — but that guess is
    # unreliable for Kyrgyz (a low-resource language for Whisper) and the
    # auto-reply bypassed manager approval entirely, sending a message to a
    # live client with no human in the loop. Language handling belongs to
    # detect_language() on the transcript further down the pipeline, which
    # already tells generate_reply to answer in the client's language — it
    # must never gate or auto-send here.
    #
    # The `[voice] <url>` prefix is kept in front of the transcript (same
    # convention amoCRM/telegram.py already use for `[picture] <url>`) so the
    # Telegram approval card can render a clickable "listen" link; AI calls
    # strip it back out via strip_voice_marker().
    _VOICE_TYPES = {"voice", "audio"}
    _voice_url = incoming.attachment_link or incoming.media or None
    voice_recognition_failed = False
    if incoming.attachment_type in _VOICE_TYPES and _voice_url:
        try:
            transcribed, _lang = transcribe_voice(_voice_url)
        except Exception:
            _log.exception("voice transcription failed: message_id=%s", incoming.message_id)
            transcribed = ""
        voice_recognition_failed = not bool(transcribed.strip())
        incoming.text = f"[voice] {_voice_url} {transcribed}".strip()

    lead, _conversation, is_new = upsert_incoming(db, incoming)
    if is_new and voice_recognition_failed:
        # A blank transcript must never produce an automatic apology to the
        # client. Surface it as an urgent CRM item so the responsible manager
        # (or the team when no owner has been assigned yet) can listen and act.
        crm_notify.notify(
            type="voice_recognition_failed",
            title="Не удалось распознать голосовое сообщение",
            body="Нужно прослушать голосовое клиента и ответить вручную.",
            is_important=True,
            action_url=f"/dashboard/dialogs?lead={lead.amocrm_lead_id}",
            source_type="lead",
            source_id=str(lead.amocrm_lead_id),
        )
        return {"ok": True, "queued": False, "reason": "voice_recognition_failed", "lead_id": lead.amocrm_lead_id, "message_id": incoming.message_id}
    if is_new and lead.ai_enabled:
        process_lead_buffer.apply_async(
            args=[lead.id, incoming.message_id],
            countdown=settings.message_buffer_seconds,
        )
    return {"ok": True, "queued": is_new, "lead_id": lead.amocrm_lead_id, "message_id": incoming.message_id}


@router.post("/openai")
async def openai_webhook(request: Request, db: Session = Depends(get_db)) -> dict:
    """Receive OpenAI platform webhook events (billing, batch, response, etc.).

    Logs every event to action_logs and notifies the main manager in Telegram.
    """
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    event_type = str(payload.get("type", "unknown"))
    from app.tasks.pipeline import log_action
    log_action(db, None, f"openai.webhook.{event_type}", "received", request=payload)
    if settings.telegram_manager_chat_id:
        try:
            _data = payload.get("data", {})
            telegram.send_text(
                settings.telegram_manager_chat_id,
                f"🔔 OpenAI событие: {event_type}\n{_json.dumps(_data, ensure_ascii=False)[:500]}",
            )
        except Exception:
            pass
    return {"ok": True}


@router.post("/telegram/{secret}")
async def telegram_webhook(secret: str, request: Request, db: Session = Depends(get_db)) -> dict:
    expected_secret = settings.telegram_webhook_secret
    if not expected_secret or not secrets.compare_digest(secret.encode(), expected_secret.encode()):
        raise HTTPException(status_code=401, detail="invalid telegram webhook secret")
    update = await request.json()

    if callback := update.get("callback_query"):
        callback_id = callback["id"]
        manager_id = str(callback["from"]["id"])
        callback_chat_id = str(callback.get("message", {}).get("chat", {}).get("id", ""))
        db_manager_ids = _load_db_manager_ids(db)
        if not telegram.is_authorized_manager(manager_id, callback_chat_id, extra_allowed=db_manager_ids):
            telegram.answer_callback(callback_id, "Нет доступа")
            return {"ok": False, "error": "unauthorized_manager"}
        data = callback.get("data", "")
        if ":" not in data:
            telegram.answer_callback(callback_id, "Некорректная кнопка")
            return {"ok": False, "error": "invalid_callback"}
        action, raw_id = data.split(":", 1)

        # set_stage carries two IDs: "approval_id:stage_id"
        if action == "set_stage":
            approval_id_str, stage_id_str = raw_id.split(":", 1)
            approval = db.get(ApprovalRequest, int(approval_id_str))
            lead = db.get(Lead, approval.lead_id) if approval else None
            if not lead:
                telegram.answer_callback(callback_id, "Лид не найден")
                return {"ok": False, "error": "lead_not_found"}
            # Тестового лида в amoCRM нет: кнопку мы прячем, но callback мог
            # прилететь со старой карточки, а patch по чужому id опасен.
            if telegram.is_test_lead(lead):
                telegram.answer_callback(callback_id, "Тестовый лид — этапа в amoCRM нет")
                return {"ok": False, "error": "test_lead"}
            try:
                amocrm.patch_lead_status(lead.amocrm_lead_id, int(stage_id_str))
                telegram.answer_callback(callback_id, "✅ Этап изменён")
            except Exception:
                telegram.answer_callback(callback_id, "Ошибка при смене этапа")
            return {"ok": True, "action": action}

        # reject_reason carries two IDs: "approval_id:reason_key" — parsed here,
        # before the shared int(raw_id) below, same reason set_stage is handled early.
        if action == "reject_reason":
            parts = raw_id.split(":", 1)
            if len(parts) != 2:
                telegram.answer_callback(callback_id, "Ошибка")
                return {"ok": False, "error": "invalid_callback"}
            reason_approval_id = int(parts[0])
            reason_key = parts[1]
            if reason_key == "other":
                set_reject_reason_session(db, manager_id, reason_approval_id)
                telegram.answer_callback(callback_id)
                prompt_text = f"❌ Причина отказа №{reason_approval_id:07d}\n\nНапишите, что не так с ответом."
                resp3: dict = {}
                try:
                    resp3 = telegram.send_text(manager_id, prompt_text)
                except Exception:
                    pass
                if not resp3.get("result"):
                    try:
                        resp3 = telegram.send_text(callback_chat_id, prompt_text)
                    except Exception:
                        pass
                mid = resp3.get("result", {}).get("message_id")
                if mid:
                    set_edit_prompt_msg(db, manager_id, mid)
                return {"ok": True, "action": action}
            reason = telegram.REJECT_REASON_PRESETS.get(reason_key, reason_key)
            ok = reject_request(db, reason_approval_id, manager_id, reason)
            telegram.answer_callback(callback_id, "Отклонено")
            return {"ok": ok, "action": action}

        # "waiting:list" не несёт approval_id — обрабатываем до int(raw_id) ниже.
        if action == "waiting":
            from app.tasks.reminders import collect_waiting_clients

            # Список собирается сейчас, а не в 09:00, поэтому он всегда свежий.
            contacts = collect_waiting_clients(db)
            try:
                page = 0 if raw_id == "list" else int(raw_id)
            except ValueError:
                page = 0
            text_out = telegram.waiting_clients_list(contacts, page)
            keyboard = telegram.waiting_clients_keyboard(len(contacts), page)
            # Уходит в личку нажавшему: телефоны клиентов не место в общем чате.
            try:
                telegram.send_text(manager_id, text_out, reply_markup=keyboard)
            except Exception as exc:
                _log.warning("waiting list to manager_id=%s failed: %s", manager_id, exc)
                telegram.answer_callback(callback_id, "Откройте личный чат с ботом и нажмите /start")
                return {"ok": False, "error": "dm_unavailable"}
            telegram.answer_callback(callback_id, "Отправил в личные сообщения")
            return {"ok": True, "action": action}

        approval_id = int(raw_id.split(":", 1)[0] if action == "tpl" else raw_id)
        approval = db.get(ApprovalRequest, approval_id)
        lead = db.get(Lead, approval.lead_id) if approval else None

        if action == "move_stage":
            if not approval or not lead:
                telegram.answer_callback(callback_id, "Лид не найден")
                return {"ok": False, "error": "lead_not_found"}
            if telegram.is_test_lead(lead):
                telegram.answer_callback(callback_id, "Тестовый лид — этапа в amoCRM нет")
                return {"ok": False, "error": "test_lead"}
            pipeline_id = approval.amocrm_pipeline_id
            if not pipeline_id:
                telegram.answer_callback(callback_id, "Pipeline не определён")
                return {"ok": False, "error": "no_pipeline"}
            try:
                pipeline = amocrm.get_pipeline(int(pipeline_id))
                stages = pipeline.get("_embedded", {}).get("statuses", [])
            except Exception:
                telegram.answer_callback(callback_id, "Не удалось загрузить этапы")
                return {"ok": False, "error": "pipeline_fetch_error"}
            telegram.answer_callback(callback_id)
            telegram.send_stages_menu(manager_id, stages, approval_id)
            return {"ok": True, "action": action}

        if action == "cancel_stage":
            telegram.answer_callback(callback_id, "Отменено")
            return {"ok": True, "action": action}

        if action == "approve":
            ok = approve_request(db, approval_id, manager_id)
            telegram.answer_callback(callback_id, "Отправлено" if ok else "Не удалось отправить")
            return {"ok": ok, "action": action}
        if action == "reject":
            # Every reject now needs a reason — it's the only signal reject_request()
            # has to save a TrainingExample / feed aggressive-mode auto-calibration.
            telegram.answer_callback(callback_id)
            telegram.send_reject_reason_menu(callback_chat_id or manager_id, approval_id)
            return {"ok": True, "action": action}
        if action == "save":
            ok = save_request(db, approval_id, manager_id)
            telegram.answer_callback(callback_id, "Сохранено в /no-sorted")
            return {"ok": ok, "action": action}
        if action == "tpl_list":
            templates = _load_templates(db)
            if not templates:
                telegram.answer_callback(callback_id, "Шаблонов нет. Добавьте в CRM → Настройки")
                return {"ok": True, "action": action}
            telegram.answer_callback(callback_id)
            telegram.send_templates_menu(manager_id, templates, approval_id)
            return {"ok": True, "action": action}
        if action == "tpl":
            parts = raw_id.split(":", 1)
            if len(parts) != 2:
                telegram.answer_callback(callback_id, "Ошибка")
                return {"ok": False}
            approval_id = int(parts[0])
            tpl_id = parts[1]
            approval = db.get(ApprovalRequest, approval_id)
            lead = db.get(Lead, approval.lead_id) if approval else None
            if not approval or not lead:
                telegram.answer_callback(callback_id, "Лид не найден")
                return {"ok": False}
            templates = _load_templates(db)
            tpl = next((t for t in templates if str(t.get("id")) == str(tpl_id)), None)
            if not tpl:
                telegram.answer_callback(callback_id, "Шаблон не найден")
                return {"ok": False}
            approval = apply_edited_reply(db, approval_id, manager_id, tpl["text"])
            if approval is None:
                telegram.answer_callback(callback_id, "Запрос уже обработан")
                return {"ok": False, "error": "approval_not_editable"}
            clear_claim(db, approval_id)
            has_templates = bool(templates)
            telegram.edit_approval_card(approval, lead, chat_id=callback_chat_id, has_templates=has_templates)
            telegram.answer_callback(callback_id, f"✅ Шаблон «{tpl['name']}» применён")
            return {"ok": True, "action": action}
        if action == "tpl_cancel":
            telegram.answer_callback(callback_id, "Отменено")
            return {"ok": True, "action": action}
        if action == "edit":
            set_edit_session(db, manager_id, approval_id)
            manager_name = _load_manager_name(db, manager_id)
            set_claim(db, approval_id, manager_id, manager_name)
            has_templates = bool(_load_templates(db))
            if approval and lead:
                telegram.edit_approval_card(approval, lead, claimed_by_name=manager_name, has_templates=has_templates)
            telegram.answer_callback(callback_id)
            prompt_text = f"✏️ Редакт вручную №{approval_id:07d}\n\nОтправьте новый текст ответа."
            resp2: dict = {}
            try:
                resp2 = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp2.get("result"):
                try:
                    resp2 = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp2.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "pedit":
            # Purchase card «Редактировать»: manager writes the full reply, then it is sent.
            set_purchase_edit_session(db, manager_id, approval_id)
            telegram.answer_callback(callback_id)
            prompt_text = f"✏️ Ответ клиенту №{approval_id:07d}\n\nНапишите полный текст ответа — он будет отправлен клиенту."
            resp: dict = {}
            try:
                resp = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp.get("result"):
                try:
                    resp = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "answer":
            # Purchase card «Ответить»: manager fills the {ответ пользователя} blank, then it is sent.
            set_purchase_answer_session(db, manager_id, approval_id)
            telegram.answer_callback(callback_id)
            template = (approval.extracted_fields or {}).get("_purchase_template", "") if approval else ""
            prompt_text = (
                f"💬 Ответ клиенту №{approval_id:07d}\n\n"
                f"Шаблон: {template}\n\n"
                "Напишите текст, который подставится вместо «{ответ пользователя}» — ответ будет отправлен клиенту."
            )
            resp: dict = {}
            try:
                resp = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp.get("result"):
                try:
                    resp = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "ai_edit":
            set_ai_edit_session(db, manager_id, approval_id)
            manager_name = _load_manager_name(db, manager_id)
            set_claim(db, approval_id, manager_id, manager_name)
            has_templates = bool(_load_templates(db))
            if approval and lead:
                telegram.edit_approval_card(approval, lead, claimed_by_name=manager_name, has_templates=has_templates)
            telegram.answer_callback(callback_id)
            prompt_text = f"🤖 AI редакт №{approval_id:07d}\n\nНапишите промпт — как изменить ответ?\n\nНапример: «сделай короче», «добавь про акцию», «переведи на кыргызский»"
            # Try personal chat first; fall back to the chat where button was pressed
            resp: dict = {}
            try:
                resp = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp.get("result"):
                try:
                    resp = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "note":
            set_note_session(db, manager_id, approval_id)
            telegram.answer_callback(callback_id)
            prompt_text = f"📝 Заметка №{approval_id:07d}\n\nНапишите заметку для других консультантов:"
            resp: dict = {}
            try:
                resp = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp.get("result"):
                try:
                    resp = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "translate":
            set_translate_session(db, manager_id, approval_id)
            telegram.answer_callback(callback_id)
            prompt_text = f"🌐 Перевод ответа №{approval_id:07d}\n\nНа какой язык перевести?\n\nНапример: русский, кыргызский, английский"
            resp: dict = {}
            try:
                resp = telegram.send_text(manager_id, prompt_text)
            except Exception:
                pass
            if not resp.get("result"):
                try:
                    resp = telegram.send_text(callback_chat_id, prompt_text)
                except Exception:
                    pass
            mid = resp.get("result", {}).get("message_id")
            if mid:
                set_edit_prompt_msg(db, manager_id, mid)
            return {"ok": True, "action": action}
        if action == "memory":
            telegram.answer_callback(callback_id)
            if approval:
                telegram.send_text(
                    manager_id,
                    telegram.client_memory_card(approval.extracted_fields, lead=lead, approval_id=approval.id),
                )
            return {"ok": True, "action": action}
        if action == "why":
            if not approval:
                telegram.answer_callback(callback_id, "Запрос не найден")
                return {"ok": False, "error": "approval_not_found"}
            # Reasoning captured live when the reply was generated (see generate_reply) is the
            # real mechanism, not a guess. Only fall back to asking the model to reconstruct
            # a reason when nothing was captured (old cards) or the manager rewrote the reply.
            if approval.ai_reasoning and not approval.edited_reply:
                telegram.answer_callback(callback_id)
                explanation = approval.ai_reasoning
            else:
                telegram.answer_callback(callback_id, "Спрашиваю у бота...")
                from app.services.openai_service import explain_reply
                from app.tasks.pipeline import save_ai_usage
                try:
                    result = explain_reply(
                        approval.client_message or "",
                        approval.edited_reply or approval.ai_reply or "",
                        conversation_summary=approval.conversation_summary,
                    )
                    save_ai_usage(db, approval.lead_id, result)
                    explanation = (result.content or "Не удалось получить объяснение.") + (
                        "\n\n⚠️ Реконструировано задним числом — точная причина не сохранена."
                    )
                except Exception as exc:
                    _log.error("explain_reply failed approval_id=%s: %s", approval_id, exc)
                    explanation = "Ошибка: не удалось получить объяснение."
            text_out = f"🤖 Почему бот так ответил (№{approval_id:07d}):\n\n{explanation}"
            try:
                telegram.send_text(callback_chat_id or manager_id, text_out)
            except Exception:
                telegram.send_text(manager_id, text_out)
            return {"ok": True, "action": action}
        if action == "consult":
            if not approval or not lead:
                telegram.answer_callback(callback_id, "Лид не найден")
                return {"ok": False, "error": "lead_not_found"}
            if approval.status not in {"pending", "edited"}:
                telegram.answer_callback(callback_id, "Запрос уже обработан")
                return {"ok": False, "action": action}
            from app.services.openai_service import ai_edit_reply
            from app.tasks.pipeline import save_ai_usage
            consult_prompt = (
                "Перепиши ответ так, чтобы предложить клиенту записаться на бесплатную консультацию косметолога. "
                "Упомяни его конкретную проблему кожи если она видна из диалога. "
                "Одной фразой объясни ценность консультации (косметолог подберёт уход именно под его кожу). "
                "Предложи 1-2 ближайших свободных времени если они известны. "
                "Ответ короткий, тёплый, уважительный, на языке клиента."
            )
            try:
                result = ai_edit_reply(
                    approval.edited_reply or approval.ai_reply,
                    approval.client_message,
                    consult_prompt,
                )
                changed = db.execute(sql_update(ApprovalRequest).where(
                    ApprovalRequest.id == approval_id,
                    ApprovalRequest.status.in_(("pending", "edited")),
                ).values(edited_reply=str(result.content), status="edited",
                         manager_telegram_id=manager_id))
                if changed.rowcount != 1:
                    db.rollback()
                    telegram.answer_callback(callback_id, "Запрос уже обработан")
                    return {"ok": False, "action": action}
                db.commit()
                db.refresh(approval)
                save_ai_usage(db, approval.lead_id, result)
                telegram.edit_approval_card(approval, lead, chat_id=callback_chat_id)
                telegram.answer_callback(callback_id, "📅 Предложение консультации готово")
            except Exception:
                telegram.answer_callback(callback_id, "Ошибка при генерации")
            return {"ok": True, "action": action}
        if action in ("came_yes", "came_no"):
            reminder = db.get(ConsultationReminder, int(raw_id))
            if not reminder:
                telegram.answer_callback(callback_id, "Запись не найдена")
                return {"ok": False, "error": "reminder_not_found"}
            came = "Да" if action == "came_yes" else "Нет"
            from app.services.google_sheets import update_came_status
            update_came_status(reminder.sheet_name, reminder.row_number, came)
            reminder.status = "came" if came == "Да" else "not_came"
            db.commit()
            label = "✅ Отмечено: пришёл" if came == "Да" else "❌ Отмечено: не пришёл"
            telegram.answer_callback(callback_id, label)
            return {"ok": True, "action": action}

        if lead:
            target = telegram.crm_chat_url(lead) if telegram.is_test_lead(lead) else telegram.lead_url(lead)
            telegram.answer_callback(callback_id, target)
        return {"ok": True, "action": action}

    if message := update.get("message"):
        manager_id = str(message.get("from", {}).get("id", ""))
        message_chat_id = str(message.get("chat", {}).get("id", ""))
        text = message.get("text", "").strip()
        db_manager_ids = _load_db_manager_ids(db)
        if not telegram.is_authorized_manager(manager_id, message_chat_id, extra_allowed=db_manager_ids):
            return {"ok": False, "error": "unauthorized_manager"}
        # Non-text message (sticker/photo/voice) must not consume pending edit sessions
        if not text:
            return {"ok": True, "action": "ignored_non_text"}
        if text in {"/consult", "/consultations"}:
            from app.services.google_sheets import get_all_consultations_for_date

            today = datetime.now(ZoneInfo(settings.timezone)).strftime("%d.%m.%Y")
            consultations = get_all_consultations_for_date(today)
            if not consultations:
                telegram.send_text(manager_id, f"Консультаций на {today} нет.")
            else:
                lines = [f"Консультации на {today}:"]
                for c in consultations:
                    came_icon = "✅" if c.get("came") == "Да" else ("❌" if c.get("came") == "Нет" else "⏳")
                    lines.append(
                        f"\n{came_icon} {c.get('time', '—')} — {c.get('name', '—')}\n"
                        f"  Тел: {c.get('phone', '—')} | {c.get('status', '—')}"
                    )
                telegram.send_text(manager_id, "\n".join(lines))
            return {"ok": True, "action": "consult"}

        if text in {"/no-sorted", "/nosorted", "/unsorted"}:
            approvals = db.scalars(
                select(ApprovalRequest)
                .where(ApprovalRequest.status == "saved")
                .order_by(desc(ApprovalRequest.created_at))
                .limit(10)
            ).all()
            if not approvals:
                telegram.send_text(manager_id, "Сохраненных неразобранных ответов нет.")
                return {"ok": True, "action": "no_sorted"}
            lines = ["Неразобранные ответы:"]
            for item in approvals:
                lead = db.get(Lead, item.lead_id)
                lead_label = lead.amocrm_lead_id if lead else str(item.lead_id)
                lines.append(
                    f"#{item.id} | Lead {lead_label} | {item.amocrm_stage_name or item.amocrm_status_id or '-'}\n"
                    f"Клиент: {item.client_message[:120]}\n"
                    f"AI: {(item.edited_reply or item.ai_reply)[:180]}"
                )
            telegram.send_text(manager_id, "\n\n".join(lines))
            return {"ok": True, "action": "no_sorted"}
        # Причина отказа («Другое»)
        reject_reason_approval_id = pop_reject_reason_session(db, manager_id)
        if reject_reason_approval_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            ok = reject_request(db, reject_reason_approval_id, manager_id, text.strip())
            telegram.send_text(manager_id, "Отклонено")
            return {"ok": ok, "action": "reject_reason_freetext"}

        # Ручное редактирование
        edit_approval_id = pop_edit_session(db, manager_id)
        if edit_approval_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = apply_edited_reply(db, edit_approval_id, manager_id, text)
            lead = db.get(Lead, approval.lead_id) if approval else None
            if approval and lead:
                clear_claim(db, edit_approval_id)
                db.refresh(approval)
                has_templates = bool(_load_templates(db))
                result = telegram.edit_approval_card(approval, lead, has_templates=has_templates)
                if result.get("skipped") or result.get("_all_failed") or result.get("error"):
                    _log.error("edit_approval_card failed after manual edit approval_id=%s msg_id=%s result=%s", edit_approval_id, approval.telegram_message_id, result)
                    telegram.send_text(manager_id, f"⚠️ Не удалось обновить карточку №{edit_approval_id:07d}, но ответ сохранён. Нажмите «Принять» — правильный ответ будет отправлен клиенту.")
            return {"ok": True, "action": "edited"}

        # Покупка — полный ответ вручную. Не отправляем сразу: показываем
        # менеджеру карточку с его текстом и кнопкой «Принять» для подтверждения.
        purchase_edit_id = pop_purchase_edit_session(db, manager_id)
        if purchase_edit_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = apply_edited_reply(db, purchase_edit_id, manager_id, text.strip())
            if approval is None:
                return {"ok": False, "error": "approval_not_editable"}
            _refresh_purchase_card(db, approval, manager_id)
            return {"ok": True, "action": "purchase_replied"}

        # Покупка — подстановка в шаблон. Тоже с подтверждением.
        purchase_answer_id = pop_purchase_answer_session(db, manager_id)
        if purchase_answer_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = db.get(ApprovalRequest, purchase_answer_id)
            if approval:
                template = (approval.extracted_fields or {}).get("_purchase_template") or telegram.PURCHASE_PLACEHOLDER
                if telegram.PURCHASE_PLACEHOLDER in template:
                    final = template.replace(telegram.PURCHASE_PLACEHOLDER, text.strip())
                else:
                    final = f"{template} {text.strip()}".strip()
                approval = apply_edited_reply(db, purchase_answer_id, manager_id, final)
                if approval is None:
                    return {"ok": False, "error": "approval_not_editable"}
                _refresh_purchase_card(db, approval, manager_id)
            else:
                return {"ok": False, "error": "approval_not_editable"}
            return {"ok": True, "action": "purchase_answered"}

        # Перевод ответа
        translate_approval_id = pop_translate_session(db, manager_id)
        if translate_approval_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = db.get(ApprovalRequest, translate_approval_id)
            if approval:
                from app.services.openai_service import translate_reply
                from app.tasks.pipeline import save_ai_usage
                reply_text = approval.edited_reply or approval.ai_reply or ""
                try:
                    result = translate_reply(
                        reply_text,
                        approval.client_message or "",
                        text,
                    )
                    save_ai_usage(db, approval.lead_id, result)
                    approval.edited_reply = str(result.content)
                    db.commit()
                    db.refresh(approval)
                    lead = db.get(Lead, approval.lead_id)
                    if lead:
                        has_templates = bool(_load_templates(db))
                        telegram.edit_approval_card(approval, lead, has_templates=has_templates)
                except Exception as exc:
                    _log.error("translate_reply failed approval_id=%s: %s", translate_approval_id, exc)
                    telegram.send_text(message_chat_id or manager_id, "Ошибка перевода.")
            return {"ok": True, "action": "translated"}

        # Заметка
        note_approval_id = pop_note_session(db, manager_id)
        if note_approval_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = db.get(ApprovalRequest, note_approval_id)
            if approval:
                fields = dict(approval.extracted_fields or {})
                fields["_note"] = text.strip()
                approval.extracted_fields = fields
                db.commit()
                db.refresh(approval)
                lead = db.get(Lead, approval.lead_id)
                if lead:
                    has_templates = bool(_load_templates(db))
                    telegram.edit_approval_card(approval, lead, has_templates=has_templates)
            return {"ok": True, "action": "note_saved"}

        # AI-редактор
        ai_edit_approval_id = pop_ai_edit_session(db, manager_id)
        if ai_edit_approval_id and text:
            prompt_mid = pop_edit_prompt_msg(db, manager_id)
            if prompt_mid:
                telegram.delete_message(manager_id, prompt_mid)
            approval = apply_ai_edited_reply(db, ai_edit_approval_id, manager_id, text)
            lead = db.get(Lead, approval.lead_id) if approval else None
            if approval and lead:
                clear_claim(db, ai_edit_approval_id)
                db.refresh(approval)
                has_templates = bool(_load_templates(db))
                telegram.edit_approval_card(approval, lead, has_templates=has_templates)
            return {"ok": True, "action": "ai_edited"}
    return {"ok": True}
