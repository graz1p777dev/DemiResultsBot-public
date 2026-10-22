"""Persist send intent before I/O. Unknown outcomes are held, never auto-replayed.

Uses existing messages/JSONB schema. No claim of provider-side exactly-once:
Green does not supply an idempotency contract for this transport.
"""
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.models.entities import Message
from app.services.outgoing import split_outgoing_messages


def reserve(db, lead_id, conversation_id, trigger, reply, approval_id=None, extracted=None):
    parts = split_outgoing_messages(reply)
    if not parts:
        raise ValueError("Cannot reserve an empty reply")
    message = db.scalar(select(Message).where(Message.message_id == f"ai:{trigger}"))
    if message:
        return message
    message = Message(
        lead_id=lead_id, conversation_id=conversation_id, message_id=f"ai:{trigger}",
        role="assistant", direction="outgoing", text="\n\n".join(parts), status="pending_dispatch",
        raw_payload={"outbox": {"version": 1, "state": "ready", "parts": parts,
            "approval_id": approval_id, "extracted": extracted,
            "reserved_at": datetime.now(timezone.utc).isoformat()}},
    )
    db.add(message)
    db.flush()  # Caller commits together with approval CAS, before any external I/O.
    return message


def claim(db, message):
    raw = dict(message.raw_payload or {})
    intent = dict(raw.get("outbox") or {})
    if intent.get("state") != "ready":
        return False
    intent.update(state="sending", started_at=datetime.now(timezone.utc).isoformat())
    changed = db.execute(update(Message).where(
        Message.id == message.id, Message.status == "pending_dispatch",
    ).values(status="dispatching", raw_payload={**raw, "outbox": intent}))
    if changed.rowcount != 1:
        db.rollback()
        return False
    db.commit()
    db.refresh(message)
    return True


def checkpoint(db, message, state, **details):
    # Delivery callbacks also update JSONB. Lock + reload before merging so their
    # receipts are preserved rather than overwritten by a stale ORM instance.
    db.refresh(message, with_for_update=True)
    raw = dict(message.raw_payload or {})
    intent = dict(raw.get("outbox") or {})
    intent.update(state=state, **details)
    raw["outbox"] = intent
    message.raw_payload = raw
    db.commit()


def complete(message):
    intent = (message.raw_payload or {}).get("outbox")
    if intent:
        return intent.get("state") == "completed"
    # Legacy reservations may contain only a subset of multipart provider IDs.
    raw = message.raw_payload or {}
    ids = raw.get("green_message_ids", [])
    if raw.get("provider") == "green_api" and len(ids) < raw.get("green_expected_parts", len(ids)):
        return False
    return message.status in {"sent", "queued", "delivered", "read"}
