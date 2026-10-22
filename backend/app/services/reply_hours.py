"""Чистая политика времени ответа; отправка и дедупликация остаются у вызывающего кода."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class ReplyHoursDecision:
    requires_human_approval: bool
    reply_text: str | None
    night_key: str | None
    next_open_at: datetime | None


def reply_hours_policy(
    now: datetime,
    *,
    start_hour: int = 10,
    end_hour: int = 21,
    timezone: str = "Asia/Bishkek",
) -> ReplyHoursDecision:
    """Рабочий интервал [start, end); night_key — дата закрытия магазина.

    Поддерживается дневное расписание в целых часах. Время обязательно aware;
    системный часовой пояс и текущее время не используются.
    """
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    if not 0 <= start_hour < end_hour <= 23:
        raise ValueError("hours must satisfy 0 <= start_hour < end_hour <= 23")
    local_now = now.astimezone(ZoneInfo(timezone))
    if start_hour <= local_now.hour < end_hour:
        return ReplyHoursDecision(True, None, None, None)

    before_open = local_now.hour < start_hour
    opening_date = local_now.date() if before_open else local_now.date() + timedelta(days=1)
    closing_date: date = opening_date - timedelta(days=1)
    next_open_at = datetime.combine(
        opening_date, datetime.min.time(), tzinfo=local_now.tzinfo,
    ).replace(hour=start_hour)
    day_word = "сегодня" if before_open else "завтра"
    reply_text = (
        "Наш магазин уже закрылся. Спасибо за сообщение! "
        f"Мы ответим вам {day_word} с {start_hour:02d}:00."
    )
    return ReplyHoursDecision(False, reply_text, closing_date.isoformat(), next_open_at)
