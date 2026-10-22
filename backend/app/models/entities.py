from datetime import date, datetime, time

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CrmUser(Base, TimestampMixin):
    __tablename__ = "crm_users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Client(Base, TimestampMixin):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    amocrm_author_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(64))
    source: Mapped[str | None] = mapped_column(String(128))


class Lead(Base, TimestampMixin):
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(primary_key=True)
    amocrm_lead_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"))
    chat_id: Mapped[str | None] = mapped_column(String(255), index=True)
    contact_id: Mapped[str | None] = mapped_column(String(128))
    status_id: Mapped[int | None] = mapped_column(BigInteger)
    ai_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Лид из AI-лаборатории: пайплайн отрабатывает целиком, но наружу
    # (amoCRM, Google Sheets) ничего не уходит. См. _is_test в pipeline.py.
    is_test: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unread_count: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    draft_text: Mapped[str | None] = mapped_column(Text)
    responsible_manager: Mapped[str | None] = mapped_column(String(255), index=True)
    client: Mapped[Client | None] = relationship()


class Conversation(Base, TimestampMixin):
    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("lead_id", "chat_id", name="uq_conversation_lead_chat"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    chat_id: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(64), default="open")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    message_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    role: Mapped[str] = mapped_column(String(32))
    direction: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    message_type: Mapped[str | None] = mapped_column(String(64))
    media_url: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="stored")
    raw_payload: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MessageBuffer(Base):
    __tablename__ = "message_buffer"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"))
    message_id: Mapped[str] = mapped_column(String(255), unique=True)
    text: Mapped[str] = mapped_column(Text)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    processed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClientMemory(Base):
    __tablename__ = "client_memory"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("leads.id"))
    key: Mapped[str] = mapped_column(String(128))
    value: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(64), default="ai")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ActionLog(Base):
    __tablename__ = "action_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("leads.id"), index=True)
    action: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(64), index=True)
    request_payload: Mapped[dict | None] = mapped_column(JSONB)
    response_payload: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AIExtractedFields(Base):
    __tablename__ = "ai_extracted_fields"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    skin_problem: Mapped[list] = mapped_column(JSONB, default=list)
    age: Mapped[str | None] = mapped_column(String(32))
    consultation_format: Mapped[str | None] = mapped_column(String(64))
    city: Mapped[str | None] = mapped_column(String(64))
    experience: Mapped[str | None] = mapped_column(String(64))
    consultation_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    consultation_date: Mapped[str | None] = mapped_column(String(16))
    consultation_time: Mapped[str | None] = mapped_column(String(8))
    name: Mapped[str | None] = mapped_column(String(255))
    contacts: Mapped[str | None] = mapped_column(String(255))
    raw_output: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AIUsage(Base):
    __tablename__ = "ai_usage"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("leads.id"), index=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id"))
    provider: Mapped[str] = mapped_column(String(64), default="openai")
    model: Mapped[str] = mapped_column(String(128))
    purpose: Mapped[str] = mapped_column(String(64), index=True)
    prompt_tokens: Mapped[int] = mapped_column(default=0)
    completion_tokens: Mapped[int] = mapped_column(default=0)
    total_tokens: Mapped[int] = mapped_column(default=0)
    input_cost: Mapped[float] = mapped_column(default=0)
    output_cost: Mapped[float] = mapped_column(default=0)
    total_cost: Mapped[float] = mapped_column(default=0)
    latency_ms: Mapped[int | None] = mapped_column()
    raw_usage: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    chat_id: Mapped[str] = mapped_column(String(255), index=True)
    client_message: Mapped[str] = mapped_column(Text)
    ai_reply: Mapped[str] = mapped_column(Text)
    edited_reply: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    manager_telegram_id: Mapped[str | None] = mapped_column(String(128), index=True)
    telegram_message_id: Mapped[str | None] = mapped_column(String(512))
    extracted_fields: Mapped[dict | None] = mapped_column(JSONB)
    amocrm_pipeline_id: Mapped[int | None] = mapped_column(BigInteger)
    amocrm_status_id: Mapped[int | None] = mapped_column(BigInteger)
    amocrm_stage_name: Mapped[str | None] = mapped_column(String(255))
    conversation_summary: Mapped[str | None] = mapped_column(Text)
    client_message_translation: Mapped[str | None] = mapped_column(Text)
    ai_reply_translation: Mapped[str | None] = mapped_column(Text)
    ai_reasoning: Mapped[str | None] = mapped_column(Text)
    reject_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TrainingExample(Base):
    __tablename__ = "training_examples"

    id: Mapped[int] = mapped_column(primary_key=True)
    approval_request_id: Mapped[int] = mapped_column(ForeignKey("approval_requests.id"), index=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id"), index=True)
    client_message: Mapped[str] = mapped_column(Text)
    ai_reply: Mapped[str] = mapped_column(Text)
    final_reply: Mapped[str] = mapped_column(Text)
    was_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    manager_telegram_id: Mapped[str | None] = mapped_column(String(128), index=True)
    amocrm_stage_name: Mapped[str | None] = mapped_column(String(255))
    extracted_fields: Mapped[dict | None] = mapped_column(JSONB)
    quality_label: Mapped[str] = mapped_column(String(64), default="accepted")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConsultationSlot(Base):
    __tablename__ = "consultation_slots"
    __table_args__ = (UniqueConstraint("date", "time", name="uq_consultation_slot_date_time"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    time: Mapped[time] = mapped_column(Time)
    status: Mapped[str] = mapped_column(String(32), default="free")
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("leads.id"))
    source: Mapped[str] = mapped_column(String(64), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Setting(Base):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    value: Mapped[str] = mapped_column(Text)
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Blacklist(Base):
    __tablename__ = "blacklists"

    id: Mapped[int] = mapped_column(primary_key=True)
    phone: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CopilotConversation(Base, TimestampMixin):
    __tablename__ = "copilot_conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(255), default="Новый чат")


class CopilotMessage(Base):
    __tablename__ = "copilot_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("copilot_conversations.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    buttons: Mapped[list | None] = mapped_column(JSONB)
    quick_actions: Mapped[list | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CopilotPendingAction(Base):
    __tablename__ = "copilot_pending_actions"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("copilot_conversations.id"), index=True)
    tool_name: Mapped[str] = mapped_column(String(128))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    amount: Mapped[float] = mapped_column()
    currency: Mapped[str] = mapped_column(String(8), default="KGS")
    category: Mapped[str | None] = mapped_column(String(128))
    expense_date: Mapped[date] = mapped_column(Date, index=True)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConsultationReminder(Base, TimestampMixin):
    """Tracks per-consultation reminder cards sent to Telegram managers."""
    __tablename__ = "consultation_reminders"

    id: Mapped[int] = mapped_column(primary_key=True)
    sheet_name: Mapped[str] = mapped_column(String(128))
    row_number: Mapped[int] = mapped_column()
    consultation_date: Mapped[str] = mapped_column(String(16))
    consultation_time: Mapped[str] = mapped_column(String(8))
    client_name: Mapped[str | None] = mapped_column(String(255))
    client_phone: Mapped[str | None] = mapped_column(String(64))
    lead_id_amo: Mapped[str | None] = mapped_column(String(128))
    telegram_message_ids: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    notify_30min_sent: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
