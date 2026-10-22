"""Actual backend handlers + isolated SQLite rows; all providers are mocked.

SQLite is only a workflow fixture, not a substitute for PostgreSQL JSONB/locking QA.
"""
from contextlib import ExitStack
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.api import admin, webhooks
from app.core.admin_auth import admin_auth_middleware
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.entities import ApprovalRequest, ActionLog, Lead, Message, MessageBuffer, Setting, TrainingExample
from app.services.openai_service import AIResult
from app.services.reply_hours import reply_hours_policy
from app.tasks import pipeline


@compiles(JSONB, "sqlite")
def sqlite_jsonb(_type, _compiler, **_kw):
    return "JSON"


@pytest.fixture
def flow(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    app = FastAPI()
    app.middleware("http")(admin_auth_middleware)
    app.include_router(admin.router)
    app.include_router(webhooks.router)

    def database():
        with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = database
    state = SimpleNamespace(sessions=sessions, day="2026-10-21T12:00:00", sent=[], cards=[])
    def policy():
        return reply_hours_policy(datetime.fromisoformat(state.day).replace(tzinfo=ZoneInfo("Asia/Bishkek")))
    def provider(*args):
        state.sent.append(args)
        return {"ok": True, "provider": "green_api", "messageId": f"mock-green-{len(state.sent)}", "status": "queued"}
    def card(*args, **kw):
        state.cards.append(args[0].id)
        return {"ok": True, "_message_ids": '{"111":"222"}'}
    with sessions() as db:
        db.add_all([Setting(key="approval_channel", value="both"),
                    Setting(key="telegram_managers", value='[{"chat_id":"111","name":"Тестовый менеджер"}]')])
        db.commit()
    with ExitStack() as stack:
        for obj, key, value in [
            (pipeline, "SessionLocal", sessions), (pipeline, "_reply_hours", policy),
            (settings, "reply_hours_enabled", True), (settings, "human_approval_enabled", False),
            (settings, "admin_api_key", "local-test-key"),
            (settings, "telegram_webhook_secret", "local-telegram-secret"),
            (settings, "telegram_manager_chat_id", "111"),
            (settings, "telegram_allowed_manager_ids", "111"),
            (pipeline.crm_notify, "send_channel_message", Mock(side_effect=provider)),
            (pipeline.crm_notify, "notify", Mock()), (pipeline.crm_notify, "sync_deal", Mock()),
            (pipeline, "move_lead_status", Mock()), (pipeline, "_lead_stage_snapshot", Mock(return_value={})),
            (pipeline, "_count_repeat_leads", Mock(return_value=0)),
            (pipeline, "check_consultation_slots", Mock(return_value={"free_slots": []})),
            (pipeline, "classify_sales_intent", Mock(return_value=AIResult(content={"is_sales": True}, model="deterministic", purpose="test"))),
            (pipeline, "generate_reply", Mock(return_value=AIResult(content="Здравствуйте, это локальный черновик.", model="deterministic", purpose="test"))),
            (pipeline, "verify_reply", Mock(side_effect=lambda dialogue, reply, **kwargs: (reply, None))),
            (pipeline, "extract_fields", Mock(return_value=AIResult(content={}, model="deterministic", purpose="test"))),
            (pipeline, "detect_and_translate", Mock(return_value={"client_translation": None, "ai_reply_translation": None})),
            (pipeline, "summarize_dialogue", Mock(return_value=("", None))),
            (pipeline, "_maybe_calibrate_prompt", Mock()),
            (pipeline.telegram, "send_approval_card", Mock(side_effect=card)),
            (pipeline.telegram, "edit_approval_card", Mock(return_value={"ok": True})),
            (pipeline.telegram, "send_text", Mock(return_value={"ok": True})),
            (pipeline.telegram, "answer_callback", Mock(return_value={"ok": True})),
            (admin.process_lead_buffer, "apply_async", Mock()),
        ]:
            stack.enter_context(patch.object(obj, key, value))
        state.client = TestClient(app)
        state.policy = policy
        yield state
    engine.dispose()


def incoming(flow, identifier="in-1", text="Как к вам записаться?"):
    body = {"lead_id": "local-lead", "client_id": "local-client", "client_name": "Тестовый клиент",
            "chat_id": "996000000000@c.us", "message_id": identifier, "text": text,
            "source": "whatsapp_green", "timestamp": flow.day + "+06:00"}
    return flow.client.post("/admin/crm/incoming", json=body, headers={"X-Admin-API-Key": "local-test-key"})


def process(flow, trigger="in-1"):
    with flow.sessions() as db:
        lead = db.scalar(select(Lead))
        lead_id = lead.id
    pipeline.process_lead_buffer(lead_id, trigger)
    return lead_id


def test_incoming_auth_storage_dedup_and_enqueue(flow):
    assert flow.client.post("/admin/crm/incoming", json={}).status_code == 401
    assert incoming(flow).json()["queued"] is True
    assert incoming(flow).json()["queued"] is False
    assert admin.process_lead_buffer.apply_async.call_count == 1
    with flow.sessions() as db:
        assert len(db.scalars(select(Message)).all()) == 1
        assert len(db.scalars(select(MessageBuffer)).all()) == 1


def test_day_creates_telegram_draft_never_autosends_even_if_env_disabled(flow):
    incoming(flow)
    process(flow)
    assert flow.sent == []
    assert len(flow.cards) == 1
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        assert approval.status == "pending"
        assert approval.telegram_message_id == '{"111":"222"}'
        assert db.scalar(select(MessageBuffer)).processed


def test_edit_separate_approve_actor_audit_and_no_duplicate(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        assert pipeline.apply_edited_reply(db, approval.id, "111", "Ответ после проверки сотрудником.")
        assert flow.sent == []
        assert pipeline.approve_request(db, approval.id, "111")
        assert not pipeline.approve_request(db, approval.id, "111")
        assert not pipeline.apply_edited_reply(db, approval.id, "111", "Поздняя правка")
        assert not pipeline.reject_request(db, approval.id, "111", "Поздний отказ")
        assert approval.status == "sent"
        assert approval.manager_telegram_id == "111"
        assert approval.approved_at is not None
        example = db.scalar(select(TrainingExample))
        assert example.was_edited and example.manager_telegram_id == "111"
        audit = db.scalar(select(ActionLog).where(ActionLog.action == "telegram.approval_approved"))
        assert audit.request_payload["actor_id"] == "111"
    assert len(flow.sent) == 1
    assert flow.sent[0][-1] == "Ответ после проверки сотрудником."


def test_reject_does_not_send_and_retains_actor(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        assert pipeline.reject_request(db, approval.id, "111", "Нужна консультация сотрудника")
        assert not pipeline.approve_request(db, approval.id, "111")
        assert approval.manager_telegram_id == "111"
        assert approval.status == "rejected"
    assert flow.sent == []


def test_night_once_across_midnight_preserves_inbox_then_morning_approval(flow):
    flow.day = "2026-10-21T21:00:00"
    incoming(flow)
    process(flow)
    assert len(flow.sent) == 1
    assert "завтра с 10:00" in flow.sent[0][-1]
    pipeline.classify_sales_intent.assert_not_called()
    assert flow.cards == []
    flow.day = "2026-10-22T00:01:00"
    incoming(flow, "in-2", "И еще один вопрос")
    process(flow, "in-2")
    assert len(flow.sent) == 1
    with flow.sessions() as db:
        assert all(not row.processed for row in db.scalars(select(MessageBuffer)).all())
    flow.day = "2026-10-22T10:00:00"
    pipeline.resume_night_inbox()
    assert len(flow.sent) == 1
    assert len(flow.cards) == 1
    with flow.sessions() as db:
        assert all(row.processed for row in db.scalars(select(MessageBuffer)).all())
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%"))) is None


def test_manual_takeover_blocks_night_and_model(flow):
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    with flow.sessions() as db:
        db.scalar(select(Lead)).ai_enabled = False
        db.commit()
    process(flow)
    assert not flow.sent and not flow.cards
    pipeline.classify_sales_intent.assert_not_called()


def test_ambiguous_night_failure_is_not_blindly_retried(flow):
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    pipeline.crm_notify.send_channel_message.side_effect = TimeoutError("mock timeout")
    process(flow)
    process(flow)
    assert pipeline.crm_notify.send_channel_message.call_count == 1
    with flow.sessions() as db:
        assert db.scalar(select(Message).where(Message.direction == "outgoing")).status == "send_failed"
        assert not db.scalar(select(MessageBuffer)).processed


def test_stale_approval_cannot_claim_after_other_manager_sent(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as stale, flow.sessions() as current:
        a = stale.scalar(select(ApprovalRequest))
        assert a.status == "pending"
        assert pipeline.approve_request(current, a.id, "111")
        assert not pipeline.approve_request(stale, a.id, "222")
    assert len(flow.sent) == 1


def test_telegram_card_failure_keeps_request_available_in_crm(flow):
    with flow.sessions() as db:
        db.scalar(select(Setting).where(Setting.key == "approval_channel")).value = "telegram"
        db.commit()
    pipeline.telegram.send_approval_card.side_effect = RuntimeError("mock Telegram unavailable")
    incoming(flow)
    process(flow)
    assert not flow.sent
    with flow.sessions() as db:
        assert db.scalar(select(ApprovalRequest)).status == "pending"
        assert db.scalar(select(ActionLog).where(ActionLog.action == "telegram.approval_request")).status == "error"


def test_actual_telegram_webhook_authorization_and_approve_replay(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
    def callback(actor="111", secret="local-telegram-secret"):
        return flow.client.post(f"/webhooks/telegram/{secret}", json={
            "callback_query": {"id": "test-callback", "from": {"id": int(actor)},
                "message": {"chat": {"id": 111}}, "data": f"approve:{approval_id}"},
        })
    assert callback(secret="wrong").status_code == 401
    assert callback(actor="999").json()["error"] == "unauthorized_manager"
    assert not flow.sent
    assert callback().json()["ok"] is True
    assert callback().json()["ok"] is False
    assert len(flow.sent) == 1
