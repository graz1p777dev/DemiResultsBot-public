"""Offline characterization of real functions, without app/env imports."""
import ast
import asyncio
import json
import secrets
import re
from datetime import datetime
from html import escape
from zoneinfo import ZoneInfo
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import TestCase, main
from unittest.mock import AsyncMock, MagicMock, Mock

APP = Path(__file__).resolve().parents[1] / "app"


def functions(path, names, scope):
    tree = ast.parse((APP / path).read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert len(nodes) == len(names)
    for node in nodes:
        node.decorator_list = []
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(APP / path), "exec"), scope)
    return scope


class TelegramSafetyTest(TestCase):
    def test_decision_actor_escaped_in_regular_and_purchase_cards(self):
        scope = {
            "ApprovalRequest": object, "Lead": object, "escape": escape,
            "datetime": datetime, "ZoneInfo": ZoneInfo, "re": re,
            "settings": NS(timezone="Asia/Bishkek", frontend_url="https://example.invalid"),
            "calc_score": lambda *args: 10, "test_banner": lambda lead: "",
            "_format_reply_preview": escape, "_fmt_client_message": escape,
            "memory_lines": lambda fields: "", "_build_hashtags": lambda *args: "",
            "chat_history_url": lambda lead: "https://example.invalid/history",
            "is_test_lead": lambda lead: False, "lead_url": lambda lead: "https://example.invalid/lead",
            "PURCHASE_PLACEHOLDER": "draft",
        }
        functions("services/telegram.py", {"approval_card", "_purchase_card"}, scope)
        lead = NS(client=None, contact_id="-", amocrm_lead_id="42")
        actor = '<b>A&B</b> "Name"'
        decision = "✅ Отправлено · " + actor
        for purchase in (False, True):
            with self.subTest(purchase=purchase):
                approval = NS(id=1, extracted_fields={"_purchase_intent": purchase},
                              edited_reply=None, ai_reply="draft", client_message="hello",
                              conversation_summary=None, client_message_translation=None,
                              ai_reply_translation=None, amocrm_stage_name="new", amocrm_status_id=1)
                card = scope["approval_card"](approval, lead, decision=decision, claimed_by_name=actor)
                self.assertIn(escape(decision), card)
                self.assertIn(escape(actor), card)
                self.assertNotIn(actor, card)
                self.assertNotIn("&amp;lt;b&amp;gt;", card)
                self.assertIn("<b>Клиент:</b>", card)

    def telegram(self, responses=()):
        client = MagicMock()
        client.__enter__.return_value = client
        client.post.side_effect = list(responses)
        scope = {
            "settings": NS(telegram_manager_chat_id="7", telegram_allowed_manager_ids="8"),
            "ApprovalRequest": object, "Lead": object, "json": json,
            "telegram_enabled": lambda: True, "approval_card": Mock(return_value="card"),
            "approval_keyboard": Mock(return_value={}), "httpx": NS(Client=Mock(return_value=client)),
            "_all_manager_chat_ids": lambda extra: ["7", "8"], "_api_url": lambda method: "mock://" + method,
            "_log": Mock(), "_forward_client_photos": Mock(), "_forward_client_voice": Mock(),
            "_parse_message_ids": lambda value: [("7", "10")], "is_test_lead": lambda lead: False,
            "lead_url": lambda lead: "https://example.invalid/lead",
        }
        functions("services/telegram.py", {"allowed_manager_ids", "is_authorized_manager", "send_approval_card", "edit_approval_card"}, scope)
        return scope, client

    def test_personal_authorization(self):
        s, _ = self.telegram()
        s["settings"].telegram_manager_chat_id = "-100"
        authorize = s["is_authorized_manager"]
        self.assertFalse(authorize("999", "-100"))
        self.assertFalse(authorize("-100", "-100", {"-100"}))
        self.assertTrue(authorize("8", "-100"))
        self.assertTrue(authorize("9", "-100", {"9"}))
        s["settings"].telegram_manager_chat_id = "7"
        self.assertTrue(authorize("7", "7"))

    def test_empty_delivery_raises_safe_error(self):
        for response in [NS(is_success=False, status_code=500), NS(is_success=True, json=lambda: {"ok": False}), RuntimeError("https://api.telegram.org/botSECRET")]:
            with self.subTest(response=type(response).__name__):
                s, _ = self.telegram([response, response])
                with self.assertRaisesRegex(RuntimeError, "^Telegram approval card was not delivered$"):
                    s["send_approval_card"](NS(id=1, extracted_fields={}, edited_reply=None, client_message=""), NS())
                self.assertNotIn("SECRET", str(s["_log"].mock_calls))

    def test_unconfigured_delivery_raises(self):
        s, client = self.telegram()
        s["telegram_enabled"] = lambda: False
        with self.assertRaises(RuntimeError):
            s["send_approval_card"](NS(), NS())
        client.post.assert_not_called()

    def test_partial_delivery_has_nonempty_ids(self):
        s, _ = self.telegram([NS(is_success=False, status_code=500), NS(is_success=True, json=lambda: {"ok": True, "result": {"message_id": 12}})])
        result = s["send_approval_card"](NS(id=1, extracted_fields={}, edited_reply=None, client_message=""), NS())
        self.assertEqual(json.loads(result["_message_ids"]), {"8": "12"})

    def test_failed_card_has_no_retry(self):
        s, client = self.telegram([NS(is_success=True, json=lambda: {"ok": True})])
        s["edit_approval_card"](NS(id=1, status="failed", telegram_message_id="10"), NS(), decision="failed", retry=True)
        rows = client.post.call_args.kwargs["json"]["reply_markup"]["inline_keyboard"]
        self.assertFalse(any("callback_data" in button for row in rows for button in row))

    def webhook(self):
        class Rejected(Exception):
            def __init__(self, status_code, detail):
                self.status_code = status_code

        scope = {
            "settings": NS(telegram_webhook_secret="local"), "secrets": secrets,
            "HTTPException": Rejected, "Request": object, "Session": object,
            "Depends": lambda value: None, "get_db": Mock(), "ApprovalRequest": object, "Lead": object,
            "telegram": NS(is_authorized_manager=Mock(return_value=True), answer_callback=Mock(),
                           edit_approval_card=Mock(), PURCHASE_PLACEHOLDER="[answer]"),
            "_load_db_manager_ids": lambda db: {"7"}, "_load_templates": lambda db: [{"id": "x", "text": "draft", "name": "X"}],
            "apply_edited_reply": Mock(return_value=None), "clear_claim": Mock(),
            "_refresh_purchase_card": Mock(),
        }
        for name in ("pop_reject_reason_session", "pop_edit_session", "pop_purchase_edit_session", "pop_purchase_answer_session", "pop_edit_prompt_msg"):
            scope[name] = Mock(return_value=None)
        functions("api/webhooks.py", {"telegram_webhook"}, scope)
        return scope

    def test_secret_rejected_before_json(self):
        for expected, supplied in [("", "local"), ("local", "wrong")]:
            s = self.webhook()
            s["settings"].telegram_webhook_secret = expected
            request = NS(json=AsyncMock())
            with self.assertRaises(s["HTTPException"]) as caught:
                asyncio.run(s["telegram_webhook"](supplied, request, Mock()))
            self.assertEqual(caught.exception.status_code, 401)
            request.json.assert_not_called()

    def test_terminal_template_and_purchase_none_handling(self):
        for branch in ("tpl", "purchase_edit", "purchase_answer"):
            with self.subTest(branch=branch):
                s = self.webhook()
                db = Mock()
                approval = NS(id=1, lead_id=2, status="sent", extracted_fields={})
                db.get.side_effect = lambda model, key: approval if key == 1 else NS(id=2)
                if branch == "tpl":
                    update = {"callback_query": {"id": "c", "from": {"id": 7}, "message": {"chat": {"id": 7}}, "data": "tpl:1:x"}}
                else:
                    s["pop_" + branch + "_session"].return_value = 1
                    update = {"message": {"from": {"id": 7}, "chat": {"id": 7}, "text": "draft"}}
                result = asyncio.run(s["telegram_webhook"]("local", NS(json=AsyncMock(return_value=update)), db))
                self.assertEqual(result, {"ok": False, "error": "approval_not_editable"})
                s["apply_edited_reply"].assert_called_once_with(db, 1, "7", "draft")
                self.assertEqual(approval.status, "sent")
                db.commit.assert_not_called()
                s["_refresh_purchase_card"].assert_not_called()
                s["telegram"].edit_approval_card.assert_not_called()


if __name__ == "__main__":
    main()
