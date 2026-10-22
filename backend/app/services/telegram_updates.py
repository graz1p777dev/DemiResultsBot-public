"""Durable Telegram update receipts. Processing/uncertain updates never replay I/O."""
import hashlib
import json
import secrets
from datetime import datetime, timezone
from functools import wraps

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.entities import Setting
from app.services import telegram


def deduplicate(handler):
    @wraps(handler)
    async def wrapped(secret, request, db):
        expected = settings.telegram_webhook_secret
        if not expected or not secrets.compare_digest(secret.encode(), expected.encode()):
            raise HTTPException(401, "invalid telegram webhook secret")
        payload = await request.json()
        if not isinstance(payload, dict) or type(payload.get("update_id")) is not int or not 0 <= payload["update_id"] < 2**63:
            raise HTTPException(400, "invalid telegram update id")
        event = payload.get("callback_query") or payload.get("message") or {}
        if not isinstance(event, dict):
            raise HTTPException(400, "invalid telegram event")
        actor = str((event.get("from") or {}).get("id", ""))
        # Resolve DB-managed actors exactly as the handler does, before persisting
        # an update ID: an unauthorized request must not reserve a valid update.
        managers = db.scalar(select(Setting).where(Setting.key == "telegram_managers"))
        extra = set()
        if managers:
            try:
                extra = {str(m["chat_id"]) for m in json.loads(managers.value) if m.get("chat_id")}
            except (ValueError, KeyError, TypeError):
                pass
        if not telegram.is_authorized_manager(actor, extra_allowed=extra):
            return {"ok": False, "error": "unauthorized_manager"}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        key = f"telegram_update:{payload['update_id']}"
        receipt = {"state": "processing", "digest": digest,
                   "received_at": datetime.now(timezone.utc).isoformat()}
        db.add(Setting(key=key, value=json.dumps(receipt), is_secret=False))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.scalar(select(Setting).where(Setting.key == key))
            saved = json.loads(existing.value) if existing else {}
            if saved.get("digest") != digest:
                raise HTTPException(409, "telegram update id conflict")
            # Acknowledge retries without running the handler. The operator can
            # inspect stuck processing/uncertain receipts through admin diagnostics.
            return {"ok": True, "duplicate": True, "state": saved.get("state")}
        try:
            result = await handler(secret, request, db)
        except BaseException:
            db.rollback()
            row = db.scalar(select(Setting).where(Setting.key == key))
            if row:
                row.value = json.dumps({**receipt, "state": "uncertain"})
                db.commit()
            raise
        row = db.scalar(select(Setting).where(Setting.key == key))
        row.value = json.dumps({**receipt, "state": "completed"})
        db.commit()
        return result
    return wrapped
