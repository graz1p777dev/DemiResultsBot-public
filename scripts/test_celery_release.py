"""Disposable two-worker release gate. Only fixed Unix sockets and empty QA DB."""
import faulthandler
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ.clear()
os.chdir("/")
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT)]
DATABASE = "postgresql+psycopg://postgres@/green_celery_qa?host=/var/run/postgresql"
BROKER = "redis+socket:///var/run/postgresql/redis-qa.sock?virtual_host=0"
os.environ.update(DATABASE_URL=DATABASE, REDIS_URL=BROKER)

import psycopg
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from app.db.base import Base
from app.models.entities import ActionLog, ApprovalRequest, Client, Conversation, Lead, Message, MessageBuffer, Setting
from app.tasks.celery_app import celery_app


def until(check, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for QA state")


def main():
    faulthandler.dump_traceback_later(90, exit=True)
    with psycopg.connect("dbname=green_release_qa user=postgres host=/var/run/postgresql", autocommit=True) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "green_release_qa"
        assert conn.execute("SELECT count(*) FROM pg_database WHERE datname='green_celery_qa'").fetchone()[0] == 0
        conn.execute("CREATE DATABASE green_celery_qa")
    engine = create_engine(DATABASE, pool_size=4, max_overflow=0)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with engine.connect() as db:
        assert db.scalar(text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")) == 0
    Base.metadata.create_all(engine)
    with sessions() as db:
        db.add(Setting(key="approval_channel", value="telegram", is_secret=False))
        db.commit()
    workers, logs = [], []
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": f"{ROOT / 'backend'}:{ROOT}",
           "DATABASE_URL": DATABASE, "REDIS_URL": BROKER, "C_FORCE_ROOT": "1"}
    def start(name):
        log = open(f"/tmp/demi-celery-{name}.log", "w+")
        logs.append(log)
        worker = subprocess.Popen([sys.executable, "-m", "celery", "-A", "qa.celery_worker:celery_app",
            "worker", "--pool=solo", "--concurrency=1", "--without-gossip", "--without-mingle",
            "--without-heartbeat", "--loglevel=WARNING", "--hostname", f"{name}@offline", "--queues", name],
            env=env, stdout=log, stderr=subprocess.STDOUT)
        workers.append(worker)
        return worker
    def ready(name):
        return celery_app.control.ping(destination=[f"{name}@offline"], timeout=0.5)
    now = datetime(2026, 10, 22, 12, tzinfo=ZoneInfo("Asia/Bishkek"))
    def seed(key):
        with sessions() as db:
            client = Client(amocrm_author_id=key, name="Synthetic", source="whatsapp_green")
            db.add(client); db.flush()
            lead = Lead(amocrm_lead_id=key, client_id=client.id, chat_id="qa-never-send", is_test=False)
            db.add(lead); db.flush()
            conv = Conversation(lead_id=lead.id, chat_id=lead.chat_id)
            db.add(conv); db.flush()
            db.add(Message(lead_id=lead.id, conversation_id=conv.id, message_id=key, role="user", direction="incoming", text="QA", created_at=now))
            db.add(MessageBuffer(lead_id=lead.id, conversation_id=conv.id, message_id=key, text="QA", timestamp=now))
            db.commit()
            return lead.id, key
    def count(action):
        with sessions() as db:
            return db.scalar(select(func.count(ActionLog.id)).where(ActionLog.action == action))
    def approval(lead_id):
        with sessions() as db:
            return db.scalar(select(ApprovalRequest.id).where(ApprovalRequest.lead_id == lead_id))
    def task(name, args, queue):
        return celery_app.send_task(name, args=args, queue=queue)
    try:
        first = start("qa-a"); start("qa-b")
        until(lambda: ready("qa-a")); until(lambda: ready("qa-b"))
        work = [seed(f"celery-{i}") for i in range(12)]
        started = time.monotonic()
        tasks = [task("process_lead_buffer", [lead, key], queue) for lead, key in work for queue in ("qa-a", "qa-b")]
        for result in tasks:
            result.get(timeout=25)
        assert count("qa.card") == 12
        approvals = [approval(lead) for lead, _ in work]
        assert all(approvals)
        tasks = [task("qa.approve", [identifier], queue) for identifier in approvals for queue in ("qa-a", "qa-b")]
        results = [item.get(timeout=25) for item in tasks]
        assert results.count(True) == 12 and results.count(False) == 12
        assert count("qa.provider_send") == 12
        with sessions() as db:
            assert db.scalar(select(func.count(Message.id)).where(Message.direction == "outgoing")) == 12
        print("Celery/Redis/PG: 12 leads, 24 generation + 24 approval tasks, two real workers, no duplicate sends; %.2fs" % (time.monotonic() - started), flush=True)
        lead, key = seed("celery-crash")
        task("process_lead_buffer", [lead, key], "qa-b").get(timeout=15)
        identifier = approval(lead)
        task("qa.reserve_then_exit", [identifier], "qa-a")
        until(lambda: first.poll() is not None)
        assert first.returncode == 77
        with sessions() as db:
            assert db.get(ApprovalRequest, identifier).status == "approved"
            outgoing = db.scalar(select(Message).where(Message.message_id == f"ai:{identifier}"))
            assert outgoing.status == "pending_dispatch"
        task("resume_outgoing", [], "qa-b").get(timeout=15)
        start("qa-a")
        until(lambda: ready("qa-a"))
        task("resume_outgoing", [], "qa-a").get(timeout=15)
        assert not task("qa.approve", [identifier], "qa-a").get(timeout=15)
        assert count("qa.provider_send") == 13
        with sessions() as db:
            assert db.get(ApprovalRequest, identifier).status == "sent"
        print("Worker exit(77) after approval/reservation: surviving worker recovered exactly one synthetic send; restarted worker did not resend", flush=True)
    except BaseException:
        for log in logs:
            log.flush(); log.seek(0)
            print("\n".join(log.read().splitlines()[-30:]), file=sys.stderr)
        raise
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.terminate()
        for worker in workers:
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill(); worker.wait(timeout=3)
        for log in logs:
            log.close()
        engine.dispose()
        faulthandler.cancel_dump_traceback_later()


if __name__ == "__main__":
    main()
