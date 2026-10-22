"""Fire-and-forget notifications into the CRM's notification bell.

Best-effort side channel: never raises, never blocks the pipeline. If
CRM_NOTIFY_TOKEN is unset the CRM route itself answers 503 and we just log it.
"""

import logging

import httpx

from app.core.config import settings

_log = logging.getLogger(__name__)


def notify(
    type: str,  # noqa: A002 — matches the CRM API field name
    title: str,
    body: str | None = None,
    is_important: bool = False,
    action_url: str | None = None,
    source_type: str | None = None,
    source_id: str | None = None,
) -> None:
    if not settings.crm_notify_token:
        return
    try:
        with httpx.Client(timeout=5) as client:
            client.post(
                settings.crm_notify_url,
                headers={"x-internal-token": settings.crm_notify_token},
                json={
                    "type": type,
                    "title": title,
                    "body": body,
                    "isImportant": is_important,
                    "actionUrl": action_url,
                    "sourceType": source_type,
                    "sourceId": source_id,
                },
            )
    except Exception:
        _log.exception("crm_notify.notify failed (type=%s)", type)


def _post(url: str, payload: dict) -> dict:
    if not settings.crm_notify_token:
        return {"skipped": True, "reason": "crm_notify_token is empty"}
    # Meta can spend up to 20 seconds accepting a message. Do not time out
    # before the provider response and encourage a duplicate manual retry.
    with httpx.Client(timeout=60 if payload.get("channel") == "whatsapp" else 10) as client:
        response = client.post(
            url,
            headers={"x-internal-token": settings.crm_notify_token},
            json=payload,
        )
        response.raise_for_status()
        return response.json()


def sync_deal(payload: dict) -> dict:
    return _post(settings.crm_deals_url, payload)


def sync_consultation(payload: dict) -> dict:
    return _post(settings.crm_consultations_url, payload)


def send_channel_message(channel: str, recipient_id: str, text: str) -> dict:
    result = _post(settings.crm_channel_send_url, {
        "channel": channel,
        "recipientId": recipient_id,
        "text": text,
    })
    if channel == "whatsapp" and (not result.get("ok") or not result.get("messageId")):
        raise RuntimeError("Green API is not configured or rejected the message")
    return result


def send_whatsapp_media(recipient_id: str, media_url: str, label: str, media_type: str) -> dict:
    result = _post(settings.crm_channel_send_url, {
        "channel": "whatsapp", "recipientId": recipient_id, "text": label,
        "audioUrl": media_url, "mediaType": media_type,
    })
    if not result.get("ok") or not result.get("messageId"):
        raise RuntimeError("Green API is not configured or rejected the media")
    return result


def get_whatsapp_media(media_id: str) -> tuple[bytes, str]:
    if not media_id.isdigit() or len(media_id) > 30 or not settings.crm_notify_token:
        raise RuntimeError("Invalid or unconfigured Meta media request")
    url = settings.crm_channel_send_url.rsplit("/", 1)[0] + "/whatsapp-media/" + media_id
    with httpx.Client(timeout=45) as client:
        response = client.get(url, headers={"x-internal-token": settings.crm_notify_token})
        response.raise_for_status()
        return response.content, response.headers.get("content-type", "application/octet-stream")
