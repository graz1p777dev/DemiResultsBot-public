import re


_BOT_HANDLE_ONLY = re.compile(r"^@[a-z0-9_]+bot$", re.IGNORECASE)
_PLUS_ONLY = re.compile(r"^\++$")
_SERVICE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("crm_credentials", re.compile(r"(?im)^\s*crm\s+(?:логин|login)\s*:")),
    ("manager_configuration", re.compile(r"(?im)^\s*telegram\s+менеджер\s*:\s*\d+")),
    (
        "secret",
        re.compile(
            r"(?im)^\s*(?:пароль|password|api[ _-]?key|access[ _-]?token|токен)\s*:"
        ),
    ),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # Green API/service placeholders are not customer messages and must not
    # appear in the CRM dialogue or trigger an AI reply.
    ("channel_placeholder", re.compile(r"^\s*\{\{SWE\d+\}\}\s*$", re.IGNORECASE)),
)


def service_message_reason(text: str | None) -> str | None:
    """Return a reason only for unambiguous technical/service messages.

    The rules are deliberately conservative: ordinary customer messages that
    merely mention CRM, Telegram or a password must still reach the bot.
    """
    value = (text or "").strip()
    if not value:
        return None
    if _BOT_HANDLE_ONLY.fullmatch(value):
        return "bot_handle"
    for reason, pattern in _SERVICE_PATTERNS:
        if pattern.search(value):
            return reason
    return None


def is_service_message(text: str | None) -> bool:
    return service_message_reason(text) is not None


def is_plus_only_message(text: str | None) -> bool:
    """A leading ``+`` is a real customer opt-in, not an empty message."""
    return bool(_PLUS_ONLY.fullmatch((text or "").strip()))
