import random
import re


MESSAGE_SEPARATOR = "<NEXT_MESSAGE>"
MAX_MESSAGE_PARTS = 3


def split_outgoing_messages(value: str) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    if MESSAGE_SEPARATOR in text:
        raw_parts = text.split(MESSAGE_SEPARATOR)
    else:
        paragraphs = [part for part in re.split(r"\n\s*\n", text) if part.strip()]
        raw_parts = paragraphs if 1 < len(paragraphs) <= MAX_MESSAGE_PARTS else [text]
    parts = [part.strip() for part in raw_parts if part.strip()]
    if len(parts) <= MAX_MESSAGE_PARTS:
        return parts
    return [
        *parts[: MAX_MESSAGE_PARTS - 1],
        "\n\n".join(parts[MAX_MESSAGE_PARTS - 1 :]),
    ]


def message_delay_seconds(text: str) -> float:
    return min(2.3, max(0.7, len(text) * 0.028)) + random.uniform(0, 0.25)
