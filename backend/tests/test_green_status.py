from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.dialects import postgresql
from app.api.admin import WhatsAppStatus, whatsapp_status


def database(ids=None, states=None, expected=1, provider="green_api"):
    row = SimpleNamespace(message_id="ai:approval1", status="queued", raw_payload={
        "provider": provider, "green_message_ids": ids or ["green1"],
        "green_message_statuses": states or {}, "green_expected_parts": expected,
    })
    db = Mock()
    db.scalar.return_value = row
    return db, row


@pytest.mark.parametrize("event,expected", [("sent", "sent"), ("delivered", "delivered"), ("read", "read"), ("failed", "failed")])
def test_green_status_and_postgres_provider_id_query(event, expected):
    db, row = database()
    assert whatsapp_status(WhatsAppStatus(message_id="green1", status=event, provider="green_api"), db)["matched"]
    assert row.status == expected
    compiled = str(db.scalar.call_args.args[0].compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in compiled and "@>" in compiled
    assert "green_message_ids" in str(db.scalar.call_args.args[0].compile(dialect=postgresql.dialect()).params)


def test_green_status_never_regresses_read():
    db, row = database(states={"green1": "read"})
    for status in ("sent", "delivered", "failed"):
        whatsapp_status(WhatsAppStatus(message_id="green1", status=status, provider="green_api"), db)
        assert row.status == "read"


def test_multipart_waits_for_all_parts_then_aggregates_minimum():
    db, row = database(ids=["green1"], expected=2)
    whatsapp_status(WhatsAppStatus(message_id="green1", status="read", provider="green_api"), db)
    assert row.status == "queued"
    row.raw_payload = {**row.raw_payload, "green_message_ids": ["green1", "green2"]}
    whatsapp_status(WhatsAppStatus(message_id="green2", status="delivered", provider="green_api"), db)
    assert row.status == "delivered"


def test_wrong_provider_and_unknown_id_cannot_update():
    db, _ = database(provider="meta_whatsapp")
    assert not whatsapp_status(WhatsAppStatus(message_id="green1", status="sent", provider="green_api"), db)["matched"]
    db.scalar.return_value = None
    assert not whatsapp_status(WhatsAppStatus(message_id="unknown", status="sent", provider="green_api"), db)["matched"]
    db.commit.assert_not_called()
