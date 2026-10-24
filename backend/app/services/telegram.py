import json
import logging
import re
from html import escape
from urllib.parse import quote

import httpx

_PICTURE_RE = re.compile(r'\[(?:picture|photo|image|media)\]\s*(https?://\S+)')
_VOICE_RE = re.compile(r'\[(?:voice|audio)\]\s*(https?://\S+)')


def _html_excerpt(text: str, limit: int = 1700) -> str:
    """Bound an escaped preview without cutting through an HTML entity."""
    if len(escape(text).encode('utf-16-le')) // 2 <= limit:
        return escape(text)
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if len(escape(text[:mid]).encode('utf-16-le')) // 2 <= limit - 1:
            low = mid
        else:
            high = mid - 1
    return escape(text[:low]) + "…"


def _fmt_client_message(text: str) -> str:
    """Format client message for Telegram card display."""
    stripped = text.strip()
    m = _PICTURE_RE.match(stripped)
    if m:
        url = escape(m.group(1), quote=True)
        label = f'📷 <a href="{url}">фотография</a>' if len(url) <= 600 else "📷 фотография"
        caption = stripped[m.end():].strip()
        return label + ("\n" + _html_excerpt(caption, 1700 - len(label) - 1) if caption else "")
    m = _VOICE_RE.match(stripped)
    if m:
        url = escape(m.group(1), quote=True)
        label = f'🎤 <a href="{url}">голосовое сообщение</a>' if len(url) <= 600 else "🎤 голосовое сообщение"
        transcript = stripped[m.end():].strip()
        if transcript:
            label += f': «{_html_excerpt(transcript, 1700 - len(label) - 3)}»'
        return label
    return _html_excerpt(text)


def _fmt_phone(raw: str) -> str:
    """Format a raw phone string to +996 XXX XXX XXX style."""
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return raw
    # Ensure leading +
    if digits.startswith("996") and len(digits) == 12:
        return f"+{digits[:3]} {digits[3:6]} {digits[6:9]} {digits[9:]}"
    if digits.startswith("7") and len(digits) == 11:
        return f"+{digits[0]} {digits[1:4]} {digits[4:7]} {digits[7:]}"
    if not digits.startswith("+") and len(digits) >= 10:
        return f"+{digits}"
    return raw


def looks_like_phone(raw: str | None) -> bool:
    """True, если строка целиком — номер: amoCRM кладёт его в имя автора, когда имени нет."""
    value = raw or ""
    digits = re.sub(r"\D", "", value)
    return bool(digits) and len(digits) >= 9 and digits == re.sub(r"\s", "", value)


from app.core.config import settings
from app.models.entities import ApprovalRequest, Lead
from app.services.openai_service import PURCHASE_PLACEHOLDER
from app.services.outgoing import split_outgoing_messages

_log = logging.getLogger(__name__)


def calc_score(extracted: dict | None, messages_count: int = 1) -> int:
    score = 10
    if not extracted:
        return score
    if extracted.get("skin_problem"):
        score += 20
    if extracted.get("city"):
        score += 15
    if extracted.get("experience"):
        score += 10
    if extracted.get("consultation_confirmed"):
        score += 30
    elif extracted.get("consultation_date"):
        score += 15
    if messages_count >= 5:
        score += 10
    elif messages_count >= 3:
        score += 5
    return min(score, 99)


def telegram_enabled() -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_manager_chat_id)


def _parse_message_ids(telegram_message_id: str | None) -> list[tuple[str, str]]:
    """Return list of (chat_id, message_id) from stored telegram_message_id (JSON or legacy plain id)."""
    if not telegram_message_id:
        return []
    try:
        data = json.loads(telegram_message_id)
        if isinstance(data, dict):
            return [(chat_id, str(mid)) for chat_id, mid in data.items()]
    except (json.JSONDecodeError, ValueError):
        pass
    # Legacy: plain message_id string, assume primary chat
    if settings.telegram_manager_chat_id:
        return [(settings.telegram_manager_chat_id, telegram_message_id)]
    return []


def _all_manager_chat_ids(extra: list[str] | None = None) -> list[str]:
    ids = [settings.telegram_manager_chat_id] if settings.telegram_manager_chat_id else []
    for item in settings.telegram_extra_manager_chat_ids.split(","):
        item = item.strip()
        if item and item not in ids:
            ids.append(item)
    if extra:
        for item in extra:
            if item and item not in ids:
                ids.append(item)
    return ids


def allowed_manager_ids() -> set[str]:
    return {
        item.strip()
        for item in settings.telegram_allowed_manager_ids.split(",")
        if item.strip()
    }


def is_authorized_manager(manager_id: str, chat_id: str | None = None, extra_allowed: set[str] | None = None) -> bool:
    if not manager_id.isascii() or not manager_id.isdigit() or int(manager_id) <= 0:
        return False
    # Main manager always has access
    if settings.telegram_manager_chat_id and str(settings.telegram_manager_chat_id) == manager_id:
        return True
    # Check explicit allow-list (env var + DB managers passed as extra_allowed)
    allowed_ids = allowed_manager_ids()
    if extra_allowed:
        allowed_ids = allowed_ids | extra_allowed
    if allowed_ids:
        return manager_id in allowed_ids
    return False


def _api_url(method: str) -> str:
    return f"https://api.telegram.org/bot{settings.telegram_bot_token}/{method}"


def is_test_lead(lead: Lead | None) -> bool:
    return bool(lead is not None and getattr(lead, "is_test", False))


def test_banner(lead: Lead | None) -> str:
    """Шапка карточки тестового пользователя.

    Менеджер работает с ней как с обычной, но должен сразу видеть, что клиент
    ненастоящий: ответ никуда не уйдёт, а лида в amoCRM не существует.
    """
    return "🧪 <b>ТЕСТОВЫЙ ПОЛЬЗОВАТЕЛЬ</b> · лаборатория\n" if is_test_lead(lead) else ""


def lead_url(lead: Lead) -> str:
    return f"{settings.amocrm_base_url.rstrip('/')}/leads/detail/{lead.amocrm_lead_id}"


def _has_amocrm_link(lead: Lead) -> bool:
    source = (getattr(getattr(lead, 'client', None), 'source', '') or '').lower()
    return not is_test_lead(lead) and 'green' not in source and 'instagram_meta' not in source


def crm_chat_url(lead: Lead) -> str:
    return f"{settings.frontend_url.rstrip('/')}/dashboard/dialogs?lead={quote(str(lead.amocrm_lead_id), safe='')}"


def chat_history_url(lead: Lead) -> str:
    return f"{settings.frontend_url.rstrip('/')}/chat/{lead.amocrm_lead_id}"


def memory_lines(extracted: dict | None) -> str:
    """Compact memory block for the approval card."""
    if not extracted:
        return "- Пока нет извлеченной памяти"
    skin_problem = ", ".join(extracted.get("skin_problem") or []) or "не указано"
    return "\n".join(
        [
            f"- Проблема: {escape(skin_problem)}",
            f"- Город: {escape(str(extracted.get('city') or 'не указан'))}",
            f"- Опыт: {escape(str(extracted.get('experience') or 'не указан'))}",
            f"- Была консультация: {'да' if extracted.get('consultation_confirmed') else 'нет'}",
        ]
    )


def _mem(extracted: dict, key: str, empty: str = "не указано") -> str:
    val = extracted.get(key)
    if isinstance(val, list):
        val = ", ".join(str(v) for v in val)
    return escape(str(val)) if val not in (None, "", []) else empty


def client_memory_card(extracted: dict | None, lead: Lead | None = None, approval_id: int | None = None) -> str:
    """Full client memory card + what's still unknown (for the 🧠 Память button)."""
    e = extracted or {}
    # Header: whose memory this is
    header = "🧠 Память"
    if lead is not None:
        raw_name = lead.client.name if lead.client else ""
        _digits = re.sub(r"\D", "", raw_name or "")
        _name_is_phone = bool(_digits) and len(_digits) >= 9 and _digits == re.sub(r"\s", "", raw_name or "")
        client_name = "Без имени" if (_name_is_phone or not raw_name) else raw_name
        raw_contact = (lead.client.phone if lead.client and lead.client.phone else None) or (raw_name if _name_is_phone else None) or lead.contact_id or "-"
        contact = _fmt_phone(raw_contact) if re.sub(r"\D", "", str(raw_contact)) else str(raw_contact)
        header = (
            f"🧠 Память клиента: {escape(client_name)}\n"
            f"📞 {escape(contact)} · Lead {escape(lead.amocrm_lead_id)}"
        )
        if approval_id:
            header += f" · №{approval_id:07d}"
    card = "\n".join([
        header,
        "",
        f"👤 Имя: {_mem(e, 'name')}",
        f"🎂 Возраст: {_mem(e, 'age', 'не указан')}",
        f"📍 Город: {_mem(e, 'city', 'не указан')}",
        "",
        f"✨ Тип кожи: {_mem(e, 'skin_type', 'не указан')}",
        f"🚨 Основная проблема: {_mem(e, 'skin_problem', 'не указана')}",
        f"🎯 Цель клиента: {_mem(e, 'goal', 'не указана')}",
        f"⏳ Длительность проблемы: {_mem(e, 'problem_duration', 'неизвестно')}",
        "",
        f"🧴 Использует уход: {_mem(e, 'uses_care', 'нет данных')}",
        f"💊 Аллергии: {_mem(e, 'allergies', 'неизвестно')}",
        f"🏥 Была консультация: {'да' if e.get('consultation_confirmed') else 'нет'}",
        "",
        f"🛍️ Покупал ранее: {_mem(e, 'bought_before', 'нет данных')}",
        f"📦 Какие средства использовал: {_mem(e, 'products_used', 'неизвестно')}",
        f"⭐ Что помогло: {_mem(e, 'what_helped', 'неизвестно')}",
        f"❌ Что не помогло: {_mem(e, 'what_not_helped', 'неизвестно')}",
        "",
        f"📅 Первый контакт: {_mem(e, '_first_contact', 'сегодня')}",
        f"📅 Последний контакт: {_mem(e, '_last_contact', 'сегодня')}",
        f"📝 Последнее действие: {_mem(e, 'last_action', '—')}",
    ])

    def _missing(key: str) -> bool:
        return e.get(key) in (None, "", [])

    critical = [label for key, label in [
        ("skin_type", "Тип кожи"), ("skin_problem", "Основную проблему"), ("goal", "Цель клиента"),
    ] if _missing(key)]
    important = [label for key, label in [
        ("age", "Возраст"), ("uses_care", "Использует ли уход"), ("allergies", "Есть ли аллергии"),
    ] if _missing(key)]
    useful = [label for key, label in [
        ("products_used", "Какие средства уже использовал"), ("what_helped", "Что помогло"), ("what_not_helped", "Что не помогло"),
    ] if _missing(key)]

    if critical or important or useful:
        card += "\n\n❓ Нужно узнать\n"
        if critical:
            card += "\n🔴 Критично\n" + "\n".join(f"• {x}" for x in critical)
        if important:
            card += "\n\n🟠 Важно\n" + "\n".join(f"• {x}" for x in important)
        if useful:
            card += "\n\n🟡 Полезно\n" + "\n".join(f"• {x}" for x in useful)
    return card


def _build_hashtags(contact: str, extracted: dict | None) -> str:
    tags: list[str] = []
    # Skin problem tags
    for problem in (extracted or {}).get("skin_problem") or []:
        slug = re.sub(r"\s+", "_", problem.strip().lower())
        slug = re.sub(r"[^\w]", "", slug, flags=re.UNICODE)
        if slug:
            tags.append(f"#{slug}")
    # City tag
    city = (extracted or {}).get("city")
    if city:
        slug = re.sub(r"\s+", "_", str(city).strip().lower())
        slug = re.sub(r"[^\w]", "", slug, flags=re.UNICODE)
        if slug:
            tags.append(f"#{slug}")
    return " ".join(tags)


def _format_reply_preview(reply: str) -> str:
    """Render separate outgoing messages as paragraphs, never as an internal marker."""
    return _html_excerpt("\n\n".join(split_outgoing_messages(reply)))


def _purchase_card(
    approval: ApprovalRequest,
    lead: Lead,
    decision: str | None = None,
    claimed_by_name: str | None = None,
) -> str:
    """Purchase approvals use the same short preview; an empty draft needs a manual reply."""
    return _approval_card_text(approval, lead, decision, claimed_by_name)


def _approval_card_text(
    approval: ApprovalRequest,
    lead: Lead,
    decision: str | None,
    claimed_by_name: str | None,
) -> str:
    reply = approval.edited_reply or approval.ai_reply
    preview = _format_reply_preview(reply) if reply else "Нет готового ответа. Измените вручную."
    text = (
        test_banner(lead)
        + f"💬 <b>Сообщение клиента:</b>\n{_fmt_client_message(approval.client_message or '')}\n\n"
        + f"🤖 <b>Ответ ИИ:</b>\n{preview}"
    )
    if approval.edited_reply:
        text += "\n\n✏️ Изменено вручную"
    if claimed_by_name:
        text += f"\n⏳ Редактирует: {_html_excerpt(claimed_by_name, 120)}"
    if decision:
        text += f"\n\n{_html_excerpt(decision, 240)}"
    return text


def approval_card(
    approval: ApprovalRequest,
    lead: Lead,
    decision: str | None = None,
    messages_count: int = 1,
    last_message_time: str | None = None,
    claimed_by_name: str | None = None,
    repeat_count: int = 0,
) -> str:
    if (approval.extracted_fields or {}).get("_purchase_intent"):
        return _purchase_card(approval, lead, decision, claimed_by_name)
    return _approval_card_text(approval, lead, decision, claimed_by_name)


def approval_keyboard(
    approval_id: int,
    lead: Lead,
    has_templates: bool = False,
    is_purchase: bool = False,
    has_edited: bool = False,
) -> dict:
    actions = []
    if not is_purchase or has_edited:
        actions.append({"text": "✅ Принять", "callback_data": f"approve:{approval_id}"})
    actions.append({"text": "❌ Отклонить", "callback_data": f"reject:{approval_id}"})
    rows = [
        actions,
        [{"text": "✏️ Изменить вручную", "callback_data": f"edit:{approval_id}"}],
        [{"text": "📋 Открыть в CRM", "url": crm_chat_url(lead)}],
    ]
    if _has_amocrm_link(lead):
        rows[-1].append({"text": "🔗 amoCRM", "url": lead_url(lead)})
    return {"inline_keyboard": rows}


def _has_sendable_purchase_reply(approval: ApprovalRequest) -> bool:
    reply = (approval.edited_reply or "").strip()
    return bool(reply) and PURCHASE_PLACEHOLDER not in reply


def send_templates_menu(chat_id: str | int, templates: list[dict], approval_id: int) -> dict:
    if not settings.telegram_bot_token or not templates:
        return {"skipped": True}
    rows = []
    for i in range(0, len(templates), 2):
        row = []
        for tpl in templates[i:i + 2]:
            row.append({
                "text": tpl["name"],
                "callback_data": f"tpl:{approval_id}:{tpl['id']}",
            })
        rows.append(row)
    rows.append([{"text": "✖ Отмена", "callback_data": f"tpl_cancel:{approval_id}"}])
    with httpx.Client(timeout=20) as client:
        resp = client.post(
            _api_url("sendMessage"),
            json={
                "chat_id": chat_id,
                "text": "📋 <b>Выберите шаблон ответа:</b>",
                "parse_mode": "HTML",
                "reply_markup": {"inline_keyboard": rows},
            },
        )
        resp.raise_for_status()
        return resp.json()


# Preset reject reasons shown as buttons; "other" opens a free-text follow-up.
# Keys are stable identifiers used in callback_data — the Russian labels are what
# the manager sees and what reject_request()/TrainingExample end up storing.
REJECT_REASON_PRESETS = {
    "tone": "Тон не тот",
    "fact_error": "Фактическая ошибка",
    "pushy": "Слишком навязчиво",
    "other": "Другое",
}


def send_reject_reason_menu(chat_id: str | int, approval_id: int) -> dict:
    if not settings.telegram_bot_token:
        return {"skipped": True}
    rows = []
    for i in range(0, len(REJECT_REASON_PRESETS), 2):
        row = []
        for key, label in list(REJECT_REASON_PRESETS.items())[i:i + 2]:
            row.append({"text": label, "callback_data": f"reject_reason:{approval_id}:{key}"})
        rows.append(row)
    with httpx.Client(timeout=20) as client:
        resp = client.post(
            _api_url("sendMessage"),
            json={
                "chat_id": chat_id,
                "text": "❌ <b>Почему отклоняете ответ?</b>",
                "parse_mode": "HTML",
                "reply_markup": {"inline_keyboard": rows},
            },
        )
        resp.raise_for_status()
        return resp.json()


def stages_keyboard(stages: list[dict], approval_id: int) -> dict:
    rows = []
    for stage in stages:
        stage_id = stage.get("id")
        stage_name = stage.get("name", "")
        if stage_id and stage_name:
            rows.append([{
                "text": stage_name,
                "callback_data": f"set_stage:{approval_id}:{stage_id}",
            }])
    rows.append([{"text": "✖ Отмена", "callback_data": f"cancel_stage:{approval_id}"}])
    return {"inline_keyboard": rows}


def send_stages_menu(chat_id: str | int, stages: list[dict], approval_id: int) -> dict:
    if not settings.telegram_bot_token:
        return {"skipped": True}
    with httpx.Client(timeout=20) as client:
        response = client.post(
            _api_url("sendMessage"),
            json={
                "chat_id": chat_id,
                "text": "📂 <b>Выберите этап для перемещения лида:</b>",
                "parse_mode": "HTML",
                "reply_markup": stages_keyboard(stages, approval_id),
            },
        )
        response.raise_for_status()
        return response.json()


def delete_message(chat_id: str | int, message_id: int) -> None:
    if not settings.telegram_bot_token:
        return
    with httpx.Client(timeout=10) as client:
        client.post(_api_url("deleteMessage"), json={"chat_id": chat_id, "message_id": message_id})


def _send_photo_to_chats(
    http: httpx.Client,
    chat_ids: list[str],
    reply_to_message_ids: dict[str, str] | None,
    photo_url: str | None = None,
    photo_bytes: bytes | None = None,
    photo_ext: str = "jpg",
    photo_content_type: str = "image/jpeg",
) -> bool:
    """Send a photo to all chats. Returns True if at least one succeeded."""
    ok = False
    for chat_id in chat_ids:
        try:
            base: dict = {"chat_id": chat_id}
            if reply_to_message_ids and chat_id in reply_to_message_ids:
                base["reply_to_message_id"] = reply_to_message_ids[chat_id]
            if photo_url:
                resp = http.post(_api_url("sendPhoto"), data={**base, "photo": photo_url})
            else:
                resp = http.post(
                    _api_url("sendPhoto"),
                    files={"photo": (f"photo.{photo_ext}", photo_bytes, photo_content_type)},
                    data=base,
                )
            if resp.is_success and resp.json().get("ok"):
                ok = True
            else:
                _log.warning("sendPhoto failed chat_id=%s status=%s", chat_id, resp.status_code)
        except Exception:
            _log.error("sendPhoto error chat_id=%s", chat_id)
    return ok


def _forward_client_photos(
    client_message: str,
    chat_ids: list[str],
    reply_to_message_ids: dict[str, str] | None = None,
) -> None:
    """Send [picture] attachments from the client message as Telegram photos."""
    urls = _PICTURE_RE.findall(client_message)
    if not urls or not settings.telegram_bot_token:
        return
    auth_headers = {}
    if settings.amocrm_access_token:
        auth_headers["Authorization"] = f"Bearer {settings.amocrm_access_token}"
    with httpx.Client(timeout=30, follow_redirects=True) as http:
        for url in urls[:5]:
            # Try sending URL directly — Telegram fetches it without our auth
            sent = _send_photo_to_chats(http, chat_ids, reply_to_message_ids, photo_url=url)
            if sent:
                continue
            # Fallback: download with amoCRM Bearer token and upload as binary
            try:
                img = http.get(url, headers=auth_headers)
                if not img.is_success:
                    _log.warning("photo download failed status=%s", img.status_code)
                    continue
                content_type = img.headers.get("content-type", "image/jpeg").split(";")[0].strip()
                ext = "jpg" if "jpeg" in content_type else content_type.split("/")[-1]
                _send_photo_to_chats(
                    http, chat_ids, reply_to_message_ids,
                    photo_bytes=img.content, photo_ext=ext, photo_content_type=content_type,
                )
            except Exception:
                _log.error("photo download error")


def _send_voice_to_chats(
    http: httpx.Client,
    chat_ids: list[str],
    reply_to_message_ids: dict[str, str] | None,
    voice_url: str | None = None,
    voice_bytes: bytes | None = None,
    caption: str = "",
) -> bool:
    """Send a playable voice note to all chats. Returns True if at least one succeeded."""
    ok = False
    for chat_id in chat_ids:
        try:
            base: dict = {"chat_id": chat_id}
            if caption:
                base["caption"] = caption[:1024]
            if reply_to_message_ids and chat_id in reply_to_message_ids:
                base["reply_to_message_id"] = reply_to_message_ids[chat_id]
            if voice_url:
                resp = http.post(_api_url("sendVoice"), data={**base, "voice": voice_url})
            else:
                resp = http.post(
                    _api_url("sendVoice"),
                    files={"voice": ("voice.ogg", voice_bytes, "audio/ogg")},
                    data=base,
                )
            if resp.is_success and resp.json().get("ok"):
                ok = True
            else:
                _log.warning("sendVoice failed chat_id=%s status=%s", chat_id, resp.status_code)
        except Exception:
            _log.error("sendVoice error chat_id=%s", chat_id)
    return ok


def _forward_client_voice(
    client_message: str,
    chat_ids: list[str],
    reply_to_message_ids: dict[str, str] | None = None,
) -> None:
    """Send the [voice] attachment from the client message as a playable Telegram voice note.

    So a manager can hear what the client actually said instead of trusting the
    Whisper transcript alone.
    """
    m = _VOICE_RE.match(client_message.strip())
    if not m or not settings.telegram_bot_token:
        return
    url = m.group(1)
    transcript = client_message.strip()[m.end():].strip()
    caption = f'Расшифровка: «{transcript}»'[:1024] if transcript else ""
    auth_headers = {}
    if settings.amocrm_access_token:
        auth_headers["Authorization"] = f"Bearer {settings.amocrm_access_token}"
    with httpx.Client(timeout=30, follow_redirects=True) as http:
        # Try sending the URL directly — Telegram fetches it without our auth
        sent = _send_voice_to_chats(http, chat_ids, reply_to_message_ids, voice_url=url, caption=caption)
        if sent:
            return
        # Fallback: download with amoCRM Bearer token and upload as binary
        try:
            audio = http.get(url, headers=auth_headers)
            if not audio.is_success:
                _log.warning("voice download failed status=%s", audio.status_code)
                return
            _send_voice_to_chats(
                http, chat_ids, reply_to_message_ids,
                voice_bytes=audio.content, caption=caption,
            )
        except Exception:
            _log.error("voice download error")


def send_approval_card(
    approval: ApprovalRequest,
    lead: Lead,
    messages_count: int = 1,
    extra_chat_ids: list[str] | None = None,
    last_message_time: str | None = None,
    has_templates: bool = False,
    repeat_count: int = 0,
) -> dict:
    if not telegram_enabled():
        raise RuntimeError("Telegram approval delivery is not configured")
    card_text = approval_card(approval, lead, messages_count=messages_count, last_message_time=last_message_time, repeat_count=repeat_count)
    is_purchase = bool((approval.extracted_fields or {}).get("_purchase_intent"))
    keyboard = approval_keyboard(
        approval.id, lead,
        has_templates=has_templates,
        is_purchase=is_purchase,
        has_edited=_has_sendable_purchase_reply(approval),
    )
    message_ids: dict[str, str] = {}
    last_response: dict = {}
    with httpx.Client(timeout=20) as client:
        for chat_id in _all_manager_chat_ids(extra_chat_ids):
            try:
                resp = client.post(
                    _api_url("sendMessage"),
                    json={
                        "chat_id": chat_id,
                        "text": card_text,
                        "parse_mode": "HTML",
                        "reply_markup": keyboard,
                        "disable_web_page_preview": True,
                    },
                )
                if resp.is_success:
                    data = resp.json()
                    mid = data.get("result", {}).get("message_id")
                    if data.get("ok") and mid:
                        message_ids[chat_id] = str(mid)
                    last_response = data
                else:
                    _log.error("telegram send failed chat_id=%s status=%s", chat_id, resp.status_code)
            except Exception:
                _log.error("telegram send error chat_id=%s", chat_id)
    if not message_ids:
        raise RuntimeError("Telegram approval card was not delivered")
    last_response["_message_ids"] = json.dumps(message_ids)
    # Send attached photos/voice as replies to the approval card
    if approval.client_message:
        _forward_client_photos(
            approval.client_message,
            list(_all_manager_chat_ids(extra_chat_ids)),
            reply_to_message_ids=message_ids,
        )
        _forward_client_voice(
            approval.client_message,
            list(_all_manager_chat_ids(extra_chat_ids)),
            reply_to_message_ids=message_ids,
        )
    return last_response


def edit_approval_card(
    approval: ApprovalRequest,
    lead: Lead,
    decision: str | None = None,
    retry: bool = False,
    messages_count: int = 1,
    chat_id: str | None = None,
    last_message_time: str | None = None,
    claimed_by_name: str | None = None,
    has_templates: bool = False,
) -> dict:
    if not telegram_enabled() or not approval.telegram_message_id:
        return {"skipped": True}
    pairs = _parse_message_ids(approval.telegram_message_id)
    if not pairs:
        return {"skipped": True}
    if decision:
        links = [{"text": "📋 Открыть в CRM", "url": crm_chat_url(lead)}]
        if _has_amocrm_link(lead):
            links.append({"text": "🔗 amoCRM", "url": lead_url(lead)})
        keyboard = {"inline_keyboard": [links]}
    else:
        is_purchase = bool((approval.extracted_fields or {}).get("_purchase_intent"))
        keyboard = approval_keyboard(
            approval.id, lead,
            has_templates=has_templates,
            is_purchase=is_purchase,
            has_edited=_has_sendable_purchase_reply(approval),
        )
    card_text = approval_card(approval, lead, decision=decision, messages_count=messages_count, last_message_time=last_message_time, claimed_by_name=claimed_by_name)
    last_response: dict = {}
    any_success = False
    with httpx.Client(timeout=20) as client:
        for target_chat, message_id in pairs:
            try:
                resp = client.post(
                    _api_url("editMessageText"),
                    json={
                        "chat_id": target_chat,
                        "message_id": int(message_id),
                        "text": card_text,
                        "parse_mode": "HTML",
                        "reply_markup": keyboard,
                        "disable_web_page_preview": True,
                    },
                )
                if resp.is_success:
                    last_response = resp.json()
                    any_success = True
                else:
                    _log.error("telegram edit failed chat_id=%s status=%s", target_chat, resp.status_code)
                    last_response = {"error": True, "status": resp.status_code}
            except Exception:
                _log.error("telegram edit error chat_id=%s", target_chat)
                last_response = {"error": True}
    if not any_success and pairs:
        last_response["_all_failed"] = True
    return last_response


def send_text(
    chat_id: str | int,
    text: str,
    reply_markup: dict | None = None,
    *,
    reply_to_message_id: int | None = None,
    parse_mode: str | None = None,
) -> dict:
    if not settings.telegram_bot_token:
        return {"skipped": True}
    payload: dict = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    if reply_to_message_id is not None:
        payload["reply_parameters"] = {"message_id": reply_to_message_id}
    if parse_mode is not None:
        payload["parse_mode"] = parse_mode
    with httpx.Client(timeout=20) as client:
        response = client.post(_api_url("sendMessage"), json=payload)
        response.raise_for_status()
        return response.json()


def answer_callback(callback_query_id: str, text: str = "") -> None:
    if not settings.telegram_bot_token:
        return
    with httpx.Client(timeout=10) as client:
        client.post(_api_url("answerCallbackQuery"), json={"callback_query_id": callback_query_id, "text": text})


def send_text_all_managers(text: str, parse_mode: str = "HTML", reply_markup: dict | None = None) -> dict[str, str]:
    """Send text message to all configured manager chats. Returns {chat_id: message_id}."""
    if not settings.telegram_bot_token:
        return {}
    message_ids: dict[str, str] = {}
    payload: dict = {"text": text, "parse_mode": parse_mode, "disable_web_page_preview": True}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    with httpx.Client(timeout=20) as client:
        for chat_id in _all_manager_chat_ids():
            try:
                payload["chat_id"] = chat_id
                resp = client.post(_api_url("sendMessage"), json=payload)
                if resp.is_success:
                    mid = resp.json().get("result", {}).get("message_id")
                    if mid:
                        message_ids[chat_id] = str(mid)
            except Exception:
                _log.error("send_text_all_managers error chat_id=%s", chat_id)
    return message_ids


# ─── Клиенты, ожидающие ответа ───────────────────────────────────────────────
# Кнопка обязана нести двоеточие: диспетчер в webhooks.py режет callback_data
# по первому ":" и без него отвечает «Некорректная кнопка».
WAITING_CALLBACK_DATA = "waiting:list"

# Telegram обрежет сообщение длиннее 4096 символов, да и сотню номеров подряд
# никто читать не станет.
WAITING_LIST_LIMIT = 15


def send_waiting_clients_digest(total: int) -> dict[str, str]:
    """Ежедневная сводка всем менеджерам. Телефонов тут нет — они за кнопкой."""
    if not total:
        return send_text_all_managers(
            "🕘 <b>Клиенты, которые ожидают ответа</b>\n\nНикто не ждёт — все заявки разобраны."
        )
    text = (
        f"🕘 <b>Клиенты, которые ожидают ответа: {total}</b>\n\n"
        "Нажмите «ПРИСЛАТЬ» — список придёт вам в личные сообщения."
    )
    keyboard = {"inline_keyboard": [[{"text": "📩 ПРИСЛАТЬ", "callback_data": WAITING_CALLBACK_DATA}]]}
    return send_text_all_managers(text, reply_markup=keyboard)


def waiting_clients_list(contacts: list[tuple[str | None, str]], page: int = 0) -> str:
    """Список контактов плоским текстом: send_text не передаёт parse_mode."""
    if not contacts:
        return "Сейчас никто не ждёт ответа."

    pages = max(1, (len(contacts) + WAITING_LIST_LIMIT - 1) // WAITING_LIST_LIMIT)
    page = min(max(page, 0), pages - 1)
    start = page * WAITING_LIST_LIMIT
    shown = contacts[start : start + WAITING_LIST_LIMIT]
    lines = [f"Ожидают ответа: {len(contacts)} · страница {page + 1}/{pages}", ""]
    for i, (contact, amocrm_lead_id) in enumerate(shown, start + 1):
        if not contact:
            # Контакта нет вовсе — по ID лида клиента хотя бы найдут в amoCRM.
            label = f"без контакта (лид {amocrm_lead_id})"
        elif len(re.sub(r"\D", "", contact)) >= 9:
            label = _fmt_phone(contact)
        else:
            # У части клиентов вместо номера ник в инстаграме — показываем как есть.
            label = contact
        lines.append(f"{i}. {label}")

    lines += ["", "Лид указан, чтобы клиента можно было быстро найти в amoCRM."]
    return "\n".join(lines)


def waiting_clients_keyboard(total: int, page: int = 0) -> dict | None:
    pages = max(1, (total + WAITING_LIST_LIMIT - 1) // WAITING_LIST_LIMIT)
    if pages <= 1:
        return None
    page = min(max(page, 0), pages - 1)
    buttons: list[dict] = []
    if page > 0:
        buttons.append({"text": "⬅️ Назад", "callback_data": f"waiting:{page - 1}"})
    buttons.append({"text": f"{page + 1}/{pages}", "callback_data": f"waiting:{page}"})
    if page + 1 < pages:
        buttons.append({"text": "Вперёд ➡️", "callback_data": f"waiting:{page + 1}"})
    return {"inline_keyboard": [buttons]}


def send_consultation_reminder_card(
    consult: dict,
    reminder_id: int,
) -> dict[str, str]:
    """Send a per-consultation reminder card with Пришёл/Не пришёл buttons."""
    name = escape(consult.get("name") or "—")
    phone = escape(consult.get("phone") or "—")
    time_str = escape(consult.get("time") or "—")
    source = escape(consult.get("source") or "—")
    lead_id = consult.get("lead_id") or ""
    text = (
        f"📅 <b>Консультация сегодня в {time_str}</b>\n\n"
        f"👤 <b>Клиент:</b> {name}\n"
        f"📞 <b>Телефон:</b> {phone}\n"
        f"📌 <b>Источник:</b> {source}\n"
        + (f"🔗 Lead ID: <code>{escape(str(lead_id))}</code>\n" if lead_id else "")
    )
    keyboard = {
        "inline_keyboard": [
            [
                {"text": "✅ Пришёл", "callback_data": f"came_yes:{reminder_id}"},
                {"text": "❌ Не пришёл", "callback_data": f"came_no:{reminder_id}"},
            ]
        ]
    }
    return send_text_all_managers(text, reply_markup=keyboard)
