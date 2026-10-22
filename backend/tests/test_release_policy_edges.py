"""Offline regression gates for release queue recovery and consultation edits."""
from unittest.mock import Mock

import pytest
from sqlalchemy import event, select

from test_local_green_workflow import flow, incoming, process
from app.models.entities import ApprovalRequest, MessageBuffer, Setting
from app.services import openai_service
from app.services.openai_service import AIResult
from app.tasks import pipeline


def test_morning_draft_failure_retains_recoverable_buffers(flow):
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    process(flow)
    flow.day = "2026-10-22T10:00:00"
    pipeline.detect_and_translate.side_effect = RuntimeError("mock translation outage")
    pipeline.resume_night_inbox()
    with flow.sessions() as db:
        assert db.scalar(select(ApprovalRequest)) is None
        assert not db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%")))
    pipeline.detect_and_translate.side_effect = None
    pipeline.resume_night_inbox()
    pipeline.resume_night_inbox()
    assert len(flow.cards) == 1
    assert len(flow.sent) == 1  # Only the original fixed night notice.
    with flow.sessions() as db:
        assert db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%"))) is None


def test_bad_marker_does_not_starve_healthy_night_queue(flow):
    with flow.sessions() as db:
        db.add(Setting(key="night_resume:broken", value="not-an-integer"))
        db.commit()
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    process(flow)
    flow.day = "2026-10-22T10:00:00"
    pipeline.resume_night_inbox()
    assert len(flow.cards) == 1


@pytest.mark.parametrize("branch", ["normal", "purchase", "stop_word", "ai_error"])
def test_approval_insert_failure_does_not_commit_processed_buffers(flow, monkeypatch, branch):
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    process(flow)
    flow.day = "2026-10-22T10:00:00"
    if branch == "purchase":
        pipeline.classify_sales_intent.return_value = AIResult(
            content={"is_sales": True, "is_purchase": True}, model="deterministic", purpose="test")
        monkeypatch.setattr(pipeline, "generate_purchase_template", Mock(return_value=("Шаблон", None)))
    elif branch == "stop_word":
        monkeypatch.setattr(pipeline, "_check_stop_words", Mock(return_value="тест"))
    elif branch == "ai_error":
        pipeline.generate_reply.side_effect = RuntimeError("mock model unavailable")

    def fail_insert(db, *_args):
        if any(isinstance(row, ApprovalRequest) for row in db.new):
            raise RuntimeError("mock approval insert failure")

    event.listen(flow.sessions, "before_flush", fail_insert)
    try:
        pipeline.resume_night_inbox()
    finally:
        event.remove(flow.sessions, "before_flush", fail_insert)
    with flow.sessions() as db:
        assert db.scalar(select(ApprovalRequest)) is None
        assert not db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%")))
    assert flow.cards == []
    assert len(flow.sent) == 1


def test_explicit_night_approval_is_allowed_but_sweep_does_not_generate(flow):
    incoming(flow)
    process(flow)
    incoming(flow, "followup", "Еще вопрос")
    process(flow, "followup")
    flow.day = "2026-10-21T23:00:00"
    with flow.sessions() as db:
        assert pipeline.approve_request(db, db.scalar(select(ApprovalRequest.id)), "111")
    pipeline.generate_reply.reset_mock()
    pipeline.resume_night_inbox()
    pipeline.generate_reply.assert_not_called()
    assert len(flow.cards) == 1
    assert len(flow.sent) == 1


@pytest.mark.parametrize("decision", ["reject", "save", "approve"])
def test_daytime_followup_is_resumed_after_pending_approval_resolves(flow, decision):
    incoming(flow)
    process(flow)
    incoming(flow, "followup", "Еще вопрос: какова цена?")
    process(flow, "followup")
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        if decision == "reject":
            assert pipeline.reject_request(db, approval.id, "111", "Нужен новый ответ")
        elif decision == "save":
            assert pipeline.save_request(db, approval.id, "111")
        else:
            assert pipeline.approve_request(db, approval.id, "111")
    pipeline.resume_night_inbox()
    pipeline.resume_night_inbox()
    assert len(flow.cards) == 2
    assert len(flow.sent) == (1 if decision == "approve" else 0)
    with flow.sessions() as db:
        assert all(row.processed for row in db.scalars(select(MessageBuffer)))


@pytest.mark.parametrize("terminal", ["sent", "rejected", "saved", "approved"])
def test_consult_cannot_reopen_card_closed_during_ai(flow, monkeypatch, terminal):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))

    def close_during_ai(*args):
        with flow.sessions() as db:
            approval = db.get(ApprovalRequest, approval_id)
            approval.status = terminal
            approval.manager_telegram_id = "222"
            db.commit()
        return AIResult(content="Поздняя консультация", model="deterministic", purpose="test")

    monkeypatch.setattr(openai_service, "ai_edit_reply", Mock(side_effect=close_during_ai))
    result = flow.client.post("/webhooks/telegram/local-telegram-secret", json={
        "update_id": 1, "callback_query": {"id": "consult-race", "from": {"id": 111},
                           "message": {"chat": {"id": 111}}, "data": f"consult:{approval_id}"},
    })
    assert result.json()["ok"] is False
    with flow.sessions() as db:
        approval = db.get(ApprovalRequest, approval_id)
        assert approval.status == terminal
        assert approval.manager_telegram_id == "222"
        assert approval.edited_reply is None
    assert flow.sent == []
    pipeline.telegram.edit_approval_card.assert_not_called()


def test_consult_edits_pending_without_sending_and_rejects_terminal_replay(flow, monkeypatch):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
    edit = Mock(return_value=AIResult(content="Предлагаем консультацию", model="deterministic", purpose="test"))
    monkeypatch.setattr(openai_service, "ai_edit_reply", edit)
    payload = {"update_id": 2, "callback_query": {"id": "consult", "from": {"id": 111},
               "message": {"chat": {"id": 111}}, "data": f"consult:{approval_id}"}}
    assert flow.client.post("/webhooks/telegram/local-telegram-secret", json=payload).json()["ok"]
    with flow.sessions() as db:
        approval = db.get(ApprovalRequest, approval_id)
        assert approval.status == "edited"
        assert approval.edited_reply == "Предлагаем консультацию"
        assert pipeline.reject_request(db, approval_id, "111", "Не подходит")
    assert flow.client.post("/webhooks/telegram/local-telegram-secret", json=payload).json()["duplicate"]
    assert edit.call_count == 1
    assert flow.sent == []
