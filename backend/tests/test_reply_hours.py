from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from app.services.reply_hours import reply_hours_policy


class ReplyHoursTest(TestCase):
    def local(self, value):
        return datetime.fromisoformat(value).replace(tzinfo=ZoneInfo("Asia/Bishkek"))

    def test_boundaries(self):
        for value, approval in (
            ("2026-10-21T09:59:59.999999", False),
            ("2026-10-21T10:00:00", True),
            ("2026-10-21T20:59:59.999999", True),
            ("2026-10-21T21:00:00", False),
        ):
            with self.subTest(value=value):
                result = reply_hours_policy(self.local(value))
                self.assertEqual(result.requires_human_approval, approval)
                if approval:
                    self.assertIsNone(result.reply_text)
                    self.assertIsNone(result.night_key)
                    self.assertIsNone(result.next_open_at)

    def test_exact_evening_and_morning_text(self):
        for value, day_word in (
            ("2026-10-21T21:00:00", "завтра"),
            ("2026-10-21T23:59:59.999999", "завтра"),
            ("2026-10-22T00:00:00", "сегодня"),
            ("2026-10-22T09:59:59", "сегодня"),
        ):
            result = reply_hours_policy(self.local(value))
            self.assertEqual(result.reply_text, "Наш магазин уже закрылся. Спасибо за сообщение! "
                             f"Мы ответим вам {day_word} с 10:00.")
            self.assertEqual(result.night_key, "2026-10-21")
            self.assertEqual(result.next_open_at, self.local("2026-10-22T10:00:00"))

    def test_utc_is_converted_before_decision(self):
        for hour, approval in ((3, False), (4, True), (14, True), (15, False)):
            self.assertEqual(
                reply_hours_policy(datetime(2026, 10, 21, hour, tzinfo=timezone.utc)).requires_human_approval,
                approval,
            )

    def test_explicit_timezone(self):
        now = datetime(2026, 10, 21, 9, tzinfo=timezone.utc)
        self.assertTrue(reply_hours_policy(now).requires_human_approval)
        result = reply_hours_policy(now, timezone="UTC")
        self.assertFalse(result.requires_human_approval)
        self.assertEqual(result.next_open_at.utcoffset().total_seconds(), 0)

    def test_custom_hours(self):
        now = self.local("2026-10-21T20:00:00")
        self.assertTrue(reply_hours_policy(now).requires_human_approval)
        self.assertFalse(reply_hours_policy(now, end_hour=20).requires_human_approval)
        result = reply_hours_policy(now, start_hour=11, end_hour=20)
        self.assertTrue(result.reply_text.endswith("завтра с 11:00."))
        self.assertEqual(result.next_open_at.hour, 11)

    def test_year_boundary_and_next_night(self):
        result = reply_hours_policy(self.local("2026-12-31T23:59:59"))
        self.assertEqual(result.next_open_at, self.local("2027-01-01T10:00:00"))
        self.assertEqual(result.night_key, "2026-12-31")
        self.assertEqual(reply_hours_policy(self.local("2027-01-01T21:00:00")).night_key, "2027-01-01")

    def test_rejects_naive_time_and_invalid_hours(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            reply_hours_policy(datetime(2026, 10, 21))
        for start, end in ((10, 10), (21, 10), (-1, 21), (10, 24)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                reply_hours_policy(self.local("2026-10-21T12:00:00"), start_hour=start, end_hour=end)

    def test_mock_caller_deduplicates_night_and_respects_takeover(self):
        # Пример контракта интеграции, не проверка реального pipeline/транспорта.
        send = Mock()
        sent = set()

        def handle(value, ai_enabled=True, manual_takeover=False):
            if not ai_enabled or manual_takeover:
                return
            decision = reply_hours_policy(self.local(value))
            key = ("mock-chat", decision.night_key)
            if decision.reply_text and key not in sent:
                send(decision.reply_text)
                sent.add(key)

        handle("2026-10-21T21:00:00", ai_enabled=False)
        handle("2026-10-21T21:00:00", manual_takeover=True)
        handle("2026-10-21T12:00:00")
        send.assert_not_called()
        handle("2026-10-21T21:00:00")
        handle("2026-10-22T09:00:00")
        send.assert_called_once_with("Наш магазин уже закрылся. Спасибо за сообщение! Мы ответим вам завтра с 10:00.")
        handle("2026-10-22T21:00:00")
        self.assertEqual(send.call_count, 2)
