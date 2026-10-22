from datetime import datetime
from types import SimpleNamespace
from unittest import TestCase
from zoneinfo import ZoneInfo

from app.services.repository import mark_manager_takeover


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Db:
    def __init__(self, approvals, buffers):
        self._results = iter((_Rows(approvals), _Rows(buffers)))

    def scalars(self, _query):
        return next(self._results)


class ManagerTakeoverTest(TestCase):
    def test_disables_ai_closes_drafts_and_discards_buffer(self):
        lead = SimpleNamespace(id=42, ai_enabled=True)
        approvals = [
            SimpleNamespace(status="pending", approved_at=None),
            SimpleNamespace(status="edited", approved_at=None),
        ]
        buffers = [SimpleNamespace(processed=False), SimpleNamespace(processed=False)]
        answered_at = datetime(2026, 9, 9, 8, 30, tzinfo=ZoneInfo("UTC"))

        closed = mark_manager_takeover(_Db(approvals, buffers), lead, answered_at)

        self.assertFalse(lead.ai_enabled)
        self.assertEqual(closed, 2)
        self.assertTrue(all(item.status == "answered_external" for item in approvals))
        self.assertTrue(all(item.approved_at == answered_at for item in approvals))
        self.assertTrue(all(item.processed for item in buffers))
