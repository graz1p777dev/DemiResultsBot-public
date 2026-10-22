from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import ApprovalRequest, Client, Conversation, Lead, Message, MessageBuffer
from app.schemas.amocrm import IncomingMessage


def mark_manager_takeover(db: Session, lead: Lead, answered_at: datetime | None = None) -> int:
    """Stop AI work after a human starts talking to this client.

    The caller owns the transaction so the manager message and the takeover
    state become visible together.
    """
    answered_at = answered_at or datetime.now(ZoneInfo("UTC"))
    lead.ai_enabled = False

    pending = db.scalars(
        select(ApprovalRequest).where(
            ApprovalRequest.lead_id == lead.id,
            ApprovalRequest.status.in_(("pending", "edited")),
        )
    ).all()
    for approval in pending:
        approval.status = "answered_external"
        approval.approved_at = answered_at

    buffered = db.scalars(
        select(MessageBuffer).where(
            MessageBuffer.lead_id == lead.id,
            MessageBuffer.processed.is_(False),
        )
    ).all()
    for item in buffered:
        item.processed = True
    return len(pending)


def store_outgoing_message(db: Session, incoming: IncomingMessage) -> bool:
    """Store a message the human consultant wrote directly in amoCRM.

    Returns True if a new consultant (role="manager") message was stored.
    De-duplicates against the bot's own outgoing echo so bot replies are
    not shown twice.
    """
    if incoming.message_id and db.scalar(select(Message).where(Message.message_id == incoming.message_id)):
        return False
    lead = db.scalar(select(Lead).where(Lead.amocrm_lead_id == incoming.lead_id))
    if not lead:
        return False

    text = incoming.text
    photo_url = incoming.attachment_link or incoming.media or None
    if not text and photo_url:
        text = f"[{incoming.attachment_type or 'picture'}] {photo_url}"
    if not text:
        return False

    # Skip the bot's own message echoing back from amoCRM (same text, sent recently)
    echo = db.scalar(
        select(Message).where(
            Message.lead_id == lead.id,
            Message.role.in_(["assistant", "manager"]),
            Message.text == text,
            Message.created_at >= incoming.timestamp - timedelta(minutes=15),
        )
    )
    if echo:
        return False

    conversation = db.scalar(select(Conversation).where(Conversation.lead_id == lead.id))
    if not conversation:
        conversation = Conversation(lead_id=lead.id, chat_id=incoming.chat_id)
        db.add(conversation)
        db.flush()

    db.add(
        Message(
            conversation_id=conversation.id,
            lead_id=lead.id,
            message_id=incoming.message_id or None,
            role="manager",
            direction="outgoing",
            text=text,
            message_type=incoming.attachment_type or "text",
            media_url=incoming.attachment_link,
            status="stored",
            raw_payload=incoming.raw,
        )
    )
    if not lead.last_message_at or incoming.timestamp > lead.last_message_at:
        lead.last_message_at = incoming.timestamp
    mark_manager_takeover(db, lead, incoming.timestamp)
    db.commit()
    return True


def upsert_incoming(db: Session, incoming: IncomingMessage) -> tuple[Lead, Conversation, bool]:
    existing = db.scalar(select(Message).where(Message.message_id == incoming.message_id))
    if existing:
        return db.get(Lead, existing.lead_id), db.get(Conversation, existing.conversation_id), False  # type: ignore

    client = db.scalar(select(Client).where(Client.amocrm_author_id == incoming.client_id))
    if not client:
        client = Client(
            amocrm_author_id=incoming.client_id,
            name=incoming.client_name,
            phone=incoming.contact_id or None,
            source=incoming.source,
        )
        db.add(client)
        db.flush()
    elif not client.phone and incoming.contact_id:
        client.phone = incoming.contact_id

    lead = db.scalar(select(Lead).where(Lead.amocrm_lead_id == incoming.lead_id))
    if not lead:
        lead = Lead(
            amocrm_lead_id=incoming.lead_id,
            client_id=client.id,
            chat_id=incoming.chat_id,
            contact_id=incoming.contact_id,
            last_message_at=incoming.timestamp,
        )
        db.add(lead)
        db.flush()
    else:
        lead.chat_id = incoming.chat_id or lead.chat_id
        lead.contact_id = incoming.contact_id or lead.contact_id
        lead.last_message_at = incoming.timestamp

    lead.unread_count = (lead.unread_count or 0) + 1

    conversation = db.scalar(
        select(Conversation).where(
            Conversation.lead_id == lead.id,
            Conversation.chat_id == incoming.chat_id,
        )
    )
    if not conversation:
        conversation = Conversation(lead_id=lead.id, chat_id=incoming.chat_id)
        db.add(conversation)
        db.flush()

    text = incoming.text
    photo_url = incoming.attachment_link or incoming.media or None
    if not text and photo_url:
        text = f"[{incoming.attachment_type or 'picture'}] {photo_url}"

    db.add(
        Message(
            conversation_id=conversation.id,
            lead_id=lead.id,
            message_id=incoming.message_id,
            role="user",
            direction="incoming",
            text=text,
            message_type=incoming.attachment_type or "text",
            media_url=incoming.attachment_link,
            status="queued",
            raw_payload=incoming.raw,
        )
    )
    db.add(
        MessageBuffer(
            lead_id=lead.id,
            conversation_id=conversation.id,
            message_id=incoming.message_id,
            text=text,
            timestamp=incoming.timestamp,
        )
    )
    db.commit()
    return lead, conversation, True
