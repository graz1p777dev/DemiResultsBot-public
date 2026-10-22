from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entities import ConsultationSlot
from app.services import google_sheets


def is_working_day(day: date) -> bool:
    start = date.fromisoformat(settings.schedule_start_dates.split(",")[0])
    delta = (day - start).days
    if delta < 0:
        return False
    return delta % 4 in (0, 1)


def day_slots(day: date) -> list[str]:
    if not is_working_day(day):
        return []
    current = datetime.combine(day, time(settings.consultation_start_hour, 0))
    end = datetime.combine(day, time(settings.consultation_end_hour, 0))
    result: list[str] = []
    while current <= end:
        result.append(current.strftime("%H:%M"))
        current += timedelta(minutes=settings.consultation_interval_minutes)
    return result


def check_consultation_slots(
    db: Session, requested_date: str | None = None, requested_time: str | None = None
) -> dict:
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(tz)
    if requested_date:
        day = datetime.strptime(requested_date, "%d.%m.%Y").date()
    else:
        day = now.date()

    if day == now.date() and now.hour >= settings.do_not_offer_today_after_hour:
        day += timedelta(days=1)

    free_slots: list[str] = []
    local_booked = 0
    sheet_booked = 0
    cursor = day
    while len(free_slots) < 8:
        candidates = day_slots(cursor)
        taken_rows = db.scalars(
            select(ConsultationSlot).where(
                ConsultationSlot.date == cursor,
                ConsultationSlot.status.in_(["booked", "blocked"]),
            )
        ).all()
        local_taken = {row.time.strftime("%H:%M") for row in taken_rows}
        sheet_taken = google_sheets.get_booked_times(cursor.strftime("%d.%m.%Y"))
        local_booked = len(local_taken)
        sheet_booked = len(sheet_taken)
        taken = local_taken | sheet_taken
        if cursor == now.date():
            candidates = [slot for slot in candidates if slot > now.strftime("%H:%M")]
        free_slots.extend([slot for slot in candidates if slot not in taken])
        if free_slots:
            break
        cursor += timedelta(days=1)

    return {
        "requested_date": requested_date or cursor.strftime("%d.%m.%Y"),
        "requested_time": requested_time,
        "free_slots": free_slots[:8],
        "is_requested_time_available": requested_time in free_slots if requested_time else None,
        "local_booked": local_booked,
        "sheet_booked": sheet_booked,
    }
