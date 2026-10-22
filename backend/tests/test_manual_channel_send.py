from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.api import admin
from app.services import crm_notify


class ManualChannelSendTest(TestCase):
    def setUp(self):
        self.lead = SimpleNamespace(id=1, chat_id="996000000000@c.us",
                                    client=SimpleNamespace(source="whatsapp_green"))

    def test_manual_text_uses_protected_crm_green_transport(self):
        result = {"ok": True, "provider": "green_api", "messageId": "mock-id", "status": "queued"}
        with patch.object(crm_notify, "send_channel_message", return_value=result) as send:
            actual, action = admin._send_text_to_lead(self.lead, "Здравствуйте")
        send.assert_called_once_with("whatsapp", self.lead.chat_id, "Здравствуйте")
        self.assertEqual(actual, result)
        self.assertEqual(action, "green_api.send_message")

    def test_manual_voice_uses_protected_crm_green_transport(self):
        result = {"ok": True, "provider": "green_api", "messageId": "mock-voice", "status": "queued"}
        with patch.object(crm_notify, "send_whatsapp_media", return_value=result) as send:
            actual = admin._send_media_to_lead(self.lead, "https://bot.example/media/voice.m4a", "voice.m4a", "Голосовое")
        send.assert_called_once_with(self.lead.chat_id, "https://bot.example/media/voice.m4a", "Голосовое", "audio")
        self.assertEqual(actual, result)

    def test_missing_config_does_not_claim_send_success(self):
        with patch.object(crm_notify.settings, "crm_notify_token", ""):
            with self.assertRaises(RuntimeError):
                crm_notify.send_channel_message("whatsapp", self.lead.chat_id, "Тест")
            with self.assertRaises(RuntimeError):
                crm_notify.send_whatsapp_media(self.lead.chat_id, "https://bot.example/media/x.ogg", "Тест", "audio")
