import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from test_local_green_workflow import flow, incoming, process
from app.models.entities import ApprovalRequest, Setting
from app.services.openai_service import AIResult
from app.tasks import pipeline

URL = "/webhooks/telegram/local-telegram-secret"


def callback(update_id, action, approval_id, actor=111):
    return {"update_id": update_id, "callback_query": {"id": str(update_id), "from": {"id": actor},
        "message": {"chat": {"id": actor}}, "data": f"{action}:{approval_id}"}}


def test_duplicate_edit_update_does_not_reopen_consumed_session(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
    payload = callback(10, "edit", approval_id)
    assert flow.client.post(URL, json=payload).json()["ok"]
    message = {"update_id": 11, "message": {"message_id": 12, "from": {"id": 111},
        "chat": {"id": 111}, "text": "Исправление сотрудника"}}
    assert flow.client.post(URL, json=message).json()["ok"]
    assert flow.client.post(URL, json=payload).json()["duplicate"]
    assert flow.client.post(URL, json=message).json()["duplicate"]
    with flow.sessions() as db:
        assert pipeline.pop_edit_session(db, "111") is None
        assert db.get(ApprovalRequest, approval_id).edited_reply == "Исправление сотрудника"
    assert not flow.sent


def test_update_conflict_and_malformed_id_fail_without_side_effects(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
    assert flow.client.post(URL, json=callback(20, "edit", approval_id)).json()["ok"]
    assert flow.client.post(URL, json=callback(20, "approve", approval_id)).status_code == 409
    for value in (None, -1, True, "21", 2**63):
        payload = callback(value, "approve", approval_id)
        assert flow.client.post(URL, json=payload).status_code == 400
    assert not flow.sent


def test_uncertain_update_is_acknowledged_but_never_replayed(flow, monkeypatch):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
    monkeypatch.setattr(pipeline.telegram, "answer_callback", Mock(side_effect=RuntimeError("mock telegram outage")))
    payload = callback(30, "edit", approval_id)
    # Telegram transport exception may be caught by its fallback branch; make
    # both branches fail so the decorator records a genuinely interrupted update.
    with pytest.raises(RuntimeError):
        flow.client.post(URL, json=payload)
    before = pipeline.telegram.answer_callback.call_count
    replay = flow.client.post(URL, json=payload).json()
    assert replay == {"ok": True, "duplicate": True, "state": "uncertain"}
    assert pipeline.telegram.answer_callback.call_count == before


def test_sessions_expire_and_pop_only_once(flow):
    with flow.sessions() as db:
        pipeline.set_edit_session(db, "111", 42)
        assert pipeline.pop_edit_session(db, "111") == 42
        assert pipeline.pop_edit_session(db, "111") is None
        pipeline.set_edit_session(db, "111", 43)
        row = db.scalar(select(Setting).where(Setting.key == "telegram_edit_session:111"))
        row.value = json.dumps({"value": "43", "expires_at": 0})
        db.commit()
        assert pipeline.pop_edit_session(db, "111") is None
        db.add(Setting(key="telegram_edit_session:111", value="44",
            updated_at=datetime.now(timezone.utc) - timedelta(hours=2)))
        db.commit()
        assert pipeline.pop_edit_session(db, "111") is None


def test_slow_ai_edit_cannot_overwrite_newer_manager_edit(flow, monkeypatch):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))

    def slow_ai(*args):
        with flow.sessions() as other:
            assert pipeline.apply_edited_reply(other, approval_id, "222", "Новая правка")
        return AIResult(content="Устаревшая правка AI", model="deterministic", purpose="test")
    monkeypatch.setattr(pipeline, "ai_edit_reply", Mock(side_effect=slow_ai))
    with flow.sessions() as db:
        assert pipeline.apply_ai_edited_reply(db, approval_id, "111", "Уточни ответ") is None
    with flow.sessions() as db:
        approval = db.get(ApprovalRequest, approval_id)
        assert approval.edited_reply == "Новая правка"
        assert approval.manager_telegram_id == "222"
    assert not flow.sent
