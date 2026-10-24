"""Release contracts on isolated SQLite; only provider boundaries are mocked.

Interleaved sessions exercise CAS guards, not PostgreSQL lock semantics.
"""
import json
from unittest.mock import Mock

import httpx
import pytest
from sqlalchemy import select

from test_local_green_workflow import flow, incoming, process
from app.models.entities import ActionLog, ApprovalRequest, Message, Setting, TrainingExample
from app.services import telegram, telegram_edits as edits
from app.services.openai_service import AIResult
from app.tasks import pipeline

URL = "/webhooks/telegram/local-telegram-secret"
HEADERS = {"X-Admin-API-Key": "local-test-key", "X-Employee-ID": "employee-a"}
HTTP_CLIENT = httpx.Client
SEND_TEXT = telegram.send_text


@pytest.fixture
def approval_id(flow):
    assert incoming(flow).status_code == 200
    process(flow)
    telegram.send_text.reset_mock()
    with flow.sessions() as db:
        return db.scalar(select(ApprovalRequest.id))


def reply(approval_id, text="Исправленный <ответ> & точные условия", *, keyboard=True,
          actor=111, chat=111, target=222, message_id=444):
    original = {"message_id": target}
    if keyboard:
        original["reply_markup"] = {"inline_keyboard": [[
            {"callback_data": f"edit:{approval_id}", "text": "Изменить"}]]}
    return {"message_id": message_id, "from": {"id": actor}, "chat": {"id": chat},
            "reply_to_message": original, "text": text}


def proposals(flow):
    with flow.sessions() as db:
        rows = db.scalars(select(Setting).where(Setting.key.like("telegram_edit_proposal:%"))).all()
        return {row.key.split(":", 1)[1]: json.loads(row.value) for row in rows}


def snapshot(flow, approval_id):
    with flow.sessions() as db:
        a = db.get(ApprovalRequest, approval_id)
        return (a.status, a.ai_reply, a.edited_reply, a.manager_telegram_id, a.approved_at)


def prepare(flow, approval_id, text="Изменённый ответ", **kwargs):
    existing = set(proposals(flow))
    with flow.sessions() as db:
        result = edits.prepare_reply(db, reply(approval_id, text, **kwargs), "111", "111")
    assert result == {"ok": True, "action": "edit_preview"}
    created = set(proposals(flow)) - existing
    assert len(created) == 1
    return created.pop()


def confirm(flow, token, accept=True, actor="111", chat="111", approval_id=None):
    with flow.sessions() as db:
        return edits.confirm(db, token, actor, chat, accept, approval_id)


@pytest.mark.parametrize("keyboard", [True, False])
@pytest.mark.parametrize("stored_ids", ['{"111":"222"}', '{"111": "222", "555": "666"}', '222'])
def test_direct_reply_preview_is_nonmutating_with_or_without_keyboard(flow, approval_id, keyboard, stored_ids):
    with flow.sessions() as db:
        db.get(ApprovalRequest, approval_id).telegram_message_id = stored_ids
        db.commit()
    before = snapshot(flow, approval_id)
    text = "Готовый <ответ> & условия"
    response = flow.client.post(URL, json={"update_id": 101, "message": reply(approval_id, text, keyboard=keyboard)})
    assert response.json() == {"ok": True, "action": "edit_preview"}
    token, proposal = next(iter(proposals(flow).items()))
    assert {k: proposal[k] for k in ("approval_id", "actor", "chat", "text", "snapshot", "original")} == {
        "approval_id": approval_id, "actor": "111", "chat": "111", "text": text,
        "snapshot": None, "original": before[1]}
    assert snapshot(flow, approval_id) == before
    assert flow.sent == []
    preview = telegram.send_text.call_args
    assert preview.args[0] == "111" and text in preview.args[1]
    assert "tg://openmessage?user_id=111&message_id=222" in preview.args[1]
    assert preview.kwargs["reply_to_message_id"] == 444
    buttons = preview.kwargs["reply_markup"]["inline_keyboard"][0]
    assert [b["callback_data"] for b in buttons] == [f"edit_accept:{token}", f"edit_discard:{token}"]
    with flow.sessions() as db:
        assert db.scalar(select(Message).where(Message.direction == "outgoing")) is None
        assert db.scalar(select(TrainingExample)) is None
        assert db.scalar(select(ActionLog).where(ActionLog.action == "telegram.approval_edited")) is None


@pytest.mark.parametrize("keyboard", [True, False])
@pytest.mark.parametrize("chat,target", [(555, 222), (111, 999)])
def test_direct_reply_cannot_bind_a_forged_card_pair(flow, approval_id, keyboard, chat, target):
    before = snapshot(flow, approval_id)
    message = reply(approval_id, keyboard=keyboard, chat=chat, target=target)
    with flow.sessions() as db:
        assert edits.prepare_reply(db, message, "111", str(chat)) is None
    assert snapshot(flow, approval_id) == before
    assert not proposals(flow) and not flow.sent
    telegram.send_text.assert_not_called()


def test_unbound_reply_does_not_consume_another_legacy_session(flow, approval_id):
    with flow.sessions() as db:
        pipeline.set_edit_session(db, "111", approval_id)
    result = flow.client.post(URL, json={"update_id": 102, "message": reply(approval_id, target=999)}).json()
    assert result == {"ok": True, "action": "reply_not_bound"}
    with flow.sessions() as db:
        assert pipeline.pop_edit_session(db, "111") == approval_id
    assert not proposals(flow) and not flow.sent


def test_force_reply_binds_prompt_to_actor_chat_and_original_card(flow, approval_id, monkeypatch):
    monkeypatch.setattr(edits, "_now", lambda: 1000)
    with flow.sessions() as db:
        assert edits.prompt_edit(db, db.get(ApprovalRequest, approval_id), "111", "111", 222)
        prompt = json.loads(db.scalar(select(Setting).where(Setting.key == "telegram_edit_prompt:111:333")).value)
    assert prompt == {"approval_id": approval_id, "actor": "111", "chat": "111",
                      "original_id": 222, "expires_at": 2800}
    call = telegram.send_text.call_args
    assert call.kwargs == {"reply_markup": {"force_reply": True, "selective": True}, "reply_to_message_id": 222}
    for actor, chat in [("222", "111"), ("111", "555")]:
        with flow.sessions() as db:
            assert edits.prepare_reply(db, reply(approval_id, target=333, keyboard=False), actor, chat) is None
    token = prepare(flow, approval_id, "Текст из подсказки", target=333, keyboard=False)
    assert proposals(flow)[token]["approval_id"] == approval_id
    assert "message_id=222" in telegram.send_text.call_args.args[1]
    assert snapshot(flow, approval_id)[2] is None and not flow.sent


def test_expired_force_reply_prompt_cannot_create_proposal(flow, approval_id, monkeypatch):
    monkeypatch.setattr(edits, "_now", lambda: 1000)
    with flow.sessions() as db:
        assert edits.prompt_edit(db, db.get(ApprovalRequest, approval_id), "111", "111", 222)
    monkeypatch.setattr(edits, "_now", lambda: 2800.001)
    with flow.sessions() as db:
        assert edits.prepare_reply(db, reply(approval_id, target=333, keyboard=False), "111", "111") is None
    assert not proposals(flow) and not flow.sent


def test_force_reply_requires_a_delivered_prompt(flow, approval_id):
    telegram.send_text.return_value = {"ok": False}
    with flow.sessions() as db:
        assert not edits.prompt_edit(db, db.get(ApprovalRequest, approval_id), "111", "111", 222)
        assert db.scalar(select(Setting).where(Setting.key.like("telegram_edit_prompt:%"))) is None


def mock_voice(monkeypatch, *, transcript="Сделай короче, баасын такта", edited="Кыска жооп.",
               file_path="voice/test.ogg"):
    requests = []

    def transport(request):
        requests.append(request)
        if request.url.path.endswith("/getFile"):
            assert json.loads(request.content) == {"file_id": "synthetic-file"}
            return httpx.Response(200, json={"ok": True, "result": {"file_path": file_path}})
        assert request.method == "GET" and request.url.path.endswith("/" + file_path)
        return httpx.Response(200, content=b"synthetic-ogg")

    monkeypatch.setattr(edits.httpx, "Client", lambda **kw: HTTP_CLIENT(transport=httpx.MockTransport(transport), **kw))
    asr = Mock(side_effect=transcript) if isinstance(transcript, Exception) else Mock(return_value=transcript)
    ai = Mock(return_value=AIResult(content=edited, model="mock-ai", purpose="edit_reply"))
    monkeypatch.setattr(edits, "transcribe_audio_bytes", asr)
    monkeypatch.setattr(edits, "ai_edit_reply", ai)
    return asr, ai, requests


@pytest.mark.parametrize("media", ["voice", "audio"])
@pytest.mark.parametrize("file_path,filename,mime_type", [
    ("voice/recording.wav", "recording.wav", "audio/wav"),
    ("music/recording.mp3", "recording.mp3", "audio/mpeg"),
    ("voice/file_0.oga", "file_0.ogg", "audio/ogg"),
    ("voice/recording.ogg", "recording.ogg", "audio/ogg"),
])
def test_voice_reply_downloads_then_asr_then_ai_without_mutating_draft(
    flow, approval_id, monkeypatch, media, file_path, filename, mime_type,
):
    with flow.sessions() as db:
        assert pipeline.apply_edited_reply(db, approval_id, "111", "Текущая ручная правка")
    before = snapshot(flow, approval_id)
    asr, ai, requests = mock_voice(monkeypatch, edited="  Уточнённый ответ  ", file_path=file_path)
    message = reply(approval_id, text="")
    # Native Telegram voice has no file_name; getFile determines the ASR name.
    message[media] = {"file_id": "synthetic-file", "file_unique_id": "synthetic-unique",
                      "file_size": 13, "duration": 2, "mime_type": mime_type}
    if media == "audio":
        message[media]["file_name"] = "client-upload-name.ogg"
    response = flow.client.post(URL, json={"update_id": 103, "message": message})
    assert response.json() == {"ok": True, "action": "edit_preview"}
    assert len(requests) == 2
    asr.assert_called_once_with(b"synthetic-ogg", filename)
    with flow.sessions() as db:
        client_message = db.get(ApprovalRequest, approval_id).client_message
    ai.assert_called_once_with("Текущая ручная правка", client_message, "Сделай короче, баасын такта")
    assert next(iter(proposals(flow).values()))["text"] == "Уточнённый ответ"
    preview = telegram.send_text.call_args.args[1]
    assert "message_id=222" in preview and "message_id=444" in preview
    assert snapshot(flow, approval_id) == before and not flow.sent


@pytest.mark.parametrize("transcript", ["", "   ", RuntimeError("synthetic ASR failure")])
def test_failed_or_empty_asr_never_invokes_ai_or_creates_proposal(flow, approval_id, monkeypatch, transcript):
    before = snapshot(flow, approval_id)
    asr, ai, _ = mock_voice(monkeypatch, transcript=transcript)
    message = reply(approval_id, text="")
    message["voice"] = {"file_id": "synthetic-file"}
    result = flow.client.post(URL, json={"update_id": 104, "message": message}).json()
    assert result == {"ok": False, "error": "edit_preview_failed"}
    asr.assert_called_once()
    ai.assert_not_called()
    assert not proposals(flow) and not flow.sent
    assert snapshot(flow, approval_id) == before


def test_long_preview_shows_every_character_and_plain_text_transport(flow, approval_id, monkeypatch):
    # Exercise the real Telegram serializer too: markup-like text stays literal.
    payloads = []

    def transport(request):
        payloads.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 777}})

    monkeypatch.setattr(telegram, "send_text", SEND_TEXT)
    monkeypatch.setattr(telegram.httpx, "Client", lambda **kw: HTTP_CLIENT(transport=httpx.MockTransport(transport), **kw))
    text = "<b>Кыргызча & русский</b>\n" * 170 + "ВИДИМЫЙ КОНЕЦ"
    token = prepare(flow, approval_id, text)
    assert len(payloads) > 1
    displayed = []
    for i, payload in enumerate(payloads):
        assert payload["chat_id"] == "111"
        assert payload["reply_parameters"] == {"message_id": 444}
        assert "parse_mode" not in payload
        assert len(payload["text"]) <= 4096
        body = payload["text"].removeprefix("✏️ Изменённый ответ:\n")
        if i == len(payloads) - 1:
            body = body.split("\n\nИсходный ответ:", 1)[0]
            assert payload["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"edit_accept:{token}"
        else:
            assert "reply_markup" not in payload
        displayed.append(body)
    assert "".join(displayed) == text
    assert not flow.sent
    assert confirm(flow, token)
    assert "\n\n".join(item[-1] for item in flow.sent) == text
    assert not confirm(flow, token)


@pytest.mark.parametrize("accept", [True, False])
def test_decision_is_single_use_preserves_exact_text_and_actor_audit(flow, approval_id, accept):
    before = snapshot(flow, approval_id)
    text = "Точный <ответ> & баасы 500 сом."
    token = prepare(flow, approval_id, text)
    assert confirm(flow, token, accept)
    assert not confirm(flow, token, not accept)
    assert not confirm(flow, token, accept)
    assert not proposals(flow)
    if not accept:
        assert snapshot(flow, approval_id) == before and not flow.sent
        return
    assert len(flow.sent) == 1 and flow.sent[0][-1] == text
    with flow.sessions() as db:
        approval = db.get(ApprovalRequest, approval_id)
        assert approval.status == "sent" and approval.edited_reply == text
        assert approval.ai_reply == before[1] and approval.manager_telegram_id == "111"
        training = db.scalar(select(TrainingExample))
        assert training.final_reply == text and training.was_edited
        assert training.manager_telegram_id == "111"
        for action in ("telegram.approval_edited", "telegram.approval_approved"):
            rows = db.scalars(select(ActionLog).where(ActionLog.action == action)).all()
            assert len(rows) == 1 and rows[0].request_payload["actor_id"] == "111"


@pytest.mark.parametrize("accept", [True, False])
@pytest.mark.parametrize("actor,chat", [("222", "111"), ("111", "555"), ("crm-id:employee-a", "crm")])
def test_proposal_wrong_actor_or_chat_cannot_consume_it(flow, approval_id, accept, actor, chat):
    token = prepare(flow, approval_id)
    before = snapshot(flow, approval_id)
    assert not confirm(flow, token, accept, actor, chat)
    assert token in proposals(flow)
    assert snapshot(flow, approval_id) == before and not flow.sent
    assert confirm(flow, token, False)


@pytest.mark.parametrize("accept", [True, False])
def test_proposal_expires_after_thirty_minutes(flow, approval_id, monkeypatch, accept):
    monkeypatch.setattr(edits, "_now", lambda: 1000)
    token = prepare(flow, approval_id)
    assert proposals(flow)[token]["expires_at"] == 2800
    before = snapshot(flow, approval_id)
    monkeypatch.setattr(edits, "_now", lambda: 2800.001)
    assert not confirm(flow, token, accept)
    assert snapshot(flow, approval_id) == before and not flow.sent


@pytest.mark.parametrize("change", ["edit", "ai", "approve", "reject"])
def test_stale_preview_cannot_overwrite_a_new_edit_or_terminal_decision(flow, approval_id, change):
    token = prepare(flow, approval_id, "Устаревшее предложение")
    with flow.sessions() as stale, flow.sessions() as other:
        stale_approval = stale.get(ApprovalRequest, approval_id)
        assert stale_approval.status == "pending"
        if change == "edit":
            assert pipeline.apply_edited_reply(other, approval_id, "222", "Новая правка")
        elif change == "ai":
            other.get(ApprovalRequest, approval_id).ai_reply = "Новый исходный AI-ответ"
            other.commit()
        elif change == "approve":
            assert pipeline.approve_request(other, approval_id, "222")
        else:
            assert pipeline.reject_request(other, approval_id, "222", "Отклонено")
        current = snapshot(flow, approval_id)
        assert stale_approval.status == "pending" and stale_approval.edited_reply is None
        assert not edits.confirm(stale, token, "111", "111", True)
    assert snapshot(flow, approval_id) == current
    assert not confirm(flow, token)
    assert len(flow.sent) == (1 if change == "approve" else 0)
    if flow.sent:
        assert flow.sent[0][-1] == current[1]


@pytest.mark.parametrize("boundary", ["apply", "approve"])
def test_edit_race_at_cas_boundaries_retains_other_manager_text(flow, approval_id, monkeypatch, boundary):
    token = prepare(flow, approval_id, "Устаревший текст")
    apply = pipeline.apply_edited_reply
    original = apply if boundary == "apply" else pipeline.approve_request

    def interleaved(db, *args, **kwargs):
        with flow.sessions() as other:
            assert apply(other, approval_id, "222", "Победившая правка")
        return original(db, *args, **kwargs)

    monkeypatch.setattr(pipeline, "apply_edited_reply" if boundary == "apply" else "approve_request", interleaved)
    assert not confirm(flow, token)
    assert snapshot(flow, approval_id)[2:4] == ("Победившая правка", "222")
    assert not flow.sent


def test_competing_previews_only_first_can_send(flow, approval_id):
    first = prepare(flow, approval_id, "Первый ответ")
    second = prepare(flow, approval_id, "Второй ответ")
    assert first != second and confirm(flow, first)
    assert not confirm(flow, second)
    assert len(flow.sent) == 1 and flow.sent[0][-1] == "Первый ответ"


@pytest.mark.parametrize("boundary", ["apply", "approve"])
def test_other_manager_approval_wins_at_either_cas_boundary_without_resend(flow, approval_id, monkeypatch, boundary):
    original_reply = snapshot(flow, approval_id)[1]
    token = prepare(flow, approval_id, "Предложенный ответ")
    approve = pipeline.approve_request
    original = pipeline.apply_edited_reply if boundary == "apply" else approve

    def interleaved(db, *args, **kwargs):
        with flow.sessions() as other:
            assert approve(other, approval_id, "222")
        return original(db, *args, **kwargs)

    monkeypatch.setattr(pipeline, "apply_edited_reply" if boundary == "apply" else "approve_request", interleaved)
    assert not confirm(flow, token)
    assert not confirm(flow, token)
    assert len(flow.sent) == 1
    assert flow.sent[0][-1] == (original_reply if boundary == "apply" else "Предложенный ответ")
    current = snapshot(flow, approval_id)
    assert current[0] == "sent" and current[3] == "222"


def test_racing_decisions_after_same_proposal_read_are_consumed_once(flow, approval_id, monkeypatch):
    token = prepare(flow, approval_id, "Один ответ")
    get_proposal = edits._get
    raced = False

    def interleaved(db, key, actor, chat):
        nonlocal raced
        data = get_proposal(db, key, actor, chat)
        if data and not raced:
            raced = True
            with flow.sessions() as other:
                assert edits.confirm(other, token, actor, chat, True)
        return data

    monkeypatch.setattr(edits, "_get", interleaved)
    assert not confirm(flow, token)
    assert raced and not proposals(flow)
    assert len(flow.sent) == 1 and flow.sent[0][-1] == "Один ответ"


def test_unauthorized_webhook_cannot_prepare_or_confirm(flow, approval_id):
    token = prepare(flow, approval_id)
    assert flow.client.post(URL, json={"update_id": 105, "message": reply(approval_id, actor=999)}).json()["error"] == "unauthorized_manager"
    payload = {"update_id": 106, "callback_query": {"id": "unauthorized", "from": {"id": 999},
        "message": {"chat": {"id": 111}}, "data": f"edit_accept:{token}"}}
    assert flow.client.post(URL, json=payload).json()["error"] == "unauthorized_manager"
    assert token in proposals(flow) and not flow.sent


def test_webhook_discard_keeps_existing_manual_reply_and_is_not_card_rejection(flow, approval_id):
    with flow.sessions() as db:
        assert pipeline.apply_edited_reply(db, approval_id, "222", "Уже проверенный ответ")
    before = snapshot(flow, approval_id)
    token = prepare(flow, approval_id, "Новая неподтверждённая правка")
    payload = {"update_id": 107, "callback_query": {"id": "discard", "from": {"id": 111},
        "message": {"chat": {"id": 111}}, "data": f"edit_discard:{token}"}}
    assert flow.client.post(URL, json=payload).json() == {"ok": True, "action": "edit_discard"}
    assert flow.client.post(URL, json=payload).json()["duplicate"]
    assert not confirm(flow, token)
    assert snapshot(flow, approval_id) == before and not flow.sent
    with flow.sessions() as db:
        assert pipeline.approve_request(db, approval_id, "222")
    assert len(flow.sent) == 1 and flow.sent[0][-1] == "Уже проверенный ответ"


@pytest.mark.parametrize("edited", ["", "   ", "x" * 12001])
def test_invalid_ai_edit_never_replaces_draft_or_sends(flow, approval_id, monkeypatch, edited):
    mock_voice(monkeypatch, edited=edited)
    before = snapshot(flow, approval_id)
    message = reply(approval_id, text="")
    message["voice"] = {"file_id": "synthetic-file"}
    response = flow.client.post(URL, json={"update_id": 108, "message": message})
    assert response.json() == {"ok": False, "error": "edit_preview_failed"}
    assert snapshot(flow, approval_id) == before and not proposals(flow) and not flow.sent


def test_voice_size_guard_blocks_download_asr_and_ai(flow, approval_id, monkeypatch):
    asr, ai, requests = mock_voice(monkeypatch)
    message = reply(approval_id, text="")
    message["voice"] = {"file_id": "synthetic-file", "file_size": 20 * 1024 * 1024 + 1}
    response = flow.client.post(URL, json={"update_id": 109, "message": message})
    assert response.json() == {"ok": False, "error": "edit_preview_failed"}
    assert not requests and not proposals(flow) and not flow.sent
    asr.assert_not_called()
    ai.assert_not_called()


def test_group_preview_links_point_to_card_and_voice_instruction(flow, approval_id, monkeypatch):
    chat = "-10012345"
    with flow.sessions() as db:
        db.get(ApprovalRequest, approval_id).telegram_message_id = json.dumps({chat: "222"})
        db.commit()
    mock_voice(monkeypatch)
    message = reply(approval_id, text="", chat=int(chat), keyboard=False)
    message["voice"] = {"file_id": "synthetic-file"}
    with flow.sessions() as db:
        assert edits.prepare_reply(db, message, "111", chat)["action"] == "edit_preview"
    preview = telegram.send_text.call_args.args[1]
    assert "https://t.me/c/12345/222" in preview and "https://t.me/c/12345/444" in preview
    assert not flow.sent


def preview_url(approval_id):
    return f"/admin/approvals/{approval_id}/edit-preview"


@pytest.mark.parametrize("decision", ["accept", "discard"])
def test_crm_preview_decision_auth_actor_and_approval_binding(flow, approval_id, decision):
    url = preview_url(approval_id)
    before = snapshot(flow, approval_id)
    body = {"reply": "Точный ответ из CRM", "expected_current": before[1]}
    assert flow.client.post(url, json=body).status_code == 401
    assert not proposals(flow)
    response = flow.client.post(url, json=body, headers=HEADERS)
    assert response.status_code == 200
    result = response.json()
    assert result["edited_reply"] == body["reply"]
    token = result["proposal_token"]
    proposal = proposals(flow)[token]
    assert proposal["actor"] == "crm-id:employee-a" and proposal["chat"] == "crm"
    assert snapshot(flow, approval_id) == before and not flow.sent
    decision_url = f"{url}/{token}/{decision}"
    assert flow.client.post(decision_url).status_code == 401
    assert flow.client.post(decision_url, headers={**HEADERS, "X-Employee-ID": "employee-b"}).status_code == 409
    assert flow.client.post(f"{preview_url(approval_id + 100)}/{token}/{decision}", headers=HEADERS).status_code == 409
    assert not confirm(flow, token, actor="111", chat="111")
    assert token in proposals(flow) and not flow.sent
    assert flow.client.post(decision_url, headers=HEADERS).json() == {
        "ok": True, "status": "sent" if decision == "accept" else "discarded"}
    assert flow.client.post(decision_url, headers=HEADERS).status_code == 409
    if decision == "discard":
        assert snapshot(flow, approval_id) == before and not flow.sent
    else:
        assert len(flow.sent) == 1 and flow.sent[0][-1] == body["reply"]
        assert snapshot(flow, approval_id)[2:4] == (body["reply"], "crm-id:employee-a")


@pytest.mark.parametrize("edited", [False, True])
def test_crm_expected_current_rejects_stale_screen_before_ai(flow, approval_id, monkeypatch, edited):
    old = snapshot(flow, approval_id)[1]
    if edited:
        with flow.sessions() as db:
            assert pipeline.apply_edited_reply(db, approval_id, "222", "Более новая правка")
    ai = Mock(return_value=AIResult(content="Предложение", model="mock-ai", purpose="edit_reply"))
    monkeypatch.setattr(edits, "ai_edit_reply", ai)
    current = snapshot(flow, approval_id)
    url = preview_url(approval_id)
    body = {"reply": "Локальный текст", "prompt": "Сделай короче", "expected_current": old if edited else "Устаревший экран"}
    assert flow.client.post(url, json=body, headers=HEADERS).status_code == 409
    ai.assert_not_called()
    assert not proposals(flow)
    body["expected_current"] = "  " + (current[2] or current[1]) + "  "
    response = flow.client.post(url, json=body, headers=HEADERS)
    assert response.status_code == 200 and response.json()["edited_reply"] == "Предложение"
    with flow.sessions() as db:
        client_message = db.get(ApprovalRequest, approval_id).client_message
    ai.assert_called_once_with("Локальный текст", client_message, "Сделай короче")
    assert snapshot(flow, approval_id) == current and not flow.sent


@pytest.mark.parametrize("change", ["edit", "ai", "approve", "reject"])
def test_crm_accept_rechecks_snapshot_after_preview(flow, approval_id, change):
    url = preview_url(approval_id)
    token = flow.client.post(url, json={"reply": "Устаревший CRM ответ"}, headers=HEADERS).json()["proposal_token"]
    with flow.sessions() as db:
        if change == "edit":
            assert pipeline.apply_edited_reply(db, approval_id, "222", "Новая правка")
        elif change == "ai":
            db.get(ApprovalRequest, approval_id).ai_reply = "Новая генерация"
            db.commit()
        elif change == "approve":
            assert pipeline.approve_request(db, approval_id, "222")
        else:
            assert pipeline.reject_request(db, approval_id, "222", "Отказ")
    current = snapshot(flow, approval_id)
    assert flow.client.post(f"{url}/{token}/accept", headers=HEADERS).status_code == 409
    assert snapshot(flow, approval_id) == current
    assert len(flow.sent) == (1 if change == "approve" else 0)


def test_crm_slow_ai_preview_cannot_apply_over_new_manager_edit(flow, approval_id, monkeypatch):
    original = snapshot(flow, approval_id)[1]

    def slow_ai(*args):
        with flow.sessions() as db:
            assert pipeline.apply_edited_reply(db, approval_id, "222", "Правка во время AI")
        return AIResult(content="Запоздавший AI", model="mock-ai", purpose="edit_reply")

    monkeypatch.setattr(edits, "ai_edit_reply", slow_ai)
    url = preview_url(approval_id)
    response = flow.client.post(url, json={"reply": original, "prompt": "Сократи", "expected_current": original}, headers=HEADERS)
    assert response.status_code == 200
    token = response.json()["proposal_token"]
    assert flow.client.post(f"{url}/{token}/accept", headers=HEADERS).status_code == 409
    assert snapshot(flow, approval_id)[2:4] == ("Правка во время AI", "222")
    assert not flow.sent


def test_crm_expired_proposal_and_invalid_decision_cannot_mutate(flow, approval_id, monkeypatch):
    monkeypatch.setattr(edits, "_now", lambda: 1000)
    url = preview_url(approval_id)
    token = flow.client.post(url, json={"reply": "Ответ"}, headers=HEADERS).json()["proposal_token"]
    assert flow.client.post(f"{url}/{token}/unknown", headers=HEADERS).status_code == 404
    assert token in proposals(flow)
    monkeypatch.setattr(edits, "_now", lambda: 2801)
    for decision in ("accept", "discard"):
        assert flow.client.post(f"{url}/{token}/{decision}", headers=HEADERS).status_code == 409
    current = snapshot(flow, approval_id)
    assert current[0] == "pending" and current[2] is None
    assert not flow.sent


@pytest.mark.parametrize("body,status", [
    ({"reply": "   "}, 400), ({"reply": "x" * 10001}, 422),
    ({"reply": "Ответ", "prompt": "x" * 2001}, 422),
    ({"reply": "Ответ", "expected_current": "x" * 10001}, 422),
])
def test_crm_invalid_preview_never_mutates_or_creates_proposal(flow, approval_id, body, status):
    before = snapshot(flow, approval_id)
    assert flow.client.post(preview_url(approval_id), json=body, headers=HEADERS).status_code == status
    assert snapshot(flow, approval_id) == before and not proposals(flow) and not flow.sent


def test_crm_discard_preserves_existing_manual_edit(flow, approval_id):
    with flow.sessions() as db:
        assert pipeline.apply_edited_reply(db, approval_id, "222", "Предыдущая ручная правка")
    before = snapshot(flow, approval_id)
    url = preview_url(approval_id)
    response = flow.client.post(url, json={"reply": "Предложение", "expected_current": before[2]}, headers=HEADERS)
    assert response.status_code == 200
    token = response.json()["proposal_token"]
    assert flow.client.post(f"{url}/{token}/discard", headers=HEADERS).status_code == 200
    assert snapshot(flow, approval_id) == before and not flow.sent


def test_crm_preview_cannot_reopen_a_processed_or_missing_card(flow, approval_id):
    with flow.sessions() as db:
        assert pipeline.reject_request(db, approval_id, "222", "Обработано")
    before = snapshot(flow, approval_id)
    for target in (approval_id, approval_id + 100):
        assert flow.client.post(preview_url(target), json={"reply": "Поздняя правка"}, headers=HEADERS).status_code == 409
    assert snapshot(flow, approval_id) == before and not proposals(flow) and not flow.sent
