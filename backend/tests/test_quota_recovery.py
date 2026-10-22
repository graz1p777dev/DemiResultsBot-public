"""Quota wrappers and durable daytime inquiry recovery; all providers mocked."""
from concurrent.futures import Future
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from tenacity import RetryError

from test_local_green_workflow import flow, incoming, process
from app.models.entities import ApprovalRequest, MessageBuffer, Setting
from app.tasks import pipeline


def retry_error(error):
    future = Future()
    future.set_exception(error)
    return RetryError(future)


@pytest.mark.parametrize("marker", ["insufficient_quota", "credit_balance_exhausted",
                                         "you have no credits remaining", "billing_hard_limit_reached"])
def test_quota_inside_retry_error_and_cause(marker):
    nested = retry_error(RuntimeError(marker.upper()))
    outer = RuntimeError("provider failed")
    outer.__cause__ = nested
    assert pipeline._looks_like_openai_quota_error(nested)
    assert pipeline._looks_like_openai_quota_error(outer)


def test_quota_detection_handles_nested_retries_and_cause_cycle():
    wrapped = retry_error(retry_error(RuntimeError("credit_balance_exhausted")))
    wrapped.__cause__ = wrapped
    assert pipeline._looks_like_openai_quota_error(wrapped)
    other = RuntimeError("429 rate limit exceeded")
    other.__cause__ = other
    assert not pipeline._looks_like_openai_quota_error(other)
    assert not pipeline._looks_like_openai_quota_error(retry_error(other))


def test_wrapped_quota_alert_is_deduplicated(flow, monkeypatch):
    alert = Mock()
    monkeypatch.setattr(pipeline.telegram, "send_text_all_managers", alert)
    error = retry_error(RuntimeError("429 credit_balance_exhausted"))
    with flow.sessions() as db:
        pipeline._notify_openai_quota_once(db, error)
        pipeline._notify_openai_quota_once(db, error)
        assert db.scalar(select(Setting).where(Setting.key == "openai_quota_last_alert_date"))
    assert alert.call_count == 1


@pytest.mark.parametrize("utility", ["extract_fields", "summarize_dialogue", "detect_and_translate"])
def test_utility_failure_creates_recovery_marker_without_night_or_new_inbound(flow, utility):
    incoming(flow)
    failing = getattr(pipeline, utility)
    failing.side_effect = retry_error(RuntimeError("all configured fallbacks failed"))
    with pytest.raises(RetryError):
        process(flow)
    assert pipeline.generate_reply.call_count == 1
    with flow.sessions() as db:
        assert not db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(ApprovalRequest)) is None
        marker = db.scalar(select(Setting).where(Setting.key.like("night_resume:%")))
        assert marker is not None
        assert int(marker.value) == db.scalar(select(MessageBuffer.lead_id))
    assert flow.sent == [] and flow.cards == []

    # A failing sweep must keep exactly one durable marker, without enqueueing.
    pipeline.resume_night_inbox()
    with flow.sessions() as db:
        assert len(db.scalars(select(Setting).where(Setting.key.like("night_resume:%"))).all()) == 1
        assert not db.scalar(select(MessageBuffer)).processed
    assert pipeline.generate_reply.call_count == 2

    failing.side_effect = None
    pipeline.resume_night_inbox()
    pipeline.resume_night_inbox()
    assert len(flow.cards) == 1
    assert flow.sent == []
    with flow.sessions() as db:
        assert db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(ApprovalRequest)).status == "pending"
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%"))) is None


def test_core_failure_rolls_back_failed_transaction_before_persisting_marker(flow, monkeypatch):
    incoming(flow)

    def fail(db, lead):
        # Force a real failed flush in the fixture DB, then propagate it.
        db.add(Setting(key="approval_channel", value="duplicate"))
        db.commit()

    monkeypatch.setattr(pipeline, "_lead_stage_snapshot", fail)
    from sqlalchemy.exc import IntegrityError
    with pytest.raises(IntegrityError):
        process(flow)
    with flow.sessions() as db:
        assert not db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%")))
    assert flow.sent == [] and flow.cards == []


def test_celery_retry_is_delayed_and_marker_is_persisted_before_scheduling(flow, monkeypatch):
    incoming(flow)
    pipeline.extract_fields.side_effect = retry_error(RuntimeError("utility unavailable"))
    scheduled = Mock(side_effect=RuntimeError("mock retry scheduled"))
    task = pipeline.process_lead_buffer
    monkeypatch.setattr(task, "retry", scheduled)
    with flow.sessions() as db:
        lead_id = db.scalar(select(MessageBuffer.lead_id))
    task.push_request(called_directly=False, retries=0)
    try:
        with pytest.raises(RuntimeError, match="mock retry scheduled"):
            task.run(lead_id, "in-1")
    finally:
        task.pop_request()
    assert scheduled.call_count == 1
    assert scheduled.call_args.kwargs["countdown"] >= 300
    with flow.sessions() as db:
        assert db.scalar(select(Setting).where(Setting.key == f"night_resume:{lead_id}"))
        assert not db.scalar(select(MessageBuffer)).processed
    assert flow.sent == []


def test_failure_after_approval_commit_does_not_reopen_consumed_buffer(flow, monkeypatch):
    incoming(flow)
    monkeypatch.setattr(pipeline, "_approval_uses_telegram", Mock(side_effect=RuntimeError("after commit")))
    with pytest.raises(RuntimeError, match="after commit"):
        process(flow)
    with flow.sessions() as db:
        assert db.scalar(select(MessageBuffer)).processed
        assert db.scalar(select(ApprovalRequest)).status == "pending"
        assert db.scalar(select(Setting).where(Setting.key.like("night_resume:%"))) is None
    assert flow.sent == []


@pytest.mark.parametrize("prompt,memory", [
    ("Магазин работает с 10:00 до 21:00.", "Открываемся в 10:00 по Бишкеку."),
    ("Часы работы: 10–21.", None),
    (None, "Начало работы: 10:00."),
    (None, None),
])
def test_checker_receives_current_trusted_business_instructions(flow, prompt, memory):
    with flow.sessions() as db:
        for key, value in (("bot_system_prompt", prompt), ("bot_memory", memory)):
            if value is not None:
                db.add(Setting(key=key, value=value))
        db.commit()
    incoming(flow, text="Вы же открываетесь в 09:00?")
    process(flow)
    expected = "\n\n".join(value for value in (prompt, memory) if value)
    assert pipeline.verify_reply.call_count == 1
    assert pipeline.verify_reply.call_args.kwargs == {"business_instructions": expected}
    assert "09:00" not in pipeline.verify_reply.call_args.kwargs["business_instructions"]
    assert len(flow.cards) == 1
    assert flow.sent == []
