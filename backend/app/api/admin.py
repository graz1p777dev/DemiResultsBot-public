import csv
import io
import json as _json
import logging
import os
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from urllib.parse import unquote
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, or_, select, text
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.db.session import get_db
from app.models.entities import (
    ActionLog,
    AIExtractedFields,
    AIUsage,
    ApprovalRequest,
    Blacklist,
    Client,
    ClientMemory,
    ConsultationSlot,
    Conversation,
    Lead,
    Message,
    MessageBuffer,
    Setting,
    TrainingExample,
)
from app.services.slots import day_slots, is_working_day
from app.services import amocrm, crm_notify
from app.services.openai_service import ai_edit_reply, generate_reply, transcribe_audio_bytes, transcribe_voice
from app.schemas.amocrm import IncomingMessage
from app.services.repository import mark_manager_takeover, store_outgoing_message, upsert_incoming
from app.tasks.pipeline import apply_edited_reply, apply_ai_edited_reply, approve_request, reject_request, move_lead_status
from app.tasks.pipeline import process_lead_buffer

router = APIRouter(prefix="/admin", tags=["admin"])
_log = logging.getLogger(__name__)


class WhatsAppStatus(BaseModel):
    message_id: str = Field(min_length=1, max_length=255, pattern=r"^[A-Za-z0-9._:-]+$")
    status: str = Field(pattern="^(sent|delivered|read|failed)$")
    provider: str = Field(default="meta_whatsapp", pattern="^(meta_whatsapp|green_api)$")


@router.post("/crm/whatsapp-status")
def whatsapp_status(body: WhatsAppStatus, db: Session = Depends(get_db)) -> dict:
    prefix = "green" if body.provider == "green_api" else "meta"
    message = db.scalar(select(Message).where(
        Message.direction == "outgoing",
        or_(Message.message_id == body.message_id, Message.raw_payload[f"{prefix}_message_ids"].contains([body.message_id])),
    ).with_for_update())
    if not message or (message.raw_payload or {}).get("provider") != body.provider:
        return {"ok": True, "matched": False}
    previous = {
        "sent": {"queued", "sent"},
        "delivered": {"queued", "sent", "delivered"},
        "read": {"queued", "sent", "delivered", "read"},
        "failed": {"queued", "sent", "failed"},
    }
    raw = dict(message.raw_payload or {})
    ids = raw.get(f"{prefix}_message_ids") or [message.message_id]
    states = {identifier: "queued" for identifier in ids}
    states.update(raw.get(f"{prefix}_message_statuses") or {})
    if states.get(body.message_id, "queued") in previous[body.status]:
        states[body.message_id] = body.status
    raw[f"{prefix}_message_statuses"] = states
    message.raw_payload = raw
    if "failed" in states.values():
        message.status = "failed"
    elif len(ids) < raw.get(f"{prefix}_expected_parts", len(ids)):
        message.status = "queued"
    else:
        rank = {"queued": 0, "sent": 1, "delivered": 2, "read": 3}
        message.status = min(states.values(), key=lambda status: rank[status])
    db.commit()
    return {"ok": True, "matched": True}


@router.get("/delivery-recovery")
def delivery_recovery(db: Session = Depends(get_db)) -> dict:
    """Read-only diagnostics: no customer text, contact information or secrets."""
    messages = db.scalars(select(Message).where(
        Message.direction == "outgoing",
        or_(Message.raw_payload["outbox"]["state"].as_string().in_(("ready", "sending", "uncertain")),
            Message.status.in_(("pending_dispatch", "dispatching", "send_failed", "approved"))),
    ).order_by(Message.id).limit(100)).all()
    outgoing = []
    for message in messages:
        raw = message.raw_payload or {}
        intent = raw.get("outbox") or {}
        if intent.get("state") == "completed":
            continue
        outgoing.append({"row_id": message.id, "status": message.status,
            "state": intent.get("state", "legacy_requires_review"),
            "approval_id": intent.get("approval_id"),
            "active_part": intent.get("active_part"),
            "accepted_parts": len(raw.get("green_message_ids") or []),
            "expected_parts": len(intent.get("parts") or []) or raw.get("green_expected_parts"),
            "started_at": intent.get("started_at")})
    receipts = db.scalars(select(Setting).where(
        Setting.key.like("telegram_update:%"),
        ~Setting.value.contains('"state": "completed"'),
    ).order_by(Setting.updated_at.desc()).limit(100)).all()
    import json
    updates = []
    for row in receipts:
        try:
            receipt = json.loads(row.value)
        except (ValueError, TypeError):
            continue
        if receipt.get("state") != "completed":
            updates.append({"update_id": row.key.split(":", 1)[1],
                "state": receipt.get("state"), "received_at": receipt.get("received_at")})
    return {"outgoing": outgoing, "telegram_updates": updates, "limit": 100,
        "policy": "Never resend sending/uncertain/legacy attempts without provider reconciliation"}


class DealStageMove(BaseModel):
    pipeline_id: int
    status_id: int


class CrmIncomingMessage(BaseModel):
    text: str = ""
    direction: str = "incoming"
    chat_id: str
    message_id: str
    client_id: str
    client_name: str = ""
    lead_id: str
    contact_id: str | None = None
    source: str = "whatsapp_green"
    media: str | None = None
    attachment_type: str | None = None
    attachment_link: str | None = None
    timestamp: datetime | None = None
    raw: dict | None = None


@router.post("/crm/incoming")
def crm_incoming(body: CrmIncomingMessage, db: Session = Depends(get_db)) -> dict:
    incoming = IncomingMessage(
        raw=body.raw or body.model_dump(exclude={"raw"}, mode="json"),
        text=body.text or "",
        direction=body.direction or "incoming",
        chat_id=body.chat_id,
        message_id=body.message_id,
        client_id=body.client_id,
        client_name=body.client_name or "",
        lead_id=body.lead_id,
        contact_id=body.contact_id or "",
        source=body.source or "whatsapp_green",
        media=body.media or "",
        attachment_type=body.attachment_type,
        attachment_link=body.attachment_link,
        timestamp=body.timestamp or datetime.now(ZoneInfo("UTC")),
    )
    voice_url = incoming.attachment_link or incoming.media or None
    if incoming.attachment_type in {"voice", "audio"} and voice_url:
        try:
            if voice_url.startswith("meta-whatsapp:"):
                audio, _content_type = crm_notify.get_whatsapp_media(voice_url.split(":", 1)[1])
                transcribed = transcribe_audio_bytes(audio, "incoming.ogg")
            else:
                transcribed, _language = transcribe_voice(voice_url)
        except Exception as exc:
            _log.warning('Incoming voice transcription failed type=%s', type(exc).__name__)
            transcribed = ""
        incoming.raw = {**(incoming.raw or {}), 'voice_transcription': {'status': 'success' if transcribed else 'failed'}}
        incoming.text = f"[voice] {voice_url} {transcribed}".strip()

    if incoming.direction == "outgoing":
        stored = store_outgoing_message(db, incoming)
        return {
            "ok": True,
            "queued": False,
            "stored": stored,
            "reason": "manager_outgoing",
            "lead_id": incoming.lead_id,
            "message_id": incoming.message_id,
        }

    lead, _conversation, is_new = upsert_incoming(db, incoming)
    if is_new and lead.ai_enabled:
        process_lead_buffer.apply_async(
            args=[lead.id, incoming.message_id],
            countdown=app_settings.message_buffer_seconds,
        )
    return {"ok": True, "queued": is_new, "lead_id": lead.amocrm_lead_id, "message_id": incoming.message_id}


def _deal_source(value: str | None) -> str:
    normalized = (value or "").lower()
    if "wapp" in normalized or "whatsapp" in normalized:
        return "whatsapp"
    if "instagram" in normalized:
        return "instagram"
    if "telegram" in normalized:
        return "telegram"
    return "amocrm"


def _iso_timestamp(value: int | None) -> str:
    if not value:
        return datetime.now(ZoneInfo("UTC")).isoformat()
    return datetime.fromtimestamp(value, tz=ZoneInfo("UTC")).isoformat()


@router.get("/deals/snapshot")
def deals_snapshot(db: Session = Depends(get_db)) -> dict:
    pipeline_id = 10355262
    pipeline = amocrm.get_pipeline(pipeline_id)
    statuses = pipeline.get("_embedded", {}).get("statuses", [])
    stages = [
        {
            "id": int(status["id"]),
            "name": status.get("name") or f"Этап {status['id']}",
            "sort": int(status.get("sort") or 0),
            "color": status.get("color") or "#94a3b8",
            "pipeline_id": pipeline_id,
            "kind": "won" if int(status["id"]) == 142 else "lost" if int(status["id"]) == 143 else "normal",
        }
        for status in statuses
    ]

    local_leads = db.scalars(select(Lead).where(Lead.is_test.is_(False))).all()
    local_by_amo = {int(lead.amocrm_lead_id): lead for lead in local_leads if str(lead.amocrm_lead_id).isdigit()}
    deals = []
    for amo_lead in amocrm.list_pipeline_leads(pipeline_id):
        lead_id = int(amo_lead["id"])
        local = local_by_amo.get(lead_id)
        client = local.client if local else None
        deals.append({
            "lead_id": lead_id,
            "pipeline_id": int(amo_lead.get("pipeline_id") or pipeline_id),
            "status_id": int(amo_lead["status_id"]),
            "title": amo_lead.get("name") or (client.name if client else None) or f"Сделка #{lead_id}",
            "amount": amo_lead.get("price"),
            "customer_name": client.name if client else None,
            "customer_phone": client.phone if client else None,
            "customer_username": None,
            "source": _deal_source(client.source if client else None),
            "created_at": _iso_timestamp(amo_lead.get("created_at")),
            "updated_at": _iso_timestamp(amo_lead.get("updated_at")),
        })
        if local and local.status_id != int(amo_lead["status_id"]):
            local.status_id = int(amo_lead["status_id"])
    db.commit()
    return {"stages": stages, "deals": deals}


@router.post("/deals/{amocrm_lead_id}/stage")
def move_deal_stage(amocrm_lead_id: int, payload: DealStageMove, db: Session = Depends(get_db)) -> dict:
    pipeline = amocrm.get_pipeline(payload.pipeline_id)
    valid_status_ids = {
        int(status["id"]) for status in pipeline.get("_embedded", {}).get("statuses", [])
    }
    if payload.status_id not in valid_status_ids:
        raise HTTPException(400, "Status does not belong to the selected pipeline")
    response = amocrm.patch_lead_status(str(amocrm_lead_id), payload.status_id, payload.pipeline_id)
    local = db.scalar(select(Lead).where(Lead.amocrm_lead_id == str(amocrm_lead_id)))
    if local:
        local.status_id = payload.status_id
        db.commit()
    return {"ok": True, "amo": response}


@router.get("/chat/{amocrm_lead_id}")
def get_chat_history(amocrm_lead_id: str, db: Session = Depends(get_db)) -> dict:
    lead = db.scalar(select(Lead).where(Lead.amocrm_lead_id == amocrm_lead_id))
    if not lead:
        raise HTTPException(404, "Lead not found")
    lead.unread_count = 0
    db.commit()
    messages = db.scalars(
        select(Message).where(Message.lead_id == lead.id).order_by(Message.created_at)
    ).all()
    pending_approvals = db.scalars(
        select(ApprovalRequest).where(
            ApprovalRequest.lead_id == lead.id,
            ApprovalRequest.status.in_(("pending", "edited")),
        )
    ).all()
    client = lead.client
    memory_rows = db.scalars(
        select(ClientMemory)
        .where(ClientMemory.client_id == client.id)
        .order_by(ClientMemory.created_at.desc())
    ).all() if client else []
    client_card: dict[str, str] = {}
    for memory in memory_rows:
        # Keep the newest extracted value for every client field.
        client_card.setdefault(memory.key, memory.value)
    rows = [
        {
            "id": m.id,
            "role": m.role,
            "text": m.text,
            "status": m.status,
            "created_at": m.created_at,
            "media_url": m.media_url,
            "message_type": m.message_type,
        }
        for m in messages
    ]
    source = ((client.source if client else "") or "").lower()
    uses_direct_channel = lead.is_test or "whatsapp" in source or "green_api" in source or "instagram_meta" in source
    remote_messages = []
    if not uses_direct_channel:
        try:
            remote_messages = amocrm.get_chat_history(lead.chat_id or "")
        except Exception as exc:
            _log.warning("live chat history failed for lead %s: %s", lead.id, exc)
    if remote_messages:
        local_outgoing = [m for m in messages if m.direction == "outgoing"]
        rows = []
        for item in remote_messages:
            role = item["role"]
            speaker = item.get("speaker")
            author_name = item.get("author_name")
            if role != "user":
                candidates = [m for m in local_outgoing if (m.text or "").strip() == (item["content"] or "").strip()]
                if candidates:
                    local = min(
                        candidates,
                        key=lambda m: abs(m.created_at.timestamp() - item["created_at"].timestamp())
                        if m.created_at and item["created_at"] else 0,
                    )
                    role = local.role
                    speaker = "manager" if local.role == "manager" else "bot"
                    author_name = "Менеджер CRM" if local.role == "manager" else "Айым"
            rows.append({
                "id": item["message_id"],
                "role": role,
                "speaker": speaker,
                "author_name": author_name,
                "text": item["content"],
                "status": "sent" if role != "user" else "received",
                "created_at": item["created_at"],
                "media_url": None,
                "message_type": "text",
            })
        # amoCRM may return a partial history (for example while its chat
        # endpoint is catching up). Keep locally stored CRM replies visible
        # instead of replacing them with the incomplete remote response.
        for local in messages:
            if not local.text or local.direction != "outgoing":
                continue
            already_present = any(
                (row.get("text") or "").strip() == local.text.strip()
                and row.get("created_at")
                and local.created_at
                and abs((row["created_at"] - local.created_at).total_seconds()) <= 180
                for row in rows
            )
            if not already_present:
                rows.append({
                    "id": f"local-{local.id}",
                    "role": local.role,
                    "speaker": "manager" if local.role == "manager" else "bot",
                    "author_name": "Менеджер CRM" if local.role == "manager" else "Айым",
                    "text": local.text,
                    "status": local.status or "sent",
                    "created_at": local.created_at,
                    "media_url": local.media_url,
                    "message_type": local.message_type or "text",
                })
    rows += [
        {
            "id": f"appr-{a.id}",
            "approval_id": a.id,
            "role": "assistant",
            "speaker": "bot",
            "author_name": "Айым",
            # An edited approval remains pending until the manager decides;
            # show the revised text, never the obsolete original draft.
            "text": a.edited_reply or a.ai_reply,
            "status": "pending_review",
            "created_at": a.created_at,
            "media_url": None,
            "message_type": "text",
        }
        for a in pending_approvals
    ]
    rows.sort(key=lambda r: r["created_at"] or datetime.min.replace(tzinfo=ZoneInfo("UTC")))
    return {
        "lead_id": lead.amocrm_lead_id,
        "internal_lead_id": lead.id,
        "ai_enabled": lead.ai_enabled,
        "client_name": client.name if client else None,
        "client_phone": client.phone if client else None,
        "client_card": client_card,
        "amocrm_url": "" if uses_direct_channel else f"{app_settings.amocrm_base_url.rstrip('/')}/leads/detail/{lead.amocrm_lead_id}",
        "messages": [
            {**r, "created_at": r["created_at"].isoformat() if r["created_at"] else None}
            for r in rows
        ],
    }


@router.get("/attachment/{message_id}")
def get_attachment(message_id: int, db: Session = Depends(get_db)):
    """Stream a client's voice/photo attachment through the backend.

    amoCRM attachment links require our Bearer token, which the CRM browser
    doesn't have. The URL always comes from a stored Message row — never from
    caller input — so this cannot be used to fetch arbitrary URLs with our
    credentials.
    """
    message = db.get(Message, message_id)
    if not message or not message.media_url:
        raise HTTPException(404, "Attachment not found")
    if message.media_url.startswith("meta-whatsapp:"):
        try:
            content, content_type = crm_notify.get_whatsapp_media(message.media_url.split(":", 1)[1])
        except Exception:
            raise HTTPException(502, "Не удалось получить вложение Meta")
        return StreamingResponse(io.BytesIO(content), media_type=content_type, headers={"Cache-Control": "private, no-store"})
    auth_headers = {}
    if app_settings.amocrm_access_token:
        auth_headers["Authorization"] = f"Bearer {app_settings.amocrm_access_token}"
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as http:
            resp = http.get(message.media_url, headers=auth_headers)
    except Exception:
        raise HTTPException(502, "Could not fetch attachment")
    if not resp.is_success:
        raise HTTPException(502, "Could not fetch attachment")
    content_type = resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    return StreamingResponse(io.BytesIO(resp.content), media_type=content_type)


class ToggleAI(BaseModel):
    enabled: bool


class InboxState(BaseModel):
    read: bool | None = None
    pinned: bool | None = None
    draft_text: str | None = None
    claim: bool | None = None


class ClientMerge(BaseModel):
    target_client_id: int


class ManualMessage(BaseModel):
    text: str


@router.post("/leads/{lead_id}/generate-reply")
def generate_manual_reply(lead_id: int, db: Session = Depends(get_db)) -> dict:
    """Put the latest client turn back into the approval workflow on demand.

    The reply is never sent here: the normal pipeline creates a pending
    approval, which a manager can edit, approve, or reject in the CRM.
    """
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404, "Диалог не найден")
    pending = db.scalar(select(ApprovalRequest.id).where(
        ApprovalRequest.lead_id == lead.id,
        ApprovalRequest.status.in_(("pending", "edited")),
    ))
    if pending:
        raise HTTPException(409, "По этому диалогу уже есть ответ на согласовании")
    latest = db.scalar(
        select(Message)
        .where(Message.lead_id == lead.id, Message.direction == "incoming")
        .order_by(Message.created_at.desc())
    )
    if not latest or not latest.text.strip():
        raise HTTPException(409, "Нет сообщения клиента для генерации ответа")
    conversation = db.scalar(select(Conversation).where(Conversation.id == latest.conversation_id))
    if not conversation:
        raise HTTPException(409, "Не найдена переписка клиента")
    trigger_id = f"manual:{latest.id}:{uuid4()}"
    db.add(MessageBuffer(
        lead_id=lead.id,
        conversation_id=conversation.id,
        message_id=trigger_id,
        text=latest.text,
        timestamp=datetime.now(ZoneInfo("UTC")),
    ))
    db.commit()
    process_lead_buffer.apply_async(args=[lead.id, trigger_id])
    return {"ok": True, "queued": True}


class ReplyOptionsRequest(BaseModel):
    instruction: str = Field(default="", max_length=1500)
    count: int = Field(default=3, ge=1, le=6)


@router.post("/leads/{lead_id}/reply-options")
def reply_options(lead_id: int, body: ReplyOptionsRequest, db: Session = Depends(get_db)) -> dict:
    """Generate manager-controlled reply variants; nothing is sent from here."""
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404, "Диалог не найден")
    messages = db.scalars(
        select(Message).where(Message.lead_id == lead.id).order_by(Message.created_at.desc()).limit(30)
    ).all()[::-1]
    latest = next((message for message in reversed(messages) if message.direction == "incoming"), None)
    if not latest or not latest.text.strip():
        raise HTTPException(409, "Нет сообщения клиента для ответа")
    dialogue = [{"role": message.role, "content": message.text} for message in messages if message.text]
    base = generate_reply(dialogue, {}).content
    extra = body.instruction.strip()
    approaches = [
        ("Тёплый", "Ответь тепло, естественно и заботливо."),
        ("Краткий", "Ответь максимально кратко и по делу, сохранив дружелюбный тон."),
        ("Консультативный", "Сначала помоги и уточни потребность; не дави и не торопи клиента."),
        ("Продающий", "Мягко веди клиента к следующему шагу или покупке, без давления."),
        ("Уверенный", "Ответь уверенно и конкретно, сними сомнение клиента фактами из контекста."),
        ("Заботливый", "Сделай акцент на состоянии и комфорте клиента, прояви эмпатию."),
    ]
    options = []
    for title, approach in approaches[:body.count]:
        instruction = f"{approach} Не повторяй дословно другие варианты. {extra}".strip()
        edited = ai_edit_reply(base, latest.text, instruction).content
        options.append({"approach": title, "text": edited or base})
    return {"options": options}


@router.post("/transcribe")
async def transcribe_dictation(file: UploadFile = File(...)) -> dict:
    """Convert a short CRM microphone recording to editable text."""
    allowed_types = {
        "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/mpga",
        "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav",
    }
    content_type = (file.content_type or "").split(";")[0].lower()
    if content_type not in allowed_types:
        raise HTTPException(415, "Поддерживаются аудиофайлы MP3, MP4, M4A, OGG, WAV, WEBM и FLAC")
    data = await file.read(20 * 1024 * 1024 + 1)
    if not data:
        raise HTTPException(400, "Запись пустая")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "Запись слишком большая — максимум 20 МБ")
    try:
        text = transcribe_audio_bytes(data, file.filename or "dictation.webm")
    except Exception as exc:
        _log.exception("CRM dictation transcription failed")
        raise HTTPException(502, "Не удалось распознать запись") from exc
    if not text:
        raise HTTPException(422, "В записи не удалось распознать речь")
    return {"ok": True, "text": text}


ALLOWED_UPLOAD_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/ogg": ".opus",
    "audio/opus": ".opus",
    "audio/webm": ".opus",
    "audio/mp4": ".m4a",
    "audio/m4a": ".m4a",
    "audio/x-m4a": ".m4a",
}


class ApprovalEdit(BaseModel):
    reply: str


class ApprovalAIEdit(BaseModel):
    prompt: str


class ApprovalEditPreview(BaseModel):
    reply: str = Field(max_length=10000)
    prompt: str | None = Field(default=None, max_length=2000)
    expected_current: str | None = Field(default=None, max_length=10000)


class ApprovalReject(BaseModel):
    reason: str


class ApprovalSettingsUpdate(BaseModel):
    channel: str


def _crm_manager_id(request: Request) -> str:
    employee_id = request.headers.get("X-Employee-ID", "").strip()
    if employee_id:
        return f"crm-id:{employee_id[:64]}"
    encoded = request.headers.get("X-User-Name", "CRM")
    return f"crm:{unquote(encoded)[:100]}"


def _setting_value(db: Session, key: str, default: str = "") -> str:
    row = db.scalar(select(Setting).where(Setting.key == key))
    return row.value if row and row.value else default


def _set_setting_value(db: Session, key: str, value: str) -> None:
    row = db.scalar(select(Setting).where(Setting.key == key))
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value, is_secret=False))


def _approval_row(approval: ApprovalRequest, lead: Lead, client: Client | None) -> dict:
    fields = approval.extracted_fields or {}
    return {
        "id": approval.id,
        "status": approval.status,
        "client_message": approval.client_message,
        "ai_reply": approval.ai_reply,
        "edited_reply": approval.edited_reply,
        "suggested_reply": approval.edited_reply or approval.ai_reply or fields.get("_purchase_template") or "",
        "reject_reason": approval.reject_reason,
        "conversation_summary": approval.conversation_summary,
        "client_message_translation": approval.client_message_translation,
        "ai_reply_translation": approval.ai_reply_translation,
        "ai_reasoning": approval.ai_reasoning,
        "stage_name": approval.amocrm_stage_name,
        "created_at": approval.created_at,
        "is_purchase": bool(fields.get("_purchase_intent")),
        "is_stop_word": bool(fields.get("_stop_word")),
        "lead": {
            "id": lead.id,
            "amocrm_lead_id": lead.amocrm_lead_id,
            "ai_enabled": lead.ai_enabled,
        },
        "client": {
            "id": client.id if client else None,
            "name": client.name if client else None,
            "phone": client.phone if client else None,
            "source": client.source if client else None,
        },
    }


def _conversation_row(row: Lead, db: Session | None = None) -> dict:
    latest_text = None
    if db is not None:
        latest_text = db.scalar(select(Message.text).where(Message.lead_id == row.id).order_by(Message.created_at.desc()).limit(1))
    return {
        "id": row.id,
        "amocrm_lead_id": row.amocrm_lead_id,
        "chat_id": row.chat_id,
        "contact_id": row.contact_id,
        "ai_enabled": row.ai_enabled,
        "last_message_at": row.last_message_at,
        "client": row.client.name if row.client else None,
        "phone": row.client.phone if row.client else None,
        "source": row.client.source if row.client else None,
        "unread_count": row.unread_count or 0,
        "pinned_at": row.pinned_at,
        "draft_text": row.draft_text or "",
        "responsible_manager": row.responsible_manager,
        "preview_text": latest_text,
    }


@router.get("/conversations/by-lead/{amocrm_lead_id}")
def conversation_by_lead(amocrm_lead_id: str, db: Session = Depends(get_db)) -> dict:
    """Resolve a deal's exact bot lead independently of Inbox filters."""
    lead = db.scalar(select(Lead).where(Lead.amocrm_lead_id == amocrm_lead_id))
    if not lead:
        raise HTTPException(404, "Диалог для сделки не найден")
    return _conversation_row(lead, db)


@router.get("/conversations")
def conversations(
    request: Request,
    db: Session = Depends(get_db),
    limit: int | None = None,
    offset: int = 0,
    q: str | None = None,
    unread: bool = False,
    mine: bool = False,
    source: str | None = None,
) -> list[dict]:
    # Backward compatible: without limit/q returns all leads (old CRM relies on this).
    # With limit → paginated for lazy scroll; with q → search across the whole DB.
    stmt = select(Lead).outerjoin(Client, Lead.client_id == Client.id)
    # CRM supports WhatsApp, Instagram and explicitly created Laboratory test
    # clients. Legacy amoCRM/Telegram/Facebook records stay hidden.
    stmt = stmt.where(
        or_(
            func.lower(Client.source).like("%whatsapp%"),
            func.lower(Client.source).like("%instagram%"),
            func.lower(Client.source) == "lab",
        )
    )
    if unread:
        stmt = stmt.where(Lead.unread_count > 0)
    if mine:
        manager_name = unquote(request.headers.get("X-User-Name", ""))
        stmt = stmt.where(Lead.responsible_manager == manager_name)
    if source and source.strip():
        stmt = stmt.where(func.lower(Client.source).like(f"%{source.strip().lower()}%"))
    if q and q.strip():
        term = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Client.name.ilike(term),
                Client.phone.ilike(term),
                Lead.amocrm_lead_id.ilike(term),
            )
        )
    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = db.scalars(stmt.order_by(desc(Lead.pinned_at).nullslast(), desc(Lead.updated_at))).all()
    return [_conversation_row(row, db) for row in rows]


@router.get("/clients")
def list_clients(
    db: Session = Depends(get_db),
    limit: int = 100,
    offset: int = 0,
    q: str | None = None,
) -> dict:
    limit = min(max(limit, 1), 200)
    offset = max(offset, 0)
    lead_stats = (
        select(
            Lead.client_id.label("client_id"),
            func.count(Lead.id).label("deals_count"),
            func.max(Lead.last_message_at).label("last_message_at"),
            func.array_agg(Lead.amocrm_lead_id).label("amocrm_lead_ids"),
        )
        .where(Lead.is_test.is_(False))
        .group_by(Lead.client_id)
        .subquery()
    )
    stmt = (
        select(Client, func.coalesce(lead_stats.c.deals_count, 0), lead_stats.c.last_message_at, lead_stats.c.amocrm_lead_ids)
        .outerjoin(lead_stats, lead_stats.c.client_id == Client.id)
    )
    if q and q.strip():
        term = f"%{q.strip()}%"
        stmt = stmt.where(or_(Client.name.ilike(term), Client.phone.ilike(term)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(
        stmt.order_by(desc(lead_stats.c.last_message_at).nullslast(), desc(Client.updated_at))
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [
            {
                "id": client.id,
                "name": client.name,
                "phone": client.phone,
                "source": client.source,
                "external_id": client.amocrm_author_id,
                "deals_count": int(deals_count or 0),
                "amocrm_lead_ids": amocrm_lead_ids or [],
                "last_message_at": last_message_at,
                "created_at": client.created_at,
            }
            for client, deals_count, last_message_at, amocrm_lead_ids in rows
        ],
        "total": int(total),
    }


@router.get("/clients/{client_id}")
def client_detail(client_id: int, db: Session = Depends(get_db), lead_ids: str | None = None) -> dict:
    selected_ids = None
    if lead_ids is not None:
        parts = lead_ids.split(",")
        if any(not part or not part.isascii() or not part.isdecimal() or part.startswith("0") or len(part) > 19 for part in parts):
            raise HTTPException(400, "Invalid lead_ids")
        selected_ids = list(dict.fromkeys(int(part) for part in parts))
        if len(selected_ids) > 200 or any(value > 9223372036854775807 for value in selected_ids):
            raise HTTPException(400, "Invalid lead_ids")
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    lead_query = select(Lead).where(Lead.client_id == client.id, Lead.is_test.is_(False))
    if selected_ids is not None:
        lead_query = lead_query.where(Lead.id.in_(selected_ids))
    leads = db.scalars(lead_query.order_by(desc(Lead.updated_at))).all()
    lead_ids = [lead.id for lead in leads]
    messages = []
    if lead_ids:
        messages = db.scalars(
            select(Message).where(Message.lead_id.in_(lead_ids)).order_by(desc(Message.created_at)).limit(300)
        ).all()
    return {
        "id": client.id,
        "name": client.name,
        "phone": client.phone,
        "source": client.source,
        "external_id": client.amocrm_author_id,
        "created_at": client.created_at,
        "updated_at": client.updated_at,
        "leads": [
            {
                "id": lead.id,
                "amocrm_lead_id": lead.amocrm_lead_id,
                "status_id": lead.status_id,
                "ai_enabled": lead.ai_enabled,
                "last_message_at": lead.last_message_at,
                "created_at": lead.created_at,
            }
            for lead in leads
        ],
        "messages": [
            {
                "id": message.id,
                "lead_id": message.lead_id,
                "role": message.role,
                "direction": message.direction,
                "text": message.text,
                "status": message.status,
                "created_at": message.created_at,
            }
            for message in reversed(messages)
        ],
    }


@router.post("/clients/{client_id}/merge")
def merge_client(client_id: int, payload: ClientMerge, db: Session = Depends(get_db)) -> dict:
    if client_id == payload.target_client_id:
        raise HTTPException(400, "Нельзя объединить карточку саму с собой")
    source = db.get(Client, client_id)
    target = db.get(Client, payload.target_client_id)
    if not source or not target:
        raise HTTPException(404, "Карточка клиента не найдена")

    moved_leads = db.query(Lead).filter(Lead.client_id == source.id).update({Lead.client_id: target.id})
    db.query(ClientMemory).filter(ClientMemory.client_id == source.id).update({ClientMemory.client_id: target.id})
    if not target.name and source.name:
        target.name = source.name
    if not target.phone and source.phone:
        target.phone = source.phone
    if not target.source and source.source:
        target.source = source.source
    db.add(ActionLog(
        action="client.merge",
        status="success",
        request_payload={"source_client_id": source.id, "target_client_id": target.id},
        response_payload={"moved_leads": moved_leads},
    ))
    db.delete(source)
    db.commit()
    return {"ok": True, "target_client_id": target.id, "moved_leads": moved_leads}


@router.get("/leads/{lead_id}")
def lead_detail(lead_id: int, db: Session = Depends(get_db)) -> dict:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404)
    messages = db.scalars(select(Message).where(Message.lead_id == lead.id).order_by(Message.created_at)).all()
    logs = db.scalars(select(ActionLog).where(ActionLog.lead_id == lead.id).order_by(desc(ActionLog.created_at)).limit(100)).all()
    extracted = db.scalars(
        select(AIExtractedFields).where(AIExtractedFields.lead_id == lead.id).order_by(desc(AIExtractedFields.created_at)).limit(10)
    ).all()
    memory = db.scalars(select(ClientMemory).where(ClientMemory.lead_id == lead.id).order_by(desc(ClientMemory.created_at))).all()
    approvals = db.scalars(
        select(ApprovalRequest)
        .where(ApprovalRequest.lead_id == lead.id)
        .order_by(desc(ApprovalRequest.created_at))
        .limit(20)
    ).all()
    usage = db.scalars(
        select(AIUsage).where(AIUsage.lead_id == lead.id).order_by(desc(AIUsage.created_at)).limit(50)
    ).all()
    training_examples = db.scalars(
        select(TrainingExample)
        .where(TrainingExample.lead_id == lead.id)
        .order_by(desc(TrainingExample.created_at))
        .limit(20)
    ).all()
    usage_summary = db.execute(
        select(
            func.coalesce(func.sum(AIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(AIUsage.completion_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_cost), 0),
        ).where(AIUsage.lead_id == lead.id)
    ).one()
    return {
        "lead": {
            "id": lead.id,
            "amocrm_lead_id": lead.amocrm_lead_id,
            "chat_id": lead.chat_id,
            "contact_id": lead.contact_id,
            "ai_enabled": lead.ai_enabled,
            "client": lead.client.name if lead.client else None,
        },
        "messages": [{"role": m.role, "text": m.text, "status": m.status, "created_at": m.created_at} for m in messages],
        "logs": [
            {
                "action": log.action,
                "status": log.status,
                "error": log.error,
                "created_at": log.created_at,
            }
            for log in logs
        ],
        "extracted": [item.raw_output for item in extracted],
        "memory": [{"key": item.key, "value": item.value, "source": item.source} for item in memory],
        "approvals": [
            {
                "id": item.id,
                "status": item.status,
                "client_message": item.client_message,
                "ai_reply": item.ai_reply,
                "edited_reply": item.edited_reply,
                "manager_telegram_id": item.manager_telegram_id,
                "amocrm_stage_name": item.amocrm_stage_name,
                "amocrm_status_id": item.amocrm_status_id,
                "created_at": item.created_at,
                "approved_at": item.approved_at,
            }
            for item in approvals
        ],
        "usage_summary": {
            "prompt_tokens": int(usage_summary[0] or 0),
            "completion_tokens": int(usage_summary[1] or 0),
            "total_tokens": int(usage_summary[2] or 0),
            "total_cost": float(usage_summary[3] or 0),
        },
        "usage": [
            {
                "provider": item.provider,
                "model": item.model,
                "purpose": item.purpose,
                "prompt_tokens": item.prompt_tokens,
                "completion_tokens": item.completion_tokens,
                "total_tokens": item.total_tokens,
                "total_cost": item.total_cost,
                "latency_ms": item.latency_ms,
                "created_at": item.created_at,
            }
            for item in usage
        ],
        "training_examples": [
            {
                "id": item.id,
                "client_message": item.client_message,
                "ai_reply": item.ai_reply,
                "final_reply": item.final_reply,
                "was_edited": item.was_edited,
                "quality_label": item.quality_label,
                "created_at": item.created_at,
            }
            for item in training_examples
        ],
    }


@router.patch("/leads/{lead_id}/ai")
def toggle_ai(lead_id: int, payload: ToggleAI, db: Session = Depends(get_db)) -> dict:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404)
    lead.ai_enabled = payload.enabled
    db.commit()
    return {"ok": True, "ai_enabled": lead.ai_enabled}


def _send_text_to_lead(lead: Lead, message: str) -> tuple[dict, str]:
    """Send through the lead's real channel; CRM is only the control plane."""
    source = ((lead.client.source if lead.client else "") or "").lower()

    if "instagram" in source:
        return crm_notify.send_channel_message("instagram", lead.chat_id or "", message), "instagram.send_message"

    if "whatsapp" in source or "green_api" in source or (lead.chat_id or "").endswith(("@c.us", "@g.us")):
        try:
            return crm_notify.send_channel_message("whatsapp", lead.chat_id or "", message), "green_api.send_message"
        except httpx.HTTPStatusError as exc:
            status = 503 if exc.response.status_code == 503 else 502
            raise HTTPException(status, "Green API не подключён" if status == 503 else "Green API не принял сообщение") from exc
        except (httpx.HTTPError, RuntimeError) as exc:
            raise HTTPException(502, "Green API временно недоступен") from exc

    raise HTTPException(409, "Для этого диалога не определён канал отправки")


def _send_media_to_lead(lead: Lead, media_url: str, filename: str, label: str) -> dict:
    source = ((lead.client.source if lead.client else "") or "").lower()
    if "instagram" in source:
        return crm_notify.send_channel_message("instagram", lead.chat_id or "", f"{label}: {media_url}")
    if "whatsapp" not in source and "green_api" not in source and not (lead.chat_id or "").endswith(("@c.us", "@g.us")):
        raise HTTPException(409, "Для этого диалога не определён канал отправки")
    try:
        media_type = "image" if filename.lower().endswith((".jpg", ".jpeg", ".png", ".webp")) else "audio"
        return crm_notify.send_whatsapp_media(lead.chat_id or "", media_url, label, media_type)
    except httpx.HTTPStatusError as exc:
        status = 503 if exc.response.status_code == 503 else 502
        raise HTTPException(status, "Green API не подключён" if status == 503 else "Green API не принял вложение") from exc
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(502, "Green API временно недоступен") from exc


@router.patch("/leads/{lead_id}/inbox")
def update_inbox_state(lead_id: int, payload: InboxState, request: Request, db: Session = Depends(get_db)) -> dict:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404)
    if payload.read is True:
        lead.unread_count = 0
    if payload.pinned is not None:
        lead.pinned_at = datetime.now(ZoneInfo("UTC")) if payload.pinned else None
    if payload.draft_text is not None:
        lead.draft_text = payload.draft_text[:10_000]
    if payload.claim is not None:
        manager = unquote(request.headers.get("X-User-Name", ""))[:255]
        lead.responsible_manager = manager if payload.claim else None
    db.commit()
    return {
        "ok": True,
        "unread_count": lead.unread_count,
        "pinned_at": lead.pinned_at,
        "draft_text": lead.draft_text or "",
        "responsible_manager": lead.responsible_manager,
    }


@router.post("/leads/{lead_id}/messages")
def send_manual_message(lead_id: int, payload: ManualMessage, request: Request, db: Session = Depends(get_db)) -> dict:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404)
    ai_was_enabled = bool(lead.ai_enabled)
    result, action = _send_text_to_lead(lead, payload.text)
    # Record in chat history as a consultant message
    conversation = db.scalar(select(Conversation).where(Conversation.lead_id == lead.id))
    if not conversation:
        conversation = Conversation(lead_id=lead.id, chat_id=lead.chat_id)
        db.add(conversation)
        db.flush()
    db.add(Message(
        conversation_id=conversation.id,
        lead_id=lead.id,
        role="manager",
        direction="outgoing",
        text=payload.text,
        message_id=result.get("messageId") if result.get("provider") in {"meta_whatsapp", "green_api"} else None,
        status="queued" if result.get("provider") in {"meta_whatsapp", "green_api"} else "sent",
        raw_payload={"provider": result.get("provider")},
    ))
    manual_payload = payload.model_dump()
    manual_payload["manager_id"] = request.headers.get("X-Employee-ID") or _crm_manager_id(request)
    manual_payload["manager_name"] = unquote(request.headers.get("X-User-Name", "CRM"))[:255]
    db.add(ActionLog(lead_id=lead.id, action=action, status="success", request_payload=manual_payload, response_payload=result))
    mark_manager_takeover(db, lead)
    move_lead_status(db, lead, app_settings.amocrm_status_primary_contact, "sales_message")
    db.commit()
    return {"ok": True, "result": result, "ai_disabled": ai_was_enabled}


@router.post("/leads/{lead_id}/media")
async def send_manual_media(
    lead_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404)
    ai_was_enabled = bool(lead.ai_enabled)
    content_type = (file.content_type or "").split(";")[0].lower()
    suffix = ALLOWED_UPLOAD_TYPES.get(content_type)
    if not suffix:
        raise HTTPException(415, "Разрешены JPG, PNG, WEBP и голосовые OPUS")
    content = await file.read(15 * 1024 * 1024 + 1)
    if not content or len(content) > 15 * 1024 * 1024:
        raise HTTPException(413, "Файл должен быть не больше 15 МБ")
    media_dir = "/app/media"
    os.makedirs(media_dir, mode=0o750, exist_ok=True)
    filename = f"{uuid4().hex}{suffix}"
    with open(os.path.join(media_dir, filename), "wb") as output:
        output.write(content)
    media_url = f"{app_settings.public_backend_url.rstrip('/')}/media/{filename}"
    label = "Голосовое сообщение" if content_type.startswith("audio/") else "Фото"
    text_value = f"{label}: {media_url}"
    result = _send_media_to_lead(lead, media_url, filename, label)
    conversation = db.scalar(select(Conversation).where(Conversation.lead_id == lead.id))
    if not conversation:
        conversation = Conversation(lead_id=lead.id, chat_id=lead.chat_id or "")
        db.add(conversation)
        db.flush()
    db.add(Message(
        conversation_id=conversation.id,
        lead_id=lead.id,
        role="manager",
        direction="outgoing",
        text=text_value,
        message_type="voice" if content_type.startswith("audio/") else "image",
        media_url=media_url,
        message_id=result.get("messageId") if result.get("provider") in {"meta_whatsapp", "green_api"} else None,
        status="queued" if result.get("provider") in {"meta_whatsapp", "green_api"} else "sent",
        raw_payload={"manager": unquote(request.headers.get("X-User-Name", "CRM")), "content_type": content_type, "provider": result.get("provider")},
    ))
    mark_manager_takeover(db, lead)
    move_lead_status(db, lead, app_settings.amocrm_status_primary_contact, "sales_message")
    db.commit()
    return {"ok": True, "media_url": media_url, "result": result, "ai_disabled": ai_was_enabled}


@router.get("/approvals")
def list_approvals(
    status: str = "pending,edited",
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> dict:
    statuses = {item.strip() for item in status.split(",") if item.strip()}
    if not statuses:
        statuses = {"pending", "edited"}
    limit = min(max(limit, 1), 200)
    offset = max(offset, 0)
    stmt = (
        select(ApprovalRequest, Lead, Client)
        .join(Lead, ApprovalRequest.lead_id == Lead.id)
        .outerjoin(Client, Lead.client_id == Client.id)
        .where(ApprovalRequest.status.in_(statuses))
    )
    if q and q.strip():
        term = f"%{q.strip()}%"
        stmt = stmt.where(or_(
            Client.name.ilike(term),
            Client.phone.ilike(term),
            Lead.amocrm_lead_id.ilike(term),
            ApprovalRequest.client_message.ilike(term),
        ))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(
        stmt.order_by(ApprovalRequest.created_at.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [_approval_row(approval, lead, client) for approval, lead, client in rows],
        "total": int(total),
    }


@router.patch("/approvals/{approval_id}")
def edit_approval(
    approval_id: int,
    body: ApprovalEdit,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    reply = body.reply.strip()
    if not reply:
        raise HTTPException(400, "Ответ не может быть пустым")
    if len(reply) > 10_000:
        raise HTTPException(400, "Ответ слишком длинный")
    approval = apply_edited_reply(db, approval_id, _crm_manager_id(request), reply)
    if not approval:
        raise HTTPException(409, "Карточка уже обработана другим менеджером")
    return {"ok": True, "status": approval.status, "edited_reply": approval.edited_reply}


@router.post("/approvals/{approval_id}/ai-edit")
def ai_edit_approval(
    approval_id: int,
    body: ApprovalAIEdit,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(400, "Укажите, как улучшить ответ")
    if len(prompt) > 2_000:
        raise HTTPException(400, "Инструкция слишком длинная")
    approval = apply_ai_edited_reply(db, approval_id, _crm_manager_id(request), prompt)
    if not approval:
        raise HTTPException(409, "Карточка уже обработана другим менеджером")
    return {"ok": True, "status": approval.status, "edited_reply": approval.edited_reply}


@router.post('/approvals/{approval_id}/edit-preview')
def preview_approval_edit(approval_id: int, body: ApprovalEditPreview,
    request: Request, db: Session = Depends(get_db)) -> dict:
    from app.services.telegram_edits import create_proposal
    approval = db.get(ApprovalRequest, approval_id)
    if not approval or approval.status not in {'pending', 'edited'}:
        raise HTTPException(409, 'Карточка уже обработана')
    if body.expected_current is not None and body.expected_current.strip() != (approval.edited_reply or approval.ai_reply or '').strip():
        raise HTTPException(409, 'Ответ изменён другим сотрудником. Обновите диалог.')
    try:
        token, reply = create_proposal(db, approval, _crm_manager_id(request), 'crm',
            body.reply.strip(), (body.prompt or '').strip() or None)
    except ValueError:
        raise HTTPException(400, 'Не удалось подготовить непустой ответ')
    return {'ok': True, 'proposal_token': token, 'edited_reply': reply}


@router.post('/approvals/{approval_id}/edit-preview/{token}/{decision}')
def decide_approval_edit(approval_id: int, token: str, decision: str,
    request: Request, db: Session = Depends(get_db)) -> dict:
    from app.services.telegram_edits import confirm
    if decision not in {'accept', 'discard'}:
        raise HTTPException(404, 'Неизвестное действие')
    if not confirm(db, token, _crm_manager_id(request), 'crm', decision == 'accept', approval_id):
        raise HTTPException(409, 'Карточка изменилась или правка уже обработана')
    return {'ok': True, 'status': 'sent' if decision == 'accept' else 'discarded'}


@router.post("/approvals/{approval_id}/approve")
def approve_from_crm(
    approval_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    if not approve_request(db, approval_id, _crm_manager_id(request)):
        approval = db.get(ApprovalRequest, approval_id)
        detail = "Не удалось отправить ответ клиенту"
        if approval and approval.status not in {"pending", "edited"}:
            detail = "Карточка уже обработана или отправка завершилась ошибкой"
        raise HTTPException(409, detail)
    return {"ok": True, "status": "sent"}


@router.post("/approvals/{approval_id}/reject")
def reject_from_crm(
    approval_id: int,
    body: ApprovalReject,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(400, "Укажите причину отклонения")
    if not reject_request(db, approval_id, _crm_manager_id(request), reason):
        raise HTTPException(409, "Карточка уже обработана другим менеджером")
    return {"ok": True, "status": "rejected"}


@router.get("/approval-settings")
def get_approval_settings(db: Session = Depends(get_db)) -> dict:
    return {
        "channel": _setting_value(db, "approval_channel", "crm"),
        "available_channels": ["crm", "both", "telegram"],
    }


@router.patch("/approval-settings")
def update_approval_settings(
    body: ApprovalSettingsUpdate,
    db: Session = Depends(get_db),
) -> dict:
    if body.channel not in {"crm", "both", "telegram"}:
        raise HTTPException(400, "channel must be crm, both or telegram")
    _set_setting_value(db, "approval_channel", body.channel)
    db.commit()
    return {"ok": True, "channel": body.channel}


@router.get("/settings")
def list_settings(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(select(Setting).order_by(Setting.key)).all()
    return [{"key": row.key, "value": "***" if row.is_secret else row.value, "is_secret": row.is_secret} for row in rows]


class BotPromptUpdate(BaseModel):
    prompt: str


class BudgetAlertUpdate(BaseModel):
    monthly_budget_usd: float
    warn_at_percent: int = 80


@router.get("/budget-alert")
def get_budget_alert(db: Session = Depends(get_db)) -> dict:
    budget = float(_setting_value(db, "monthly_ai_budget_usd", "0") or 0)
    warn = int(_setting_value(db, "ai_budget_warn_percent", "80") or 80)
    month_cost = float(db.scalar(text("SELECT COALESCE(SUM(total_cost),0) FROM ai_usage WHERE created_at >= date_trunc('month', NOW())")) or 0)
    return {"monthly_budget_usd": budget, "warn_at_percent": warn, "spent_usd": month_cost}


@router.patch("/budget-alert")
def update_budget_alert(body: BudgetAlertUpdate, db: Session = Depends(get_db)) -> dict:
    if body.monthly_budget_usd < 0 or not 1 <= body.warn_at_percent <= 100:
        raise HTTPException(400, "Некорректный бюджет или порог")
    _set_setting_value(db, "monthly_ai_budget_usd", str(body.monthly_budget_usd))
    _set_setting_value(db, "ai_budget_warn_percent", str(body.warn_at_percent))
    db.commit()
    return get_budget_alert(db)


@router.get("/bot-prompt")
def get_bot_prompt(db: Session = Depends(get_db)) -> dict:
    from app.services.prompts import SALES_AGENT_SYSTEM_PROMPT
    row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt"))
    return {"prompt": row.value if row else SALES_AGENT_SYSTEM_PROMPT}


@router.patch("/bot-prompt")
def update_bot_prompt(body: BotPromptUpdate, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt"))
    if row:
        row.value = body.prompt
    else:
        db.add(Setting(key="bot_system_prompt", value=body.prompt, is_secret=False))
    db.commit()
    return {"ok": True}


@router.get("/openai-models")
def list_openai_models() -> list[str]:
    """Available OpenAI chat models for the bot."""
    from openai import OpenAI
    from app.core.config import settings as _settings
    if not _settings.openai_api_key:
        return []
    try:
        client = OpenAI(api_key=_settings.openai_api_key)
        models = [
            m.id for m in client.models.list()
            if (m.id.startswith("gpt-") or m.id.startswith("o"))
            and not any(x in m.id for x in ("audio", "realtime", "transcribe", "tts", "image", "embedding", "moderation", "search", "instruct"))
        ]
        return sorted(models)
    except Exception:
        return []


class BotModelUpdate(BaseModel):
    model_simple: str = ""
    model_sales: str = ""


@router.get("/bot-model")
def get_bot_model(db: Session = Depends(get_db)) -> dict:
    from app.core.config import settings as _settings
    simple = db.scalar(select(Setting).where(Setting.key == "bot_model_simple"))
    sales = db.scalar(select(Setting).where(Setting.key == "bot_model_sales"))
    return {
        "model_simple": (simple.value if simple else "") or _settings.openai_model_simple,
        "model_sales": (sales.value if sales else "") or _settings.openai_model_sales,
        "default_simple": _settings.openai_model_simple,
        "default_sales": _settings.openai_model_sales,
    }


@router.patch("/bot-model")
def update_bot_model(body: BotModelUpdate, db: Session = Depends(get_db)) -> dict:
    for key, value in [("bot_model_simple", body.model_simple), ("bot_model_sales", body.model_sales)]:
        row = db.scalar(select(Setting).where(Setting.key == key))
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value, is_secret=False))
    db.commit()
    return {"ok": True}


class BotMemoryUpdate(BaseModel):
    memory: str


@router.get("/bot-memory")
def get_bot_memory(db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(Setting).where(Setting.key == "bot_memory"))
    return {"memory": row.value if row else ""}


@router.patch("/bot-memory")
def update_bot_memory(body: BotMemoryUpdate, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(Setting).where(Setting.key == "bot_memory"))
    if row:
        row.value = body.memory
    else:
        db.add(Setting(key="bot_memory", value=body.memory, is_secret=False))
    db.commit()
    return {"ok": True}


BOT_MODES = {"manual", "aggressive", "autonomous"}


class BotModeUpdate(BaseModel):
    mode: str


@router.get("/bot-mode")
def get_bot_mode(db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(Setting).where(Setting.key == "bot_mode"))
    return {"mode": row.value if row and row.value else "manual"}


@router.patch("/bot-mode")
def update_bot_mode(body: BotModeUpdate, db: Session = Depends(get_db)) -> dict:
    if body.mode not in BOT_MODES:
        raise HTTPException(400, f"mode must be one of {sorted(BOT_MODES)}")
    row = db.scalar(select(Setting).where(Setting.key == "bot_mode"))
    if row:
        row.value = body.mode
    else:
        db.add(Setting(key="bot_mode", value=body.mode, is_secret=False))
    db.commit()
    return {"ok": True}


class AiTestRequest(BaseModel):
    message: str
    history: list[dict] = []  # [{"role": "user"|"assistant", "content": "..."}]
    model: str = ""                    # empty = prod model
    temperature: float = 0.5
    max_tokens: int | None = None
    system_prompt: str = ""            # test prompt override — prod prompt is NOT touched
    memory: str | None = None          # None = use prod bot_memory
    is_working_hours: bool = True
    minutes_since: int = 9999
    lang: str = "ru"
    images: list[str] = []             # data URLs of uploaded images


# $ per 1M tokens (input, output) for the tester cost estimate and the Laboratory model picker.
# Exact catalog — do not add extra models without updating pricing from the provider first.
_TEST_COST_MAP = {
    # OpenAI
    "gpt-5.5": (5.00, 30.00),
    "gpt-5.5-pro": (30.00, 180.00),
    "gpt-5.4": (2.50, 15.00),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.25),
    # Google Gemini — gemini-2.5-pro price shown is the <=200k-context tier;
    # above 200k context it's $2.50/$15.00 (same model id, tiered by Google).
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    # DeepSeek — cache-miss input price
    "deepseek-v3.2": (0.14, 0.28),
    "deepseek-v4-pro": (0.435, 0.87),
    "deepseek-reasoner": (0.55, 2.19),  # DeepSeek R1
}

_GEMINI_MODELS = {"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"}
# Catalog display name -> actual DeepSeek API model id. DeepSeek retired "deepseek-chat" and
# "deepseek-reasoner" (both now 400 invalid_request_error) in favor of "deepseek-v4-pro" /
# "deepseek-v4-flash" -- those are the only two ids the API currently accepts (2026-07-26).
_DEEPSEEK_API_MODEL = {
    "deepseek-v3.2": "deepseek-v4-flash",
    "deepseek-v4-pro": "deepseek-v4-pro",
    "deepseek-reasoner": "deepseek-v4-pro",
}


@router.get("/model-pricing")
def model_pricing() -> list[dict]:
    """Model catalog with $/1M token pricing for the Laboratory model picker."""
    return [
        {"model": model, "input_cost_per_1m": in_c, "output_cost_per_1m": out_c}
        for model, (in_c, out_c) in sorted(_TEST_COST_MAP.items())
    ]


@router.post("/ai-test")
def ai_test(body: AiTestRequest, db: Session = Depends(get_db)) -> dict:
    from time import perf_counter
    from app.services.openai_service import _client, _deepseek_client
    from app.services.prompts import SALES_AGENT_SYSTEM_PROMPT

    # Test prompt override; otherwise the prod prompt from DB
    if body.system_prompt.strip():
        system_prompt = body.system_prompt
    else:
        row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt"))
        system_prompt = row.value if row else SALES_AGENT_SYSTEM_PROMPT

    if body.memory is not None:
        memory_context = body.memory
    else:
        mem_row = db.scalar(select(Setting).where(Setting.key == "bot_memory"))
        memory_context = mem_row.value if mem_row else ""
    if memory_context.strip():
        system_prompt += "\n\n---\nПАМЯТЬ МАГАЗИНА (используй эти данные при ответах):\n" + memory_context.strip()

    model = body.model or app_settings.openai_model_simple

    now = datetime.now(ZoneInfo(app_settings.timezone))
    time_note = f"[СИСТЕМНОЕ ВРЕМЯ БИШКЕК: {now.strftime('%H:%M')} {now.strftime('%d.%m.%Y')}]\n"
    if body.minutes_since <= 60:
        time_note += "[НЕ ПРИВЕТСТВУЙ — диалог продолжается, прошло менее 60 минут.]\n"
    else:
        time_note += "[ПРИВЕТСТВИЕ: если нет предыдущих ответов ассистента — поздоровайся один раз.]\n"
    if not body.is_working_hours:
        time_note += "[НЕРАБОЧЕЕ ВРЕМЯ. Сообщи что магазин работает с 10:00 до 21:00. НЕ предлагай консультацию.]\n"
    if body.lang and body.lang != "ru":
        _lang_names = {"ky": "кыргызском", "kz": "казахском", "en": "английском", "uz": "узбекском"}
        label = _lang_names.get(body.lang, body.lang)
        time_note += f"[ЯЗЫК КЛИЕНТА: {label} ({body.lang}). СТРОГО: пиши ответ ТОЛЬКО на {label} языке.]\n"

    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    messages += [{"role": m["role"], "content": m["content"]} for m in body.history]
    if body.images:
        content: list[dict] = [{"type": "image_url", "image_url": {"url": u}} for u in body.images[:3]]
        content.append({"type": "text", "text": time_note + body.message})
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": time_note + body.message})

    try:
        started = perf_counter()
        if model in _GEMINI_MODELS:
            from app.services.openai_service import call_gemini
            reply_text, usage_dict = call_gemini(model, messages, body.temperature)
            p_tok = usage_dict.get("prompt_tokens", 0)
            c_tok = usage_dict.get("completion_tokens", 0)
        else:
            is_deepseek = model in _DEEPSEEK_API_MODEL
            client = _deepseek_client() if is_deepseek else _client()
            api_model = _DEEPSEEK_API_MODEL[model] if is_deepseek else model
            kwargs: dict = {"model": api_model, "temperature": body.temperature, "messages": messages}
            if body.max_tokens:
                kwargs["max_tokens"] = body.max_tokens
            response = client.chat.completions.create(**kwargs)
            usage = response.usage
            p_tok = usage.prompt_tokens if usage else 0
            c_tok = usage.completion_tokens if usage else 0
            reply_text = (response.choices[0].message.content or "").strip()
        latency_ms = int((perf_counter() - started) * 1000)
        in_c, out_c = _TEST_COST_MAP.get(model, (1.0, 4.0))
        cost = p_tok / 1_000_000 * in_c + c_tok / 1_000_000 * out_c
        return {
            "ok": True,
            "reply": reply_text,
            "tokens": p_tok + c_tok,
            "cost": round(cost, 6),
            "latency_ms": latency_ms,
            "model": model,
        }
    except Exception as e:
        return {"ok": False, "reply": f"Ошибка: {e}"}


@router.post("/ai-test/transcribe")
async def ai_test_transcribe(file: UploadFile = File(...)) -> dict:
    """Transcribe an uploaded voice message (for the CRM tester)."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        return {"ok": True, "text": transcribe_audio_bytes(data, file.filename or 'voice.ogg')}
    except Exception as e:
        _log.warning('ASR tester failed type=%s', type(e).__name__)
        return {"ok": False, "text": "", "error": 'Не удалось распознать аудио'}


# ─── Лента действий бота (терминал в AI-лаборатории) ─────────────────────────
# action_logs копится с самого запуска бота и весит немало: одна строка
# amocrm.send_message — это до 2.5 КБ сырого ответа amoCRM. Терминал опрашивает
# ленту раз в секунду, поэтому наружу отдаём только то, что он рисует, а полный
# payload — отдельным запросом по клику на строку.

_TEXT_CAP = 200


def _clip(value: object, cap: int = _TEXT_CAP) -> str:
    text_value = value if isinstance(value, str) else str(value)
    return text_value if len(text_value) <= cap else text_value[: cap - 1] + "…"


def _filled_fields(fields: object) -> list[str]:
    """Имена заполненных полей карточки. Ключи с подчёркиванием — служебные."""
    if not isinstance(fields, dict):
        return []
    return [k for k, v in fields.items() if not k.startswith("_") and v not in (None, "", [], {})]


def _summarize(action: str, request: object, response: object, error: str | None) -> dict:
    """Компактная выжимка строки лога: только примитивы, никаких сырых payload'ов."""
    req = request if isinstance(request, dict) else {}
    resp = response if isinstance(response, dict) else {}

    if action == "amocrm.move_lead_status":
        return {"status_id": req.get("status_id"), "reason": _clip(req.get("reason", ""), 120) or None}

    if action == "amocrm.patch_lead":
        # На success сюда кладут уже готовый patch, на skipped/error — сырые поля.
        fields = _filled_fields(req)
        return {"fields": fields, "count": len(fields), "reason": resp.get("reason")}

    if action == "openai.extract_fields":
        fields = _filled_fields(resp.get("fields"))
        return {"fields": fields, "count": len(fields)}

    if action == "openai.sales_intent":
        intent = resp.get("intent") if isinstance(resp.get("intent"), dict) else {}
        return {
            "is_sales": intent.get("is_sales"),
            "is_purchase": intent.get("is_purchase"),
            "is_complex": intent.get("is_complex"),
            # Модель пишет обоснование свободным текстом, иногда на несколько строк.
            "reason": _clip(intent.get("reason", ""), 120) or None,
            "message": _clip(req.get("latest_message", ""), 120),
        }

    if action == "openai.sales_agent":
        return {"dialogue_messages": req.get("dialogue_messages"), "tokens": resp.get("total_tokens")}

    if action == "amocrm.send_message":
        return {"text": _clip(req.get("text", ""))}

    if action in {"pipeline.non_sales_routed", "pipeline.skip_scheduled_consultation"}:
        reason = req.get("reason") or req.get("stage_name") or ""
        return {"reason": _clip(reason, 120) or None, "message": _clip(req.get("message", ""), 120)}

    if action == "pipeline.purchase_intent":
        return {"message": _clip(req.get("message", ""), 120)}

    if action == "pipeline.blacklisted":
        return {"phone": req.get("phone")}

    if action == "training.example_saved":
        return {"approval_id": req.get("approval_id"), "was_edited": req.get("was_edited")}

    if action.startswith("telegram."):
        return {"approval_id": req.get("approval_id")}

    return {}


@router.get("/action-logs")
def action_logs(
    db: Session = Depends(get_db),
    after_id: int | None = None,
    limit: int = 50,
    lead_id: int | None = None,
    action: str | None = None,
) -> dict:
    """Лента действий бота. Без after_id — последние `limit` строк, иначе только новые.

    Всегда возвращает строки по возрастанию id: терминал дописывает их снизу.
    """
    limit = max(1, min(limit, 200))

    stmt = select(ActionLog)
    if lead_id is not None:
        stmt = stmt.where(ActionLog.lead_id == lead_id)
    if action:
        # Префикс: "amocrm" отберёт все amocrm.*, точное имя — ровно его.
        stmt = stmt.where(ActionLog.action.startswith(action))

    if after_id is None:
        # Первая загрузка: берём хвост через desc + limit, потом разворачиваем.
        rows = list(db.scalars(stmt.order_by(desc(ActionLog.id)).limit(limit)).all())
        rows.reverse()
    else:
        rows = list(db.scalars(stmt.where(ActionLog.id > after_id).order_by(ActionLog.id).limit(limit)).all())

    lead_ids = {r.lead_id for r in rows if r.lead_id is not None}
    leads: dict[int, Lead] = {}
    if lead_ids:
        leads = {lead.id: lead for lead in db.scalars(select(Lead).where(Lead.id.in_(lead_ids))).all()}

    items = []
    for row in rows:
        lead = leads.get(row.lead_id) if row.lead_id is not None else None
        items.append(
            {
                "id": row.id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "action": row.action,
                "status": row.status,
                "lead_id": row.lead_id,
                "amocrm_lead_id": lead.amocrm_lead_id if lead else None,
                "client_name": lead.client.name if lead and lead.client else None,
                "error": _clip(row.error) if row.error else None,
                "detail": _summarize(row.action, row.request_payload, row.response_payload, row.error),
            }
        )

    # last_id из строк, а не из max(id) таблицы: иначе фильтр по lead_id/action
    # заставил бы терминал перескочить через ещё не показанные строки.
    return {"items": items, "last_id": items[-1]["id"] if items else after_id}


@router.get("/action-logs/{log_id}")
def action_log_detail(log_id: int, db: Session = Depends(get_db)) -> dict:
    """Полный payload одной строки — по клику в терминале, а не в общей ленте."""
    row = db.get(ActionLog, log_id)
    if not row:
        raise HTTPException(status_code=404, detail="action log not found")
    return {
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "action": row.action,
        "status": row.status,
        "lead_id": row.lead_id,
        "error": row.error,
        "request_payload": row.request_payload,
        "response_payload": row.response_payload,
    }


# ─── Тестовые пользователи лаборатории ───────────────────────────────────────
# Тестовый лид — обычный лид с флагом is_test. Его сообщение идёт через тот же
# upsert_incoming и тот же process_lead_buffer, что и сообщение живого клиента:
# буфер, классификация, ответ ИИ, карточка менеджеру, кнопки. Разница ровно одна —
# наружу (amoCRM, Google Sheets) не уходит ничего, см. _is_test в pipeline.py.

_TEST_LEAD_PREFIX = "test-"


class TestUserCreate(BaseModel):
    name: str
    contact: str | None = None


class TestUserMessage(BaseModel):
    text: str


def _test_lead_or_404(db: Session, lead_pk: int) -> Lead:
    lead = db.get(Lead, lead_pk)
    if not lead:
        raise HTTPException(status_code=404, detail="lead not found")
    # Через ручки лаборатории нельзя дотянуться до живого клиента.
    if not lead.is_test:
        raise HTTPException(status_code=403, detail="lead is not a test user")
    return lead


def _test_user_row(db: Session, lead: Lead) -> dict:
    last = db.scalar(
        select(Message).where(Message.lead_id == lead.id).order_by(desc(Message.created_at)).limit(1)
    )
    pending = db.scalar(
        select(func.count(ApprovalRequest.id)).where(
            ApprovalRequest.lead_id == lead.id, ApprovalRequest.status == "pending"
        )
    )
    return {
        "id": lead.id,
        "amocrm_lead_id": lead.amocrm_lead_id,
        "name": lead.client.name if lead.client else None,
        "contact": lead.client.phone if lead.client else None,
        "ai_enabled": lead.ai_enabled,
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
        "last_message": (last.text[:120] if last and last.text else None),
        "last_message_role": last.role if last else None,
        "pending_approvals": int(pending or 0),
    }


@router.get("/lab/test-users")
def lab_test_users(db: Session = Depends(get_db)) -> list[dict]:
    leads = db.scalars(select(Lead).where(Lead.is_test.is_(True)).order_by(desc(Lead.id))).all()
    return [_test_user_row(db, lead) for lead in leads]


@router.post("/lab/test-users", status_code=201)
def lab_create_test_user(body: TestUserCreate, db: Session = Depends(get_db)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    token = uuid4().hex[:12]
    client = Client(amocrm_author_id=f"test:{token}", name=name, phone=(body.contact or "").strip() or None, source="lab")
    db.add(client)
    db.flush()

    lead = Lead(
        # Префикс делает синтетический id узнаваемым и в базе, и в ссылке /chat/<id>.
        amocrm_lead_id=f"{_TEST_LEAD_PREFIX}{token}",
        client_id=client.id,
        chat_id=f"test:{token}",
        contact_id=None,
        is_test=True,
        ai_enabled=True,
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return _test_user_row(db, lead)


@router.post("/lab/test-users/{lead_pk}/messages")
def lab_test_user_message(lead_pk: int, body: TestUserMessage, db: Session = Depends(get_db)) -> dict:
    lead = _test_lead_or_404(db, lead_pk)
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    from app.schemas.amocrm import IncomingMessage
    from app.services.repository import upsert_incoming
    from app.tasks.pipeline import process_lead_buffer

    message_id = f"lab:{uuid4().hex}"
    incoming = IncomingMessage(
        raw={"source": "lab", "lead_pk": lead.id},
        text=text,
        direction="incoming",
        chat_id=lead.chat_id or "",
        message_id=message_id,
        client_id=lead.client.amocrm_author_id if lead.client else f"test:{lead.id}",
        client_name=(lead.client.name if lead.client else "Тестовый клиент"),
        lead_id=lead.amocrm_lead_id,
        source="lab",
        timestamp=datetime.now(ZoneInfo(app_settings.timezone)),
    )
    _lead, _conversation, is_new = upsert_incoming(db, incoming)

    queued = False
    if is_new and lead.ai_enabled:
        # Тот же буфер, что и у живых клиентов: несколько сообщений подряд
        # склеятся в один запрос к модели.
        process_lead_buffer.apply_async(
            args=[lead.id, message_id],
            countdown=app_settings.message_buffer_seconds,
        )
        queued = True

    return {"ok": True, "queued": queued, "message_id": message_id, "delay_seconds": app_settings.message_buffer_seconds}


@router.post("/lab/test-users/{lead_pk}/voice")
async def lab_test_user_voice(lead_pk: int, file: UploadFile = File(...), db: Session = Depends(get_db)) -> dict:
    """Inject a voice note from a Laboratory client into the CRM inbox only.

    The file is stored and rendered exactly like a customer voice note. It is
    transcribed before entering the normal buffering/AI pipeline, but never
    reaches amoCRM, WhatsApp, Instagram, or a real client.
    """
    lead = _test_lead_or_404(db, lead_pk)
    content_type = (file.content_type or "").split(";")[0].lower()
    voice_suffixes = {
        "audio/ogg": ".opus", "audio/opus": ".opus", "audio/webm": ".webm",
        "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
        "audio/aiff": ".aiff", "audio/x-aiff": ".aiff",
    }
    suffix = voice_suffixes.get(content_type)
    if not suffix:
        raise HTTPException(415, "Разрешены голосовые OGG, OPUS, WEBM, MP3, M4A и AIFF")
    content = await file.read(15 * 1024 * 1024 + 1)
    if not content or len(content) > 15 * 1024 * 1024:
        raise HTTPException(413, "Файл должен быть не больше 15 МБ")

    media_dir = "/app/media"
    os.makedirs(media_dir, mode=0o750, exist_ok=True)
    filename = f"lab-{uuid4().hex}{suffix}"
    with open(os.path.join(media_dir, filename), "wb") as output:
        output.write(content)
    media_url = f"{app_settings.public_backend_url.rstrip('/')}/media/{filename}"

    transcript = ""
    try:
        transcript = transcribe_audio_bytes(content, file.filename or f'voice{suffix}')
    except Exception:
        # The note still reaches the CRM and can be played. Empty transcript is
        # handled by the existing non-recognition flow in the AI pipeline.
        transcript = ""

    message_id = f"lab-voice:{uuid4().hex}"
    incoming = IncomingMessage(
        raw={"source": "lab", "lead_pk": lead.id, "test_voice": True},
        text=f"[voice] {media_url} {transcript}".strip(),
        direction="incoming",
        chat_id=lead.chat_id or "",
        message_id=message_id,
        client_id=lead.client.amocrm_author_id if lead.client else f"test:{lead.id}",
        client_name=lead.client.name if lead.client else "Тестовый клиент",
        lead_id=lead.amocrm_lead_id,
        source="lab",
        media=media_url,
        attachment_type="voice",
        attachment_link=media_url,
        timestamp=datetime.now(ZoneInfo(app_settings.timezone)),
    )
    _lead, _conversation, is_new = upsert_incoming(db, incoming)
    queued = False
    if is_new and lead.ai_enabled:
        process_lead_buffer.apply_async(
            args=[lead.id, message_id], countdown=app_settings.message_buffer_seconds,
        )
        queued = True
    return {
        "ok": True,
        "queued": queued,
        "message_id": message_id,
        "delay_seconds": app_settings.message_buffer_seconds,
        "media_url": media_url,
        "transcript": transcript,
    }


@router.delete("/lab/test-users/{lead_pk}", status_code=204)
def lab_delete_test_user(lead_pk: int, db: Session = Depends(get_db)) -> None:
    lead = _test_lead_or_404(db, lead_pk)
    client_id = lead.client_id

    # На leads ссылаются десять таблиц, ни одна не объявлена ON DELETE CASCADE,
    # и между собой они тоже связаны: training_examples смотрит на
    # approval_requests, а message_buffer и messages — на conversations.
    # Поэтому порядок строгий: сначала листья графа, потом корни.
    # Вместе с лидом уходят и его строки action_logs — история в терминале
    # лаборатории по этому тестовому клиенту тоже исчезнет.
    try:
        for model in (
            TrainingExample,                     # -> approval_requests, leads
            MessageBuffer, Message,              # -> conversations, leads
            ApprovalRequest,                     # -> leads
            AIUsage, AIExtractedFields, ClientMemory, ConsultationSlot, ActionLog,
            Conversation,                        # -> leads
        ):
            db.query(model).filter(model.lead_id == lead.id).delete(synchronize_session=False)

        db.delete(lead)
        db.flush()

        # Клиент у тестового лида всегда свой, но проверяем — вдруг переиспользовали.
        if client_id and not db.scalar(select(func.count(Lead.id)).where(Lead.client_id == client_id)):
            client = db.get(Client, client_id)
            if client:
                db.delete(client)
        db.commit()
    except Exception as exc:
        db.rollback()
        _log.error("lab_delete_test_user failed lead_pk=%s: %s", lead_pk, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"delete failed: {exc}") from exc


class LabEditReplyRequest(BaseModel):
    original_reply: str
    client_message: str
    edit_prompt: str


@router.post("/lab/edit-reply")
def lab_edit_reply(body: LabEditReplyRequest) -> dict:
    """Rewrite a single Laboratory test reply per a one-off instruction — does not touch the bot's prompt."""
    from app.services.openai_service import ai_edit_reply
    result = ai_edit_reply(body.original_reply, body.client_message, body.edit_prompt)
    return {
        "reply": result.content,
        "tokens": result.total_tokens,
        "cost": round(result.total_cost, 6),
    }


@router.get("/lab/mistake-analysis")
def lab_mistake_analysis(limit: int = 100, db: Session = Depends(get_db)) -> dict:
    """Analyze the last N reviewed dialogues for recurring manager corrections (Laboratory tool)."""
    from app.services.openai_service import analyze_manager_corrections

    rows = db.scalars(
        select(TrainingExample).order_by(desc(TrainingExample.id)).limit(limit)
    ).all()
    edited = [r for r in rows if r.was_edited]
    if not edited:
        return {
            "total_dialogues": len(rows), "edited_count": 0,
            "categories": [], "suggested_prompt_changes": "", "expected_improvement": "",
        }
    examples = [
        {
            "client_message": r.client_message[:500],
            "ai_reply": r.ai_reply[:500],
            "final_reply": r.final_reply[:500],
        }
        for r in edited
    ]
    result = analyze_manager_corrections(examples)
    data = result.content if isinstance(result.content, dict) else {}
    return {
        "total_dialogues": len(rows),
        "edited_count": len(edited),
        "categories": data.get("categories", []),
        "suggested_prompt_changes": data.get("suggested_prompt_changes", ""),
        "expected_improvement": data.get("expected_improvement", ""),
    }


@router.post("/lab/calibrate-from-history")
def lab_calibrate_from_history(db: Session = Depends(get_db)) -> dict:
    """One-time calibration: analyze historically accepted replies (Mar-Jun) for prompt tuning.

    Does NOT touch the live bot_system_prompt — the result is only stored as a
    draft (Setting key bot_system_prompt_draft) for the owner to review. Applying
    it goes through the existing /admin/bot-prompt PATCH the owner already uses.
    """
    from app.services.openai_service import analyze_manager_corrections

    rows = db.scalars(
        select(TrainingExample).where(
            TrainingExample.quality_label == "accepted",
            TrainingExample.created_at >= datetime(2026, 3, 1, tzinfo=ZoneInfo("UTC")),
            TrainingExample.created_at <= datetime(2026, 6, 30, 23, 59, 59, tzinfo=ZoneInfo("UTC")),
        )
    ).all()
    if not rows:
        return {
            "total_examples": 0,
            "categories": [], "suggested_prompt_changes": "", "expected_improvement": "",
        }
    examples = [
        {
            "client_message": r.client_message[:500],
            "ai_reply": r.ai_reply[:500],
            "final_reply": r.final_reply[:500],
        }
        for r in rows
    ]
    result = analyze_manager_corrections(examples)
    data = result.content if isinstance(result.content, dict) else {}
    draft = {
        "categories": data.get("categories", []),
        "suggested_prompt_changes": data.get("suggested_prompt_changes", ""),
        "expected_improvement": data.get("expected_improvement", ""),
    }
    draft_row = db.scalar(select(Setting).where(Setting.key == "bot_system_prompt_draft"))
    draft_value = _json.dumps(draft, ensure_ascii=False)
    if draft_row:
        draft_row.value = draft_value
    else:
        db.add(Setting(key="bot_system_prompt_draft", value=draft_value, is_secret=False))
    db.commit()
    return {"total_examples": len(rows), **draft}


@router.get("/analytics/assisted-leads")
def assisted_leads(db: Session = Depends(get_db)) -> dict:
    """Lead IDs where AI prepared or sent at least one reply.

    CRM joins these IDs with its own deals table, so no customer text or
    personal data crosses the service boundary.
    """
    rows = db.execute(
        select(Lead.amocrm_lead_id)
        .join(ApprovalRequest, ApprovalRequest.lead_id == Lead.id)
        .where(Lead.is_test.is_(False))
        .distinct()
    ).scalars().all()
    return {"lead_ids": rows}


@router.get("/analytics")
def get_analytics(db: Session = Depends(get_db)) -> dict:
    # Hourly distribution of client messages (Bishkek UTC+6)
    hourly_rows = db.execute(text(
        "SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Bishkek') AS hour, COUNT(*) "
        "FROM messages WHERE role='user' GROUP BY hour ORDER BY hour"
    )).fetchall()
    hourly = {int(r[0]): int(r[1]) for r in hourly_rows}
    hourly_full = [{"hour": h, "count": hourly.get(h, 0)} for h in range(24)]

    # Daily message volume (last 30 days)
    daily_rows = db.execute(text(
        "SELECT DATE(created_at AT TIME ZONE 'Asia/Bishkek') AS day, COUNT(*) "
        "FROM messages WHERE role='user' AND created_at >= NOW() - INTERVAL '30 days' "
        "GROUP BY day ORDER BY day"
    )).fetchall()
    daily = [{"date": str(r[0]), "count": int(r[1])} for r in daily_rows]

    # Top problems from extracted fields
    extracted_rows = db.execute(text(
        "SELECT skin_problem FROM ai_extracted_fields WHERE skin_problem IS NOT NULL AND skin_problem != '[]'"
    )).fetchall()
    problem_counter: Counter = Counter()
    for row in extracted_rows:
        problems = row[0] if isinstance(row[0], list) else []
        for p in problems:
            if p:
                problem_counter[p] += 1
    top_problems = [{"problem": k, "count": v} for k, v in problem_counter.most_common(12)]

    # Summary stats
    total_leads = db.scalar(select(func.count()).select_from(Lead)) or 0
    total_messages = db.scalar(
        select(func.count()).select_from(Message).where(Message.role == "user")
    ) or 0
    total_approvals = db.scalar(select(func.count()).select_from(ApprovalRequest)) or 0
    approved = db.scalar(
        select(func.count()).select_from(ApprovalRequest)
        .where(ApprovalRequest.status.in_(["approved", "sent"]))
    ) or 0
    # Approved without editing (ai_reply sent as-is)
    approved_as_is = db.scalar(
        select(func.count()).select_from(ApprovalRequest)
        .where(ApprovalRequest.status.in_(["approved", "sent"]))
        .where(ApprovalRequest.edited_reply.is_(None))
    ) or 0
    rejected = db.scalar(
        select(func.count()).select_from(ApprovalRequest)
        .where(ApprovalRequest.status == "rejected")
    ) or 0
    consultation_confirmed = db.scalar(text(
        "SELECT COUNT(*) FROM ai_extracted_fields WHERE consultation_confirmed = true"
    )) or 0

    # Token usage & cost — overall
    token_row = db.execute(text(
        "SELECT COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(total_tokens),0), COALESCE(SUM(total_cost),0) FROM ai_usage"
    )).one()

    # Per-purpose breakdown
    purpose_rows = db.execute(text(
        "SELECT purpose, COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(total_tokens),0), COALESCE(SUM(total_cost),0), COUNT(*) "
        "FROM ai_usage GROUP BY purpose ORDER BY SUM(total_tokens) DESC"
    )).fetchall()
    usage_by_purpose = [
        {
            "purpose": r[0],
            "prompt_tokens": int(r[1]),
            "completion_tokens": int(r[2]),
            "total_tokens": int(r[3]),
            "total_cost": float(r[4]),
            "calls": int(r[5]),
        }
        for r in purpose_rows
    ]

    provider_rows = db.execute(text(
        "SELECT CASE WHEN lower(model) LIKE 'deepseek%' THEN 'deepseek' "
        "WHEN lower(model) LIKE 'gemini%' THEN 'google' ELSE provider END AS actual_provider, "
        "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(total_tokens),0), COALESCE(SUM(total_cost),0), COUNT(*) "
        "FROM ai_usage GROUP BY actual_provider ORDER BY SUM(total_tokens) DESC"
    )).fetchall()
    usage_by_provider = [
        {
            "provider": r[0],
            "prompt_tokens": int(r[1]),
            "completion_tokens": int(r[2]),
            "total_tokens": int(r[3]),
            "total_cost": float(r[4]),
            "calls": int(r[5]),
        }
        for r in provider_rows
    ]

    # Daily token usage (last 30 days)
    daily_tokens_rows = db.execute(text(
        "SELECT DATE(created_at AT TIME ZONE 'Asia/Bishkek') AS day, "
        "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0) "
        "FROM ai_usage WHERE created_at >= NOW() - INTERVAL '30 days' "
        "GROUP BY day ORDER BY day"
    )).fetchall()
    daily_tokens = [
        {"date": str(r[0]), "prompt_tokens": int(r[1]), "completion_tokens": int(r[2])}
        for r in daily_tokens_rows
    ]

    # Age × problem breakdown
    age_rows = db.execute(text(
        "SELECT skin_problem, age FROM ai_extracted_fields "
        "WHERE skin_problem IS NOT NULL AND skin_problem != '[]'"
    )).fetchall()
    age_problem_counter: dict[tuple, int] = {}
    for row in age_rows:
        problems = row[0] if isinstance(row[0], list) else []
        age_val = (row[1] or "").strip() or "неизвестно"
        for p in problems:
            if p:
                key = (str(p), age_val)
                age_problem_counter[key] = age_problem_counter.get(key, 0) + 1
    age_by_problem = [
        {"problem": k[0], "age": k[1], "count": v}
        for k, v in sorted(age_problem_counter.items(), key=lambda x: -x[1])
    ]

    return {
        "hourly": hourly_full,
        "daily": daily,
        "daily_tokens": daily_tokens,
        "top_problems": top_problems,
        "age_by_problem": age_by_problem,
        "usage_by_purpose": usage_by_purpose,
        "usage_by_provider": usage_by_provider,
        "stats": {
            "total_leads": total_leads,
            "total_messages": total_messages,
            "total_approvals": total_approvals,
            "approved": approved,
            "approved_as_is": int(approved_as_is),
            "rejected": int(rejected),
            "consultation_confirmed": int(consultation_confirmed),
            "prompt_tokens": int(token_row[0]),
            "completion_tokens": int(token_row[1]),
            "total_tokens": int(token_row[2]),
            "total_cost": float(token_row[3]),
        },
    }


# ── Managers ────────────────────────────────────────────────────────────────

class ManagerPayload(BaseModel):
    name: str
    chat_id: str


def _get_managers_setting(db: Session):
    return db.scalar(select(Setting).where(Setting.key == "telegram_managers"))


@router.get("/managers")
def list_managers(db: Session = Depends(get_db)) -> list[dict]:
    row = _get_managers_setting(db)
    if not row or not row.value:
        return []
    try:
        return _json.loads(row.value)
    except Exception:
        return []


@router.post("/managers")
def add_manager(payload: ManagerPayload, db: Session = Depends(get_db)) -> dict:
    row = _get_managers_setting(db)
    managers: list[dict] = []
    if row and row.value:
        try:
            managers = _json.loads(row.value)
        except Exception:
            managers = []
    # Deduplicate by chat_id
    if any(m["chat_id"] == payload.chat_id for m in managers):
        raise HTTPException(400, "Manager with this chat_id already exists")
    managers.append({"name": payload.name, "chat_id": payload.chat_id})
    if row:
        row.value = _json.dumps(managers, ensure_ascii=False)
    else:
        db.add(Setting(key="telegram_managers", value=_json.dumps(managers, ensure_ascii=False), is_secret=False))
    db.commit()
    return {"ok": True, "managers": managers}


@router.delete("/managers/{chat_id}")
def remove_manager(chat_id: str, db: Session = Depends(get_db)) -> dict:
    row = _get_managers_setting(db)
    if not row or not row.value:
        raise HTTPException(404, "Manager not found")
    try:
        managers = _json.loads(row.value)
    except Exception:
        managers = []
    new_managers = [m for m in managers if m["chat_id"] != chat_id]
    if len(new_managers) == len(managers):
        raise HTTPException(404, "Manager not found")
    row.value = _json.dumps(new_managers, ensure_ascii=False)
    db.commit()
    return {"ok": True, "managers": new_managers}


# ── Consultation Slots ───────────────────────────────────────────────────────

WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS_RU = ["", "янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


class SlotStatusUpdate(BaseModel):
    status: str  # "free" | "blocked" | "booked"


class SlotCreate(BaseModel):
    date: str   # "YYYY-MM-DD"
    time: str   # "HH:MM"
    status: str = "blocked"


@router.get("/slots")
def get_slots(days: int = 21, db: Session = Depends(get_db)) -> dict:
    tz = ZoneInfo(app_settings.timezone)
    today = datetime.now(tz).date()

    dates: list[date] = [today + timedelta(days=i) for i in range(days)]

    # Fetch all DB slots for this range
    db_slots = db.scalars(
        select(ConsultationSlot).where(
            ConsultationSlot.date >= dates[0],
            ConsultationSlot.date <= dates[-1],
        )
    ).all()
    slot_map: dict[tuple[date, str], ConsultationSlot] = {
        (s.date, s.time.strftime("%H:%M")): s for s in db_slots
    }

    schedule = []
    for day in dates:
        times = day_slots(day)
        working = is_working_day(day)
        slots = []
        for t in times:
            db_slot = slot_map.get((day, t))
            slots.append({
                "time": t,
                "status": db_slot.status if db_slot else "free",
                "id": db_slot.id if db_slot else None,
                "lead_id": db_slot.lead_id if db_slot else None,
            })
        schedule.append({
            "date": day.isoformat(),
            "label": f"{WEEKDAYS_RU[day.weekday()]} {day.day} {MONTHS_RU[day.month]}",
            "is_working": working,
            "slots": slots,
        })

    return {"schedule": schedule, "interval_minutes": app_settings.consultation_interval_minutes}


@router.post("/slots")
def create_slot(body: SlotCreate, db: Session = Depends(get_db)) -> dict:
    try:
        d = date.fromisoformat(body.date)
        t = time.fromisoformat(body.time)
    except ValueError:
        raise HTTPException(400, "Invalid date or time format")

    existing = db.scalar(
        select(ConsultationSlot).where(
            ConsultationSlot.date == d,
            ConsultationSlot.time == t,
        )
    )
    if existing:
        existing.status = body.status
        db.commit()
        return {"ok": True, "slot": {"id": existing.id, "status": existing.status}}

    slot = ConsultationSlot(date=d, time=t, status=body.status)
    db.add(slot)
    db.commit()
    return {"ok": True, "slot": {"id": slot.id, "status": slot.status}}


@router.patch("/slots/{slot_id}")
def update_slot(slot_id: int, body: SlotStatusUpdate, db: Session = Depends(get_db)) -> dict:
    slot = db.get(ConsultationSlot, slot_id)
    if not slot:
        raise HTTPException(404, "Slot not found")
    slot.status = body.status
    db.commit()
    return {"ok": True, "slot": {"id": slot.id, "status": slot.status}}


@router.delete("/slots/{slot_id}")
def delete_slot(slot_id: int, db: Session = Depends(get_db)) -> dict:
    slot = db.get(ConsultationSlot, slot_id)
    if not slot:
        raise HTTPException(404, "Slot not found")
    db.delete(slot)
    db.commit()
    return {"ok": True}


# ── Reply Templates ──────────────────────────────────────────────────────────

def _load_templates_setting(db: Session) -> Setting | None:
    return db.scalar(select(Setting).where(Setting.key == "reply_templates"))


def _get_templates(db: Session) -> list[dict]:
    row = _load_templates_setting(db)
    if not row or not row.value:
        return []
    try:
        return _json.loads(row.value)
    except Exception:
        return []


def _save_templates(db: Session, templates: list[dict]) -> None:
    row = _load_templates_setting(db)
    if row:
        row.value = _json.dumps(templates, ensure_ascii=False)
    else:
        db.add(Setting(key="reply_templates", value=_json.dumps(templates, ensure_ascii=False), is_secret=False))
    db.commit()


class TemplatePayload(BaseModel):
    name: str
    text: str


@router.get("/templates")
def list_templates(db: Session = Depends(get_db)) -> list[dict]:
    return _get_templates(db)


@router.post("/templates")
def create_template(payload: TemplatePayload, db: Session = Depends(get_db)) -> dict:
    templates = _get_templates(db)
    new_id = max((t.get("id", 0) for t in templates), default=0) + 1
    tpl = {"id": new_id, "name": payload.name.strip(), "text": payload.text.strip()}
    templates.append(tpl)
    _save_templates(db, templates)
    return tpl


@router.patch("/templates/{tpl_id}")
def update_template(tpl_id: int, payload: TemplatePayload, db: Session = Depends(get_db)) -> dict:
    templates = _get_templates(db)
    for t in templates:
        if t.get("id") == tpl_id:
            t["name"] = payload.name.strip()
            t["text"] = payload.text.strip()
            _save_templates(db, templates)
            return t
    raise HTTPException(404, "Template not found")


@router.delete("/templates/{tpl_id}")
def delete_template(tpl_id: int, db: Session = Depends(get_db)) -> dict:
    templates = [t for t in _get_templates(db) if t.get("id") != tpl_id]
    _save_templates(db, templates)
    return {"ok": True}


# ── CSV Export ───────────────────────────────────────────────────────────────

@router.get("/export/leads")
def export_leads(db: Session = Depends(get_db)) -> StreamingResponse:
    rows = db.execute(text(
        "SELECT l.amocrm_lead_id, c.name AS client_name, c.phone, "
        "l.ai_enabled, l.last_message_at, "
        "COUNT(DISTINCT m.id) AS messages, "
        "COUNT(DISTINCT a.id) AS approvals "
        "FROM leads l "
        "LEFT JOIN clients c ON c.id = l.client_id "
        "LEFT JOIN messages m ON m.lead_id = l.id "
        "LEFT JOIN approval_requests a ON a.lead_id = l.id "
        "GROUP BY l.id, c.name, c.phone "
        "ORDER BY l.last_message_at DESC NULLS LAST"
    )).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Lead ID", "Клиент", "Телефон", "AI вкл", "Последнее сообщение", "Сообщений", "AI ответов"])
    for r in rows:
        writer.writerow([r[0], r[1] or "", r[2] or "", "да" if r[3] else "нет",
                         str(r[4])[:19] if r[4] else "", r[5], r[6]])

    output.seek(0)
    filename = f"leads_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── Blacklist ─────────────────────────────────────────────────────────────────

class BlacklistPayload(BaseModel):
    phone: str
    reason: str | None = None


@router.get("/blacklist")
def list_blacklist(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(select(Blacklist).order_by(Blacklist.created_at.desc())).all()
    return [{"id": r.id, "phone": r.phone, "reason": r.reason, "created_at": str(r.created_at)[:19]} for r in rows]


@router.post("/blacklist")
def add_to_blacklist(payload: BlacklistPayload, db: Session = Depends(get_db)) -> dict:
    phone = payload.phone.strip()
    existing = db.scalar(select(Blacklist).where(Blacklist.phone == phone))
    if existing:
        raise HTTPException(400, "Номер уже в черном списке")
    entry = Blacklist(phone=phone, reason=payload.reason)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id, "phone": entry.phone, "reason": entry.reason}


@router.delete("/blacklist/{entry_id}")
def remove_from_blacklist(entry_id: int, db: Session = Depends(get_db)) -> dict:
    entry = db.get(Blacklist, entry_id)
    if not entry:
        raise HTTPException(404, "Не найдено")
    db.delete(entry)
    db.commit()
    return {"ok": True}


# ── Stop Words ────────────────────────────────────────────────────────────────

class StopWordsPayload(BaseModel):
    words: list[str]


@router.get("/stop-words")
def get_stop_words(db: Session = Depends(get_db)) -> dict:
    setting = db.scalar(select(Setting).where(Setting.key == "stop_words"))
    words = [w.strip() for w in setting.value.split(",") if w.strip()] if setting else []
    return {"words": words}


@router.put("/stop-words")
def update_stop_words(payload: StopWordsPayload, db: Session = Depends(get_db)) -> dict:
    value = ", ".join(w.strip().lower() for w in payload.words if w.strip())
    setting = db.scalar(select(Setting).where(Setting.key == "stop_words"))
    if setting:
        setting.value = value
    else:
        db.add(Setting(key="stop_words", value=value))
    db.commit()
    return {"words": [w.strip() for w in value.split(",") if w.strip()]}


# ── Daily Report ──────────────────────────────────────────────────────────────

@router.get("/reports/daily")
def daily_report(days: int = 30, db: Session = Depends(get_db)) -> list[dict]:
    tz = app_settings.timezone
    rows = db.execute(text(f"""
        SELECT
            DATE(created_at AT TIME ZONE '{tz}') AS day,
            COUNT(*) FILTER (WHERE status IN ('pending','edited','stop_word')) AS new_count,
            COUNT(*) FILTER (WHERE status IN ('approved','sent')) AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
            COUNT(*) FILTER (WHERE status = 'saved') AS saved
        FROM approval_requests
        WHERE created_at >= NOW() - INTERVAL '{days} days'
        GROUP BY day
        ORDER BY day DESC
    """)).fetchall()
    return [
        {"day": str(r[0]), "new": int(r[1]), "approved": int(r[2]), "rejected": int(r[3]), "saved": int(r[4])}
        for r in rows
    ]


# ── Analytics: Conversion Funnel ──────────────────────────────────────────────

@router.get("/analytics/funnel")
def analytics_funnel(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(text("""
        SELECT amocrm_stage_name, COUNT(*) AS cnt
        FROM approval_requests
        WHERE amocrm_stage_name IS NOT NULL
        GROUP BY amocrm_stage_name
        ORDER BY cnt DESC
    """)).fetchall()
    total = sum(int(r[1]) for r in rows) or 1
    return [{"stage": r[0], "count": int(r[1]), "pct": round(int(r[1]) * 100 / total)} for r in rows]


# ── Analytics: Manager Efficiency ─────────────────────────────────────────────

@router.get("/analytics/tokens")
def analytics_tokens(db: Session = Depends(get_db)) -> dict:
    """Token usage & cost: today, daily/monthly averages, this year."""
    tz = app_settings.timezone
    row = db.execute(text(f"""
        SELECT
            COALESCE(SUM(total_tokens) FILTER (WHERE (created_at AT TIME ZONE '{tz}')::date = (now() AT TIME ZONE '{tz}')::date), 0),
            COALESCE(SUM(total_cost)   FILTER (WHERE (created_at AT TIME ZONE '{tz}')::date = (now() AT TIME ZONE '{tz}')::date), 0),
            COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0),
            COALESCE(SUM(total_cost)   FILTER (WHERE created_at >= now() - interval '30 days'), 0),
            COALESCE(SUM(total_tokens) FILTER (WHERE date_trunc('year', created_at AT TIME ZONE '{tz}') = date_trunc('year', now() AT TIME ZONE '{tz}')), 0),
            COALESCE(SUM(total_cost)   FILTER (WHERE date_trunc('year', created_at AT TIME ZONE '{tz}') = date_trunc('year', now() AT TIME ZONE '{tz}')), 0),
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(total_cost), 0),
            COUNT(DISTINCT (created_at AT TIME ZONE '{tz}')::date)
        FROM ai_usage
    """)).fetchone()
    today_tok, today_cost, m30_tok, m30_cost, year_tok, year_cost, all_tok, all_cost, active_days = row
    days30 = min(30, max(1, int(active_days)))
    return {
        "today": {"tokens": int(today_tok), "cost": round(float(today_cost), 4)},
        "avg_day": {"tokens": int(m30_tok / days30), "cost": round(float(m30_cost) / days30, 4)},
        "avg_month": {"tokens": int(m30_tok), "cost": round(float(m30_cost), 4)},
        "year": {"tokens": int(year_tok), "cost": round(float(year_cost), 4)},
        "all_time": {"tokens": int(all_tok), "cost": round(float(all_cost), 4)},
    }


@router.get("/analytics/managers")
def analytics_managers(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(text("""
        SELECT
            manager_telegram_id,
            COUNT(*) FILTER (WHERE status IN ('approved','sent') AND edited_reply IS NULL) AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected' AND COALESCE(BTRIM(reject_reason),'') = '') AS rejected_without_reason,
            COUNT(*) FILTER (WHERE status = 'rejected' AND COALESCE(BTRIM(reject_reason),'') != '') AS rejected_with_reason,
            COUNT(*) FILTER (WHERE edited_reply IS NOT NULL) AS edited,
            COUNT(*) FILTER (WHERE status = 'saved') AS saved
        FROM approval_requests
        WHERE manager_telegram_id IS NOT NULL
        GROUP BY manager_telegram_id
        ORDER BY approved DESC
    """)).fetchall()
    # Resolve manager names from settings
    names: dict[str, str] = {}
    mrow = _get_managers_setting(db)
    if mrow and mrow.value:
        try:
            names = {str(m["chat_id"]): m.get("name", "") for m in _json.loads(mrow.value)}
        except Exception:
            names = {}
    manual_rows = db.execute(text("""
        SELECT COALESCE(request_payload->>'manager_id', request_payload->>'manager_name') AS manager_id,
               COUNT(*)
        FROM action_logs
        WHERE action = 'operator.send_message' AND status = 'success'
          AND COALESCE(request_payload->>'manager_id', request_payload->>'manager_name') IS NOT NULL
        GROUP BY 1
    """)).fetchall()
    manual_by_manager = {str(row[0]): int(row[1]) for row in manual_rows}
    result = []
    seen: set[str] = set()
    for r in rows:
        raw_id = str(r[0])
        display_id = names.get(raw_id, raw_id)
        approved = int(r[1])
        rejected_without_reason = int(r[2])
        rejected_with_reason = int(r[3])
        edited = int(r[4])
        saved = int(r[5])
        manual = manual_by_manager.get(raw_id, 0) + manual_by_manager.get(display_id, 0)
        points = approved * 2 + rejected_without_reason + rejected_with_reason * 4 + manual * 8 + edited * 10
        result.append({
            "manager_id": display_id,
            "approved": approved,
            "rejected": rejected_without_reason + rejected_with_reason,
            "rejected_without_reason": rejected_without_reason,
            "rejected_with_reason": rejected_with_reason,
            "edited": edited,
            "manual": manual,
            "saved": saved,
            "points": points,
        })
        seen.update({raw_id, display_id})
    for manager_id, manual in manual_by_manager.items():
        if manager_id in seen:
            continue
        result.append({
            "manager_id": names.get(manager_id, manager_id), "approved": 0, "rejected": 0,
            "rejected_without_reason": 0, "rejected_with_reason": 0, "edited": 0,
            "manual": manual, "saved": 0, "points": manual * 8,
        })
    return sorted(result, key=lambda item: (-item["points"], item["manager_id"]))


# ── Analytics: Best AI Replies ────────────────────────────────────────────────

@router.get("/analytics/best-replies")
def analytics_best_replies(limit: int = 20, db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(
        select(ApprovalRequest)
        .where(
            ApprovalRequest.status.in_(["approved", "sent"]),
            ApprovalRequest.edited_reply.is_(None),
        )
        .order_by(ApprovalRequest.created_at.desc())
        .limit(limit)
    ).all()
    result = []
    for a in rows:
        lead = db.get(Lead, a.lead_id)
        result.append({
            "id": a.id,
            "lead_id": lead.amocrm_lead_id if lead else "",
            "client_message": a.client_message[:200] if a.client_message else "",
            "ai_reply": a.ai_reply[:300] if a.ai_reply else "",
            "created_at": str(a.created_at)[:19],
        })
    return result
