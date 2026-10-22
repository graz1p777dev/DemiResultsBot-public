from dataclasses import dataclass
from urllib.parse import unquote

from fastapi import HTTPException, Request


@dataclass(frozen=True)
class CurrentUser:
    username: str
    is_admin: bool


def get_current_user(request: Request) -> CurrentUser:
    """Identity for Copilot requests, forwarded by the Next.js proxy (which
    decodes the crm_token cookie server-side) via X-User-Name / X-User-Is-Admin.
    Not used by any other router — the rest of the backend has no per-user auth.
    """
    username_raw = request.headers.get("X-User-Name")
    if not username_raw:
        raise HTTPException(status_code=401, detail="Not authenticated")
    # Прокси кодирует имя (encodeURIComponent) — HTTP-заголовки не пропускают
    # не-ASCII байты напрямую, а имена сотрудников часто кириллица.
    username = unquote(username_raw)
    is_admin = request.headers.get("X-User-Is-Admin") == "true"
    return CurrentUser(username=username, is_admin=is_admin)
