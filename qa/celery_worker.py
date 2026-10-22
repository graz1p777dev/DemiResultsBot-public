"""QA-only Celery app: real processes/Redis/PG; synthetic AI and transport."""
import os
import socket
from datetime import datetime
from unittest.mock import Mock
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from app.core.config import settings
from app.models.entities import ActionLog
from app.services.openai_service import AIResult
from app.services.reply_hours import reply_hours_policy
from app.tasks import pipeline
from app.tasks.celery_app import celery_app

DATABASE = "postgresql+psycopg://postgres@/green_celery_qa?host=/var/run/postgresql"
BROKER = "redis+socket:///var/run/postgresql/redis-qa.sock?virtual_host=0"
assert settings.database_url == DATABASE
assert settings.redis_url == BROKER


def blocked(*args, **kwargs):
    raise AssertionError("External provider I/O forbidden in Celery QA")


real_connect = socket.socket.connect

def unix_only(sock, address):
    if sock.family != socket.AF_UNIX or address != "/var/run/postgresql/redis-qa.sock":
        return blocked()
    return real_connect(sock, address)


socket.socket.connect = unix_only
socket.socket.connect_ex = blocked
httpx.Client.request = blocked
httpx.AsyncClient.request = blocked


def result(content):
    return AIResult(content=content, model="deterministic", purpose="qa")


def send(*args):
    identifier = "qa-" + uuid4().hex
    with pipeline.SessionLocal() as db:
        db.add(ActionLog(action="qa.provider_send", status="synthetic", response_payload={"id": identifier}))
        db.commit()
    return {"ok": True, "messageId": identifier, "status": "queued"}


def card(approval, *args, **kwargs):
    with pipeline.SessionLocal() as db:
        db.add(ActionLog(lead_id=approval.lead_id, action="qa.card", status="synthetic"))
        db.commit()
    return {"_message_ids": '{"111":"222"}'}


pipeline._reply_hours = lambda: reply_hours_policy(datetime(2026, 10, 22, 12, tzinfo=ZoneInfo("Asia/Bishkek")))
pipeline.move_lead_status = Mock()
pipeline._lead_stage_snapshot = Mock(return_value={})
pipeline._count_repeat_leads = Mock(return_value=0)
pipeline.check_consultation_slots = Mock(return_value={"free_slots": []})
pipeline.classify_sales_intent = Mock(return_value=result({"is_sales": True}))
pipeline.generate_reply = Mock(return_value=result("Synthetic QA draft"))
pipeline.verify_reply = lambda dialogue, reply, **kwargs: (reply, None)
pipeline.extract_fields = Mock(return_value=result({}))
pipeline.detect_and_translate = Mock(return_value={"client_translation": None, "ai_reply_translation": None})
pipeline.summarize_dialogue = Mock(return_value=("", None))
pipeline._maybe_calibrate_prompt = Mock()
pipeline.crm_notify.notify = Mock()
pipeline.crm_notify.sync_deal = Mock()
pipeline.crm_notify.send_channel_message = send
pipeline.telegram.send_approval_card = card
pipeline.telegram.edit_approval_card = Mock()
pipeline.telegram.send_text = Mock()
celery_app.conf.broker_transport_options = {"visibility_timeout": 10}


@celery_app.task(name="qa.approve")
def approve(approval_id):
    with pipeline.SessionLocal() as db:
        return pipeline.approve_request(db, approval_id, "111")


@celery_app.task(name="qa.reserve_then_exit")
def reserve_then_exit(approval_id):
    pipeline.send_approved_reply = lambda *args, **kwargs: os._exit(77)
    with pipeline.SessionLocal() as db:
        pipeline.approve_request(db, approval_id, "111")
