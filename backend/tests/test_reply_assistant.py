from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from pydantic import ValidationError

from app.api import admin
from app.services import openai_service


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Db:
    def __init__(self, lead, messages):
        self.lead = lead
        self.messages = messages

    def get(self, _model, _lead_id):
        return self.lead

    def scalars(self, _query):
        return _Rows(self.messages)


class ReplyOptionsTest(TestCase):
    def test_generates_requested_number_of_distinct_approaches(self):
        lead = SimpleNamespace(id=7)
        messages = [SimpleNamespace(direction="incoming", role="user", text="Есть крем для сухой кожи?")]

        with (
            patch.object(admin, "generate_reply", return_value=SimpleNamespace(content="Базовый ответ")),
            patch.object(
                admin,
                "ai_edit_reply",
                side_effect=lambda _base, _latest, instruction: SimpleNamespace(content=instruction),
            ) as edit,
        ):
            result = admin.reply_options(7, admin.ReplyOptionsRequest(count=3), _Db(lead, messages))

        self.assertEqual([item["approach"] for item in result["options"]], ["Тёплый", "Краткий", "Консультативный"])
        self.assertEqual(edit.call_count, 3)
        self.assertEqual(len({item["text"] for item in result["options"]}), 3)

    def test_rejects_variant_count_outside_safe_range(self):
        with self.assertRaises(ValidationError):
            admin.ReplyOptionsRequest(count=0)
        with self.assertRaises(ValidationError):
            admin.ReplyOptionsRequest(count=7)


class DictationTest(TestCase):
    def test_sends_browser_recording_to_openai_transcription(self):
        calls = {}

        class Transcriptions:
            def create(self, **kwargs):
                calls.update(kwargs)
                return SimpleNamespace(text="  Текст сотрудника  ")

        client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
        with (
            patch.object(openai_service.settings, "openai_api_key", "test-key"),
            patch.object(openai_service.settings, "openai_asr_api_key", ""),
            patch.object(openai_service.settings, "openai_asr_model", "gpt-transcribe"),
            patch.object(openai_service, "_client", return_value=client),
        ):
            text = openai_service.transcribe_audio_bytes(b"voice", "dictation.webm")

        self.assertEqual(text, "Текст сотрудника")
        self.assertEqual(calls["model"], "gpt-transcribe")
        self.assertEqual(calls["file"].name, "dictation.webm")
        self.assertEqual(calls["file"].getvalue(), b"voice")
        self.assertEqual(calls["response_format"], "json")
        self.assertNotIn("language", calls)

