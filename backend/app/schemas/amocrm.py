from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel


class IncomingMessage(BaseModel):
    raw: dict[str, Any]
    text: str
    direction: str
    chat_id: str
    message_id: str
    client_id: str
    client_name: str
    lead_id: str
    contact_id: str | None = None
    source: str = "amocrm"
    media: str | None = None
    attachment_type: str | None = None
    attachment_link: str | None = None
    timestamp: datetime


def parse_amocrm_webhook(body: dict[str, Any]) -> IncomingMessage:
    created_at = body.get("message[add][0][created_at]")
    if created_at:
        timestamp = datetime.fromtimestamp(int(created_at), tz=UTC)
    else:
        timestamp = datetime.now(UTC)
    return IncomingMessage(
        raw=body,
        text=body.get("message[add][0][text]") or "",
        direction=body.get("message[add][0][type]") or "incoming",
        chat_id=body.get("message[add][0][chat_id]") or "",
        message_id=str(body.get("message[add][0][id]") or ""),
        client_id=str(body.get("message[add][0][author][id]") or ""),
        client_name=body.get("message[add][0][author][name]") or "",
        lead_id=str(body.get("message[add][0][element_id]") or body.get("message[add][0][entity_id]") or ""),
        contact_id=str(body.get("message[add][0][contact_id]") or ""),
        source=body.get("message[add][0][origin]") or "amocrm",
        media=body.get("message[add][0][media]") or "",
        attachment_type=body.get("message[add][0][attachment][type]") or None,
        attachment_link=body.get("message[add][0][attachment][link]") or None,
        timestamp=timestamp,
    )

