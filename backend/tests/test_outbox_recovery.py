"""Real SQL rows and crash boundaries; every external provider is mocked."""
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from test_local_green_workflow import flow, incoming, process
from app.models.entities import ApprovalRequest, Lead, Message
from app.tasks import pipeline


class WorkerCrash(BaseException):
    pass


def test_approval_and_reserved_payload_commit_together(flow, monkeypatch):
    incoming(flow)
    process(flow)
    monkeypatch.setattr(pipeline, "send_approved_reply", Mock(side_effect=WorkerCrash))
    with flow.sessions() as db:
        approval_id = db.scalar(select(ApprovalRequest.id))
        with pytest.raises(WorkerCrash):
            pipeline.approve_request(db, approval_id, "111")
    with flow.sessions() as db:
        approval = db.get(ApprovalRequest, approval_id)
        message = db.scalar(select(Message).where(Message.direction == "outgoing"))
        assert approval.status == "approved"
        assert message is not None
        assert message.status == "pending_dispatch"
        assert message.raw_payload["outbox"]["approval_id"] == approval_id
        assert message.raw_payload["outbox"]["parts"] == [approval.ai_reply]
    assert flow.sent == []


def test_ready_outbox_survives_worker_restart_and_dispatches_once(flow, monkeypatch):
    incoming(flow)
    process(flow)
    real_send = pipeline.send_approved_reply
    monkeypatch.setattr(pipeline, "send_approved_reply", Mock(side_effect=WorkerCrash))
    with flow.sessions() as db:
        with pytest.raises(WorkerCrash):
            pipeline.approve_request(db, db.scalar(select(ApprovalRequest.id)), "111")
    monkeypatch.setattr(pipeline, "send_approved_reply", real_send)
    pipeline.resume_outgoing()
    pipeline.resume_outgoing()
    assert len(flow.sent) == 1
    with flow.sessions() as db:
        message = db.scalar(select(Message).where(Message.direction == "outgoing"))
        assert message.raw_payload["outbox"]["state"] == "completed"
        assert db.scalar(select(ApprovalRequest)).status == "sent"


def test_partial_acceptance_is_never_reported_as_complete_or_retried(flow):
    incoming(flow)
    process(flow)
    pipeline.crm_notify.send_channel_message.side_effect = [
        {"ok": True, "messageId": "accepted-first"}, TimeoutError("ambiguous second part"),
    ]
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        pipeline.apply_edited_reply(db, approval.id, "111", "Первая часть<NEXT_MESSAGE>Вторая часть")
        assert not pipeline.approve_request(db, approval.id, "111")
        lead = db.get(Lead, approval.lead_id)
        user = db.scalar(select(Message).where(Message.role == "user"))
        assert not pipeline.send_approved_reply(db, lead, user.conversation_id, str(approval.id), "ignored", {}, approval)
        message = db.scalar(select(Message).where(Message.direction == "outgoing"))
        assert message.raw_payload["green_message_ids"] == ["accepted-first"]
        assert message.raw_payload["outbox"]["state"] == "uncertain"
        assert message.raw_payload["outbox"]["active_part"] == 1
    pipeline.resume_outgoing()
    assert pipeline.crm_notify.send_channel_message.call_count == 2


def test_crash_after_provider_acceptance_never_repeats(flow):
    incoming(flow)
    process(flow)
    pipeline.crm_notify.send_channel_message.side_effect = WorkerCrash
    with flow.sessions() as db:
        with pytest.raises(WorkerCrash):
            pipeline.approve_request(db, db.scalar(select(ApprovalRequest.id)), "111")
    pipeline.resume_outgoing()
    assert pipeline.crm_notify.send_channel_message.call_count == 1
    with flow.sessions() as db:
        message = db.scalar(select(Message).where(Message.direction == "outgoing"))
        assert message.raw_payload["outbox"]["state"] == "sending"


def test_empty_reply_cannot_consume_approval(flow):
    incoming(flow)
    process(flow)
    with flow.sessions() as db:
        approval = db.scalar(select(ApprovalRequest))
        pipeline.apply_edited_reply(db, approval.id, "111", "   ")
        assert not pipeline.approve_request(db, approval.id, "111")
        assert db.get(ApprovalRequest, approval.id).status == "edited"
    assert flow.sent == []


def test_completed_transport_before_approval_finalization_is_recovered_without_resend(flow, monkeypatch):
    incoming(flow)
    process(flow)
    real_checkpoint = pipeline.outbox.checkpoint
    def crash_on_completion(db, message, state, **details):
        real_checkpoint(db, message, state, **details)
        if state == "completed":
            raise WorkerCrash
    monkeypatch.setattr(pipeline.outbox, "checkpoint", crash_on_completion)
    with flow.sessions() as db:
        with pytest.raises(WorkerCrash):
            pipeline.approve_request(db, db.scalar(select(ApprovalRequest.id)), "111")
    monkeypatch.setattr(pipeline.outbox, "checkpoint", real_checkpoint)
    pipeline.resume_outgoing()
    pipeline.resume_outgoing()
    assert len(flow.sent) == 1
    with flow.sessions() as db:
        assert db.scalar(select(ApprovalRequest)).status == "sent"


def test_recovery_diagnostics_are_authenticated_and_do_not_expose_payloads(flow):
    incoming(flow)
    process(flow)
    pipeline.crm_notify.send_channel_message.side_effect = TimeoutError("SECRET_PROVIDER_URL")
    with flow.sessions() as db:
        assert not pipeline.approve_request(db, db.scalar(select(ApprovalRequest.id)), "111")
    assert flow.client.get("/admin/delivery-recovery").status_code == 401
    response = flow.client.get("/admin/delivery-recovery", headers={"X-Admin-API-Key": "local-test-key"})
    assert response.status_code == 200
    assert response.json()["outgoing"][0]["state"] == "uncertain"
    assert "SECRET_PROVIDER_URL" not in response.text
    assert "996000000000" not in response.text
    assert "Здравствуйте" not in response.text


def test_unsent_night_template_expires_before_daytime_recovery(flow, monkeypatch):
    flow.day = "2026-10-21T23:00:00"
    incoming(flow)
    # Crash after reserve, before claiming an attempt. The morning worker must
    # not send yesterday's closed-shop notice during opening hours.
    with flow.sessions() as db:
        lead = db.scalar(select(Lead))
        user = db.scalar(select(Message).where(Message.role == "user"))
        pipeline.outbox.reserve(db, lead.id, user.conversation_id,
            f"night:{lead.id}:2026-10-21", flow.policy().reply_text)
        db.commit()
    flow.day = "2026-10-22T10:00:00"
    pipeline.resume_outgoing()
    with flow.sessions() as db:
        assert db.scalar(select(Message).where(Message.direction == "outgoing")).status == "cancelled"
    assert not flow.sent
