"""Actual incoming route, synthetic media and mocked transcription/transport."""
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from test_local_green_workflow import flow, process
from app.api import admin
from app.models.entities import Message, MessageBuffer


@pytest.mark.parametrize("result", ["Кыргызча үн билдирүү", RuntimeError("mock quota exhausted")])
def test_voice_is_retained_even_when_transcription_fails(flow, monkeypatch, result):
    transcribe = Mock(side_effect=result) if isinstance(result, Exception) else Mock(return_value=(result, "ky"))
    monkeypatch.setattr(admin, "transcribe_voice", transcribe)
    media = "https://media.example.invalid/synthetic.ogg"
    body = {"lead_id": "voice-lead", "client_id": "voice-client", "client_name": "QA",
        "chat_id": "996000000000@c.us", "message_id": "voice-1", "text": "",
        "source": "whatsapp_green", "attachment_type": "voice", "attachment_link": media,
        "timestamp": flow.day + "+06:00"}
    headers = {"X-Admin-API-Key": "local-test-key"}
    assert flow.client.post("/admin/crm/incoming", json=body, headers=headers).status_code == 200
    assert not flow.client.post("/admin/crm/incoming", json=body, headers=headers).json()["queued"]
    with flow.sessions() as db:
        message = db.scalar(select(Message))
        assert media in message.text
        assert message.media_url == media
        assert message.message_type == "voice"
        assert len(db.scalars(select(MessageBuffer)).all()) == 1
    assert not flow.sent
