"""Bounded real-PG QA. Run only in a fresh network-none QA container.

No env files, credentials, external sends, pytest or downloaded dependencies.
The only database endpoint is the disposable PG Unix socket below.
"""
import os
import socket
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

# Before importing the app: remove inherited settings and leave any .env behind.
os.environ.clear()
os.chdir("/")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
os.environ["DATABASE_URL"] = "postgresql+psycopg://postgres@/green_release_qa?host=/var/run/postgresql"

import httpx
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.base import Base
from app.models.entities import ApprovalRequest, Client, Conversation, Lead, Message, MessageBuffer, Setting, TrainingExample
from app.services.openai_service import AIResult
from app.services.reply_hours import reply_hours_policy
from app.tasks import pipeline

NAMESPACE = 0x44454D49
NOW = datetime(2026, 10, 22, 12, tzinfo=ZoneInfo("Asia/Bishkek"))


def blocked(*_args, **_kwargs):
    raise AssertionError("External I/O forbidden in PG release QA")


class PGReleaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine(settings.database_url, pool_size=8, max_overflow=8,
                                   connect_args={"options": "-c statement_timeout=15000 -c lock_timeout=12000"})
        cls.sessions = sessionmaker(cls.engine, expire_on_commit=False)
        # Only a new empty, explicitly named QA database is accepted.
        with cls.engine.connect() as db:
            assert db.scalar(text("SELECT current_database()")) == "green_release_qa"
            assert db.scalar(text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")) == 0
            print("PG", db.scalar(text("SHOW server_version")), flush=True)
        Base.metadata.create_all(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.engine.dispose()

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.sent, self.cards = [], []
        self.counter = 0
        self.now = NOW
        for obj, name, value in [
            (pipeline, "SessionLocal", self.sessions),
            (pipeline, "_reply_hours", lambda: reply_hours_policy(self.now)),
            (settings, "reply_hours_enabled", True),
            (settings, "human_approval_enabled", False),
            (pipeline, "move_lead_status", Mock()),
            (pipeline, "_lead_stage_snapshot", Mock(return_value={})),
            (pipeline, "_count_repeat_leads", Mock(return_value=0)),
            (pipeline, "check_consultation_slots", Mock(return_value={"free_slots": []})),
            (pipeline, "classify_sales_intent", Mock(return_value=self.result({"is_sales": True}))),
            (pipeline, "generate_reply", Mock(return_value=self.result("QA draft"))),
            (pipeline, "verify_reply", Mock(side_effect=lambda dialogue, reply, **kwargs: (reply, None))),
            (pipeline, "extract_fields", Mock(return_value=self.result({}))),
            (pipeline, "detect_and_translate", Mock(return_value={"client_translation": None, "ai_reply_translation": None})),
            (pipeline, "summarize_dialogue", Mock(return_value=("", None))),
            (pipeline.crm_notify, "notify", Mock()),
            (pipeline.crm_notify, "sync_deal", Mock()),
            (pipeline.crm_notify, "send_channel_message", Mock(side_effect=self.send)),
            (pipeline.telegram, "send_approval_card", Mock(side_effect=self.card)),
            (pipeline.telegram, "edit_approval_card", Mock()),
            (pipeline.telegram, "send_text", Mock()),
            (httpx.Client, "request", blocked),
            (httpx.AsyncClient, "request", blocked),
            (socket.socket, "connect", blocked),
            (socket.socket, "connect_ex", blocked),
        ]:
            self.stack.enter_context(patch.object(obj, name, value))
        with self.sessions() as db:
            if not db.scalar(select(Setting).where(Setting.key == "approval_channel")):
                db.add(Setting(key="approval_channel", value="telegram"))
                db.commit()

    @staticmethod
    def result(content):
        return AIResult(content=content, model="deterministic", purpose="qa")

    def send(self, *args):
        self.sent.append(args)
        return {"messageId": f"qa-send-{len(self.sent)}", "status": "queued"}

    def card(self, approval, *_args, **_kwargs):
        self.cards.append(approval.id)
        return {"_message_ids": '{"111":"222"}'}

    def seed(self):
        self.counter += 1
        key = f"{self._testMethodName}-{self.counter}"
        with self.sessions() as db:
            client = Client(amocrm_author_id=key, name="QA synthetic", source="whatsapp_green")
            db.add(client)
            db.flush()
            lead = Lead(amocrm_lead_id=key, client_id=client.id, chat_id="qa-never-send", is_test=False)
            db.add(lead)
            db.flush()
            conv = Conversation(lead_id=lead.id, chat_id=lead.chat_id)
            db.add(conv)
            db.flush()
            db.add(Message(lead_id=lead.id, conversation_id=conv.id, message_id=key,
                           role="user", direction="incoming", text="Нужна консультация", created_at=self.now))
            db.add(MessageBuffer(lead_id=lead.id, conversation_id=conv.id, message_id=key,
                                 text="Нужна консультация", timestamp=self.now))
            db.commit()
            return lead.id, key

    def assert_unlocked(self, lead_id):
        with self.engine.connect() as db:
            self.assertEqual(db.scalar(text(
                "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=:ns AND objid=:lead"
            ), {"ns": NAMESPACE, "lead": lead_id}), 0)

    def wait_for_follower(self, lead_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.engine.connect() as db:
                waiting = db.scalar(text(
                    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=:ns AND objid=:lead AND NOT granted"
                ), {"ns": NAMESPACE, "lead": lead_id})
            if waiting:
                return
            time.sleep(0.025)
        self.fail("Follower did not wait on the real PG advisory lock")

    def test_single_pending_across_commits(self):
        for _ in range(3):
            with self.subTest(round=_):
                lead_id, trigger = self.seed()
                entered, release = threading.Event(), threading.Event()

                def generate(*_args, **_kwargs):
                    entered.set()
                    if not release.wait(8):
                        raise AssertionError("QA barrier timed out")
                    return self.result("QA draft")

                pipeline.generate_reply.side_effect = generate
                before = len(self.cards)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    first = pool.submit(pipeline.process_lead_buffer, lead_id, trigger)
                    try:
                        self.assertTrue(entered.wait(5))  # Pipeline has already committed usage/logs.
                        second = pool.submit(pipeline.process_lead_buffer, lead_id, trigger)
                        self.wait_for_follower(lead_id)
                    finally:
                        release.set()
                    first.result(timeout=10)
                    second.result(timeout=10)
                with self.sessions() as db:
                    approvals = db.scalars(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)).all()
                    self.assertEqual(len(approvals), 1)
                    self.assertEqual(approvals[0].status, "pending")
                    self.assertTrue(db.scalar(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id)).processed)
                self.assertEqual(len(self.cards) - before, 1)
                self.assertEqual(self.sent, [])
                self.assert_unlocked(lead_id)

    def test_approve_cas_concurrency(self):
        for _ in range(3):
            with self.subTest(round=_):
                lead_id, trigger = self.seed()
                pipeline.process_lead_buffer(lead_id, trigger)
                with self.sessions() as db:
                    approval_id = db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.lead_id == lead_id))
                barrier = threading.Barrier(2, timeout=8)

                def before_update(conn, cursor, statement, parameters, context, executemany):
                    if statement.startswith("UPDATE approval_requests SET") and "approved_at=" in statement:
                        barrier.wait()  # Both Sessions reached the actual conditional UPDATE.

                def approve(actor):
                    with self.sessions() as db:
                        return actor, pipeline.approve_request(db, approval_id, actor)

                before = len(self.sent)
                event.listen(self.engine, "before_cursor_execute", before_update)
                try:
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [pool.submit(approve, actor) for actor in ("111", "222")]
                        results = [future.result(timeout=12) for future in futures]
                finally:
                    event.remove(self.engine, "before_cursor_execute", before_update)
                self.assertEqual(sorted(ok for _, ok in results), [False, True])
                self.assertEqual(len(self.sent) - before, 1)
                winner = next(actor for actor, ok in results if ok)
                with self.sessions() as db:
                    approval = db.get(ApprovalRequest, approval_id)
                    self.assertEqual(approval.status, "sent")
                    self.assertEqual(approval.manager_telegram_id, winner)
                    self.assertEqual(len(db.scalars(select(TrainingExample).where(TrainingExample.approval_request_id == approval_id)).all()), 1)
                    outgoing = db.scalars(select(Message).where(Message.lead_id == lead_id, Message.direction == "outgoing")).all()
                    self.assertEqual(len(outgoing), 1)
                    self.assertEqual(outgoing[0].status, "queued")

    def test_exception_releases_lock(self):
        lead_id, trigger = self.seed()
        pipeline._lead_stage_snapshot.side_effect = RuntimeError("QA injected failure")
        with self.assertRaisesRegex(RuntimeError, "QA injected failure"):
            pipeline.process_lead_buffer(lead_id, trigger)
        self.assert_unlocked(lead_id)
        pipeline._lead_stage_snapshot.side_effect = None
        pipeline.process_lead_buffer(lead_id, trigger)
        self.assertEqual(len(self.cards), 1)
        self.assert_unlocked(lead_id)

    def test_different_lead_does_not_wait(self):
        first_lead, first_trigger = self.seed()
        second_lead, second_trigger = self.seed()
        entered, release = threading.Event(), threading.Event()

        def generate(*_args, **_kwargs):
            if threading.current_thread().name.startswith("qa-first"):
                entered.set()
                if not release.wait(8):
                    raise AssertionError("QA barrier timed out")
            return self.result("QA draft")

        pipeline.generate_reply.side_effect = generate
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="qa-first") as first_pool:
            first = first_pool.submit(pipeline.process_lead_buffer, first_lead, first_trigger)
            try:
                self.assertTrue(entered.wait(5))
                with ThreadPoolExecutor(max_workers=1) as second_pool:
                    second_pool.submit(pipeline.process_lead_buffer, second_lead, second_trigger).result(timeout=5)
                self.assertEqual(len(self.cards), 1)
            finally:
                release.set()
            first.result(timeout=10)
        self.assertEqual(len(self.cards), 2)
        self.assert_unlocked(first_lead)
        self.assert_unlocked(second_lead)

    def test_night_notice_once_across_midnight_then_morning_sweep(self):
        self.now = NOW.replace(day=21, hour=21)
        lead_id, trigger = self.seed()
        pipeline.process_lead_buffer(lead_id, trigger)
        pipeline.process_lead_buffer(lead_id, trigger)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][-1], "Наш магазин уже закрылся. Спасибо за сообщение! Мы ответим вам завтра с 10:00.")
        # Reconnect after the first notice: recovery must come from PG rows.
        self.engine.dispose()
        self.now = NOW.replace(hour=0, minute=1)
        followup = trigger + "-midnight"
        with self.sessions() as db:
            buffer = db.scalar(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id))
            db.add(Message(lead_id=lead_id, conversation_id=buffer.conversation_id,
                           message_id=followup, role="user", direction="incoming",
                           text="И еще вопрос", created_at=self.now))
            db.add(MessageBuffer(lead_id=lead_id, conversation_id=buffer.conversation_id,
                                 message_id=followup, text="И еще вопрос", timestamp=self.now))
            db.commit()
        pipeline.process_lead_buffer(lead_id, followup)
        with self.sessions() as db:
            marker = db.scalar(select(Setting).where(Setting.key == f"night_resume:{lead_id}"))
            self.assertIsNotNone(marker)
            self.assertEqual(marker.value, str(lead_id))
            buffers = db.scalars(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id)).all()
            self.assertEqual(len(buffers), 2)
            self.assertTrue(all(not row.processed for row in buffers))
            outgoing = db.scalars(select(Message).where(Message.lead_id == lead_id, Message.direction == "outgoing")).all()
            self.assertEqual(len(outgoing), 1)
            self.assertEqual(outgoing[0].message_id, f"ai:night:{lead_id}:2026-10-21")
            self.assertIsNone(db.scalar(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)))
        self.now = NOW.replace(hour=9, minute=59)
        pipeline.resume_night_inbox()
        pipeline.generate_reply.assert_not_called()
        pipeline.classify_sales_intent.assert_not_called()
        self.now = NOW.replace(hour=10)
        pipeline.resume_night_inbox()
        pipeline.resume_night_inbox()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.cards), 1)
        with self.sessions() as db:
            approvals = db.scalars(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)).all()
            self.assertEqual(len(approvals), 1)
            self.assertEqual(approvals[0].status, "pending")
            self.assertIn("И еще вопрос", approvals[0].client_message)
            self.assertTrue(all(row.processed for row in db.scalars(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id))))
            self.assertIsNone(db.scalar(select(Setting).where(Setting.key == f"night_resume:{lead_id}")))
        self.assert_unlocked(lead_id)

    def test_morning_translation_failure_keeps_marker_then_recovers(self):
        self.now = NOW.replace(day=21, hour=23)
        lead_id, trigger = self.seed()
        pipeline.process_lead_buffer(lead_id, trigger)
        self.now = NOW.replace(hour=10)
        pipeline.detect_and_translate.side_effect = RuntimeError("QA morning translation failure")
        pipeline.resume_night_inbox()
        self.assertEqual(self.cards, [])
        self.assertEqual(len(self.sent), 1)
        self.assert_unlocked(lead_id)
        self.engine.dispose()
        with self.sessions() as db:
            self.assertFalse(db.scalar(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id)).processed)
            self.assertIsNotNone(db.scalar(select(Setting).where(Setting.key == f"night_resume:{lead_id}")))
            self.assertIsNone(db.scalar(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)))
        pipeline.detect_and_translate.side_effect = None
        pipeline.resume_night_inbox()
        pipeline.resume_night_inbox()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.cards), 1)
        with self.sessions() as db:
            approvals = db.scalars(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)).all()
            self.assertEqual(len(approvals), 1)
            self.assertEqual(approvals[0].status, "pending")
            self.assertTrue(db.scalar(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id)).processed)
            self.assertIsNone(db.scalar(select(Setting).where(Setting.key == f"night_resume:{lead_id}")))
        self.assert_unlocked(lead_id)

    def test_old_session_refuses_transaction_after_epoch_replacement(self):
        from app.services import pipeline_fence
        lead_id, _ = self.seed()
        with self.sessions() as old, self.sessions() as successor:
            guard = pipeline_fence.install(old, lead_id)
            try:
                newer_guard = pipeline_fence.install(successor, lead_id)
                pipeline_fence.remove(successor, newer_guard)
                with self.assertRaises(pipeline_fence.StalePipelineFence):
                    old.scalar(select(Lead).where(Lead.id == lead_id))
                old.rollback()
            finally:
                pipeline_fence.remove(old, guard)

    def test_training_finalization_under_contention(self):
        lead_id, trigger = self.seed()
        pipeline.process_lead_buffer(lead_id, trigger)
        with self.sessions() as db:
            identifier = db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.lead_id == lead_id))
        barrier = threading.Barrier(8, timeout=8)
        def finalize():
            with self.sessions() as db:
                approval = db.get(ApprovalRequest, identifier)
                barrier.wait()
                pipeline.save_training_example(db, approval)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: finalize(), range(8)))
        with self.sessions() as db:
            self.assertEqual(len(db.scalars(select(TrainingExample).where(TrainingExample.approval_request_id == identifier)).all()), 1)

    def test_atomic_session_pop_under_contention(self):
        with self.sessions() as db:
            pipeline.set_edit_session(db, "qa-pop", 123)
        barrier = threading.Barrier(8, timeout=8)
        def consume():
            barrier.wait()
            with self.sessions() as db:
                return pipeline.pop_edit_session(db, "qa-pop")
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: consume(), range(8)))
        self.assertEqual(results.count(123), 1)
        self.assertEqual(results.count(None), 7)

    def test_competing_outbox_recovery_claims_only_once(self):
        lead_id, trigger = self.seed()
        pipeline.process_lead_buffer(lead_id, trigger)
        class Crash(BaseException):
            pass
        with self.sessions() as db:
            approval_id = db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.lead_id == lead_id))
            with patch.object(pipeline, "send_approved_reply", side_effect=Crash):
                with self.assertRaises(Crash):
                    pipeline.approve_request(db, approval_id, "111")
        barrier = threading.Barrier(4, timeout=8)
        def recover():
            barrier.wait()
            pipeline.resume_outgoing()
        before = len(self.sent)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: recover(), range(4)))
        self.assertEqual(len(self.sent) - before, 1)
        with self.sessions() as db:
            self.assertEqual(db.get(ApprovalRequest, approval_id).status, "sent")

    def test_bounded_eight_worker_generation_load(self):
        work = [self.seed() for _ in range(24)]
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(pipeline.process_lead_buffer, lead_id, trigger) for lead_id, trigger in work]
            for future in futures:
                future.result(timeout=30)
        with self.sessions() as db:
            for lead_id, _ in work:
                self.assertEqual(len(db.scalars(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)).all()), 1)
                self.assertTrue(db.scalar(select(MessageBuffer).where(MessageBuffer.lead_id == lead_id)).processed)
        self.assertEqual(len(self.cards), 24)
        self.assertEqual(len(self.sent), 0)
        print("Bounded load: 24 leads / 8 threads, %.2fs; pool size=8 max_overflow=8" % (time.monotonic() - started), flush=True)

    def test_killed_advisory_connection_is_fenced(self):
        lead_id, trigger = self.seed()
        entered, release = threading.Event(), threading.Event()
        calls = 0
        def slow_generate(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                if not release.wait(8):
                    raise AssertionError("fence barrier timed out")
            return self.result("QA fenced draft")
        pipeline.generate_reply.side_effect = slow_generate
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(pipeline.process_lead_buffer, lead_id, trigger)
            try:
                self.assertTrue(entered.wait(5))
                with self.engine.connect() as db:
                    pid = db.scalar(text("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=:ns AND objid=:lead AND granted"), {"ns": NAMESPACE, "lead": lead_id})
                    self.assertIsNotNone(pid)
                    self.assertTrue(db.scalar(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid}))
                second = pool.submit(pipeline.process_lead_buffer, lead_id, trigger)
            finally:
                release.set()
            first.result(timeout=15)
            second.result(timeout=15)
        with self.sessions() as db:
            self.assertEqual(len(db.scalars(select(ApprovalRequest).where(ApprovalRequest.lead_id == lead_id)).all()), 1)
        self.assertEqual(len(self.cards), 1)
        self.assertEqual(self.sent, [])
        self.assert_unlocked(lead_id)


if __name__ == "__main__":
    # Hard wall-clock bound even if a driver/thread hangs; container is disposable.
    import faulthandler
    faulthandler.dump_traceback_later(90, exit=True)
    unittest.main(verbosity=2)
