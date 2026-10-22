from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings

FIELD_IDS = {
    "skin_problem": 406397,
    "consultation_format": 406409,
    "city": 416545,
    "experience": 417297,
    "consultation_datetime": 416633,
}


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.amocrm_access_token}"}


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def get_lead_fields() -> dict:
    with httpx.Client(timeout=20) as client:
        r = client.get(f"{settings.amocrm_base_url}/api/v4/leads/custom_fields", headers=_headers())
        r.raise_for_status()
        return r.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def get_lead(amocrm_lead_id: str) -> dict:
    with httpx.Client(timeout=20) as client:
        r = client.get(f"{settings.amocrm_base_url}/api/v4/leads/{amocrm_lead_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def get_pipeline(pipeline_id: int) -> dict:
    with httpx.Client(timeout=20) as client:
        r = client.get(f"{settings.amocrm_base_url}/api/v4/leads/pipelines/{pipeline_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


def lead_stage_snapshot(amocrm_lead_id: str) -> dict:
    if not settings.amocrm_access_token:
        return {}
    lead = get_lead(amocrm_lead_id)
    pipeline_id = lead.get("pipeline_id")
    status_id = lead.get("status_id")
    stage_name = None
    if pipeline_id and status_id:
        pipeline = get_pipeline(int(pipeline_id))
        statuses = pipeline.get("_embedded", {}).get("statuses", [])
        status = next((item for item in statuses if item.get("id") == status_id), None)
        stage_name = status.get("name") if status else None
    return {"pipeline_id": pipeline_id, "status_id": status_id, "stage_name": stage_name}


def _find_enum_values(fields: dict, field_id: int, values: list | str | None) -> list[dict]:
    if not values:
        return []
    if not isinstance(values, list):
        values = [values]
    custom_fields = fields.get("_embedded", {}).get("custom_fields", [])
    field = next((item for item in custom_fields if item.get("id") == field_id), None)
    if not field:
        return []
    enums = field.get("enums") or []
    result = []
    for value in values:
        normalized = str(value).lower().strip()
        match = next((enum for enum in enums if str(enum.get("value", "")).lower().strip() == normalized), None)
        if match:
            result.append({"enum_id": match["id"]})
    return result


def bishkek_timestamp(date_value: str, time_value: str) -> int | None:
    try:
        dt = datetime.strptime(f"{date_value} {time_value}", "%d.%m.%Y %H:%M")
    except ValueError:
        return None
    return int(dt.replace(tzinfo=ZoneInfo(settings.timezone)).timestamp())


def build_lead_patch(amocrm_lead_id: str, extracted: dict, fields: dict) -> dict | None:
    values = []
    for key in ("skin_problem", "consultation_format", "city", "experience"):
        enum_values = _find_enum_values(fields, FIELD_IDS[key], extracted.get(key))
        if enum_values:
            values.append({"field_id": FIELD_IDS[key], "values": enum_values})
    if extracted.get("consultation_date") and extracted.get("consultation_time"):
        timestamp = bishkek_timestamp(extracted["consultation_date"], extracted["consultation_time"])
        if timestamp:
            values.append({"field_id": FIELD_IDS["consultation_datetime"], "values": [{"value": timestamp}]})
    if not values:
        return None
    return {"id": int(amocrm_lead_id), "custom_fields_values": values}


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def patch_lead(payload: dict) -> dict:
    with httpx.Client(timeout=20) as client:
        r = client.patch(f"{settings.amocrm_base_url}/api/v4/leads", json=[payload], headers=_headers())
        r.raise_for_status()
        return r.json() if r.content else {"ok": True}


def patch_lead_status(amocrm_lead_id: str, status_id: int | None, pipeline_id: int | None = None) -> dict:
    if not status_id:
        return {"skipped": True, "reason": "status_id is empty"}
    payload: dict = {"id": int(amocrm_lead_id), "status_id": int(status_id)}
    if pipeline_id:
        payload["pipeline_id"] = int(pipeline_id)
    if settings.amocrm_ai_user_id:
        payload["responsible_user_id"] = settings.amocrm_ai_user_id
    return patch_lead(payload)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def list_pipeline_leads(pipeline_id: int) -> list[dict]:
    """Load every lead in a pipeline without silently stopping at amoCRM's page limit."""
    result: list[dict] = []
    page = 1
    with httpx.Client(timeout=30) as client:
        while True:
            response = client.get(
                f"{settings.amocrm_base_url}/api/v4/leads",
                headers=_headers(),
                params={"filter[pipeline_id]": pipeline_id, "limit": 250, "page": page},
            )
            if response.status_code == 204:
                break
            response.raise_for_status()
            body = response.json()
            batch = body.get("_embedded", {}).get("leads", [])
            result.extend(batch)
            if len(batch) < 250:
                break
            page += 1
    return result


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def create_chat_session(account_url: str | None = None) -> dict:
    url = f"{account_url or settings.amocrm_base_url}/ajax/v1/chats/session"
    with httpx.Client(timeout=20) as client:
        r = client.post(
            url,
            data={"request[chats][session][action]": "create"},
            headers=_headers() | {"X-Requested-With": "XMLHttpRequest"},
        )
        r.raise_for_status()
        return r.json()


def get_chat_history(chat_id: str, limit: int = 50) -> list[dict]:
    """Return recent amoCRM chat messages in chronological order.

    amoCRM's internal chat endpoint is also used by the web interface and,
    unlike our incoming webhook, includes replies written by consultants.
    """
    if not chat_id:
        return []
    session = create_chat_session()
    data = session.get("response", {}).get("chats", {}).get("session", {})
    account_id = data.get("account", {}).get("id")
    token = data.get("access_token")
    if not account_id or not token:
        raise RuntimeError("amo chat session response has no account id/token")
    url = f"{settings.amojo_base_url}/v1/chats/{account_id}/{chat_id}/messages"
    with httpx.Client(timeout=20) as client:
        response = client.get(
            url,
            params={"limit": limit},
            headers={"X-Auth-Token": token, "chatId": chat_id},
        )
        response.raise_for_status()

    result: list[dict] = []
    for item in response.json()[:limit]:
        message = item.get("message") or {}
        text = str(message.get("text") or "").strip()
        media = message.get("media") or ""
        message_type = message.get("type") or "text"
        if media and not text:
            text = f"[{message_type}] {media}"
        if not text:
            continue
        created_at = item.get("created_at") or 0
        role = "assistant" if item.get("recipient") else "user"
        author_name = str((item.get("author") or {}).get("name") or "").strip()
        normalized_author = author_name.casefold()
        if role == "user":
            speaker = "client"
        elif any(marker in normalized_author for marker in ("айым", "аим", "bot", "бот", "ии")):
            speaker = "bot"
        else:
            speaker = "manager"
        result.append(
            {
                "message_id": str(item.get("id") or ""),
                "role": role,
                "speaker": speaker,
                "content": text,
                "created_at": datetime.fromtimestamp(int(created_at), tz=ZoneInfo("UTC")),
                "author_name": author_name or None,
            }
        )
    return sorted(result, key=lambda row: row["created_at"])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def send_chat_message(session: dict, chat_id: str, lead_id: str, contact_id: str | None, text: str) -> dict:
    data = session.get("response", {}).get("chats", {}).get("session", {})
    account_id = data.get("account", {}).get("id")
    token = data.get("access_token")
    if not account_id or not token:
        raise RuntimeError("amo chat session response has no account id/token")
    url = f"{settings.amojo_base_url}/v1/chats/{account_id}/{chat_id}/messages"
    payload = {
        "silent": "false",
        "priority": "low",
        "crm_entity[id]": lead_id,
        "crm_entity[type]": "2",
        "persona_name": "Айым",
        "text": text,
        "crm_contact_id": contact_id or "",
        "skip_link_shortener": "false",
    }
    with httpx.Client(timeout=20) as client:
        r = client.post(
            url,
            data=payload,
            headers={
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Auth-Token": token,
                "chatId": chat_id,
            },
        )
        r.raise_for_status()
        return r.json() if r.content else {"ok": True}
