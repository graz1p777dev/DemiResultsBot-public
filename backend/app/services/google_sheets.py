import json
import re
import time as time_module
from datetime import date, datetime
from zoneinfo import ZoneInfo

from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings

MONTH_SHEETS = {
    "01": "Записи-январь",
    "02": "Записи-февраль",
    "03": "Записи-март",
    "04": "Записи-апрель",
    "05": "Записи-май",
    "06": "Записи-июнь",
    "07": "Записи-июль",
    "08": "Записи-август",
    "09": "Записи-сентябрь",
    "10": "Записи-октябрь",
    "11": "Записи-ноябрь",
    "12": "Записи-декабрь",
}

HEADERS = [
    "Дата", "Время", "Имя", "Телефон", "Instagram",
    "ID чата", "ID сделки", "Статус", "Источник",
    "Напоминание", "Пришёл", "Итог", "Комментарий", "Следующий шаг",
]

# Column letter helpers
_COL = {h: chr(ord("A") + i) for i, h in enumerate(HEADERS)}
_DATE_SHEET_CACHE: dict[str, str] = {}
_DATE_SHEET_CACHE_AT = 0.0


def _auth_client():
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    if settings.google_service_account_json:
        creds = Credentials.from_service_account_info(
            json.loads(settings.google_service_account_json), scopes=scopes
        )
    else:
        creds = Credentials.from_service_account_file(
            settings.google_service_account_file, scopes=scopes
        )
    return gspread.authorize(creds)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
def _open_spreadsheet():
    return _auth_client().open_by_key(settings.google_sheets_spreadsheet_id)


def _sheet_name_for(date_str: str) -> str:
    month = datetime.strptime(date_str, "%d.%m.%Y").strftime("%m")
    return MONTH_SHEETS.get(month, "Записи")


def _get_or_create_worksheet(spreadsheet, name: str):
    try:
        return spreadsheet.worksheet(name)
    except Exception:
        ws = spreadsheet.add_worksheet(title=name, rows=1000, cols=len(HEADERS))
        ws.append_row(HEADERS)
        return ws


def _worksheet_for_date(spreadsheet, date_str: str, create: bool = False):
    """Find the real monthly tab even when separators/suffixes differ.

    The production workbook contains names such as ``Записи апрель`` and
    ``Записи-март(обновленный)``.  Prefer the populated matching tab instead of
    creating a second, almost identically named worksheet.
    """
    canonical = _sheet_name_for(date_str)
    month_word = canonical.split("-", 1)[-1].lower()
    candidates = []
    for worksheet in spreadsheet.worksheets():
        normalized = re.sub(r"[^а-яёa-z0-9]+", " ", worksheet.title.lower()).strip()
        if "записи" in normalized and month_word in normalized:
            try:
                populated = len(worksheet.get_all_values())
            except Exception:
                populated = 0
            candidates.append((populated, worksheet))
    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return _get_or_create_worksheet(spreadsheet, canonical) if create else None


def _sheet_title_by_date(spreadsheet) -> dict[str, str]:
    """Index actual dates to tabs; legacy workbook names are sometimes shifted."""
    global _DATE_SHEET_CACHE, _DATE_SHEET_CACHE_AT
    now = time_module.monotonic()
    if _DATE_SHEET_CACHE and now - _DATE_SHEET_CACHE_AT < 300:
        return _DATE_SHEET_CACHE

    counts: dict[str, dict[str, int]] = {}
    for worksheet in spreadsheet.worksheets():
        if "записи" not in worksheet.title.lower():
            continue
        try:
            dates = worksheet.col_values(1)[1:]
        except Exception:
            continue
        for value in dates:
            date_value = str(value).strip()
            if not re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", date_value):
                continue
            per_sheet = counts.setdefault(date_value, {})
            per_sheet[worksheet.title] = per_sheet.get(worksheet.title, 0) + 1
    _DATE_SHEET_CACHE = {
        date_value: max(per_sheet.items(), key=lambda item: item[1])[0]
        for date_value, per_sheet in counts.items()
    }
    _DATE_SHEET_CACHE_AT = now
    return _DATE_SHEET_CACHE


# ─── Write ────────────────────────────────────────────────────────────────────

def update_consultation_sheet(
    extracted: dict,
    lead_id: str,
    chat_id: str = "",
    instagram: str = "",
) -> dict:
    if not settings.google_sheets_enabled:
        return {"skipped": True, "reason": "google_sheets_enabled=false"}

    date_str = extracted.get("consultation_date", "")
    ss = _open_spreadsheet()
    ws = _worksheet_for_date(ss, date_str, create=True) if date_str else _get_or_create_worksheet(ss, "Записи")

    # Approval actions may be retried.  A stable amo lead/date/time tuple must
    # produce one booking row, not duplicates.
    for index, existing in enumerate(ws.get_all_records(), start=2):
        if (
            str(existing.get("ID сделки", "")).strip() == str(lead_id)
            and str(existing.get("Дата", "")).strip() == date_str
            and str(existing.get("Время", "")).strip() == str(extracted.get("consultation_time", ""))
        ):
            return {"appended": False, "existing": True, "sheet": ws.title, "row_number": index}

    row = [
        date_str,
        extracted.get("consultation_time", ""),
        extracted.get("name") or "",
        extracted.get("contacts") or "",
        instagram,
        chat_id,
        lead_id,
        "Записан",
        extracted.get("consultation_format") or "Офлайн",
        "Нет",   # Напоминание
        "",      # Пришёл
        "",      # Итог
        "",      # Комментарий
        "",      # Следующий шаг
    ]
    ws.append_row(row, value_input_option="USER_ENTERED")
    _DATE_SHEET_CACHE[date_str] = ws.title
    return {"appended": True, "sheet": ws.title, "row": row}


# ─── Read ─────────────────────────────────────────────────────────────────────

def _rows_for_date(date_str: str) -> tuple:
    """Returns (worksheet, list_of_row_dicts_with_row_number) for the given date."""
    ss = _open_spreadsheet()
    indexed_title = _sheet_title_by_date(ss).get(date_str)
    ws = ss.worksheet(indexed_title) if indexed_title else _worksheet_for_date(ss, date_str, create=False)
    if ws is None:
        return None, []
    all_rows = ws.get_all_records()
    matching = [
        {**r, "_row": idx + 2}
        for idx, r in enumerate(all_rows)
        if str(r.get("Дата", "")).strip() == date_str
    ]
    return ws, matching


def get_booked_times(date_str: str) -> set[str]:
    """Read occupied times from the business workbook before offering a slot."""
    if not settings.google_sheets_enabled:
        return set()
    try:
        _ws, rows = _rows_for_date(date_str)
        released_statuses = {"отменил", "не придет", "не придёт", "перезапись"}
        return {
            str(row.get("Время", "")).strip()
            for row in rows
            if str(row.get("Время", "")).strip()
            and str(row.get("Статус", "")).strip().lower() not in released_statuses
        }
    except Exception:
        return set()


def get_todays_consultations() -> list[dict]:
    """Returns today's consultations with Статус=Записан."""
    if not settings.google_sheets_enabled:
        return []
    today = datetime.now(ZoneInfo(settings.timezone)).strftime("%d.%m.%Y")
    try:
        ws, rows = _rows_for_date(today)
        return [
            {
                "row_number": r["_row"],
                "sheet_name": ws.title if ws else "",
                "date": r.get("Дата", ""),
                "time": r.get("Время", ""),
                "name": r.get("Имя", ""),
                "phone": r.get("Телефон", ""),
                "instagram": r.get("Instagram", ""),
                "chat_id": r.get("ID чата", ""),
                "lead_id": r.get("ID сделки", ""),
                "status": r.get("Статус", ""),
                "source": r.get("Источник", ""),
                "reminder_sent": r.get("Напоминание", "Нет"),
                "came": r.get("Пришёл", ""),
                "result": r.get("Итог", ""),
                "comment": r.get("Комментарий", ""),
            }
            for r in rows
            if r.get("Статус", "") in ("Записан", "Напомнено")
        ]
    except Exception:
        return []


def get_all_consultations_for_date(date_str: str) -> list[dict]:
    """Returns all consultations for given date (all statuses), for /consult command."""
    if not settings.google_sheets_enabled:
        return []
    try:
        ws, rows = _rows_for_date(date_str)
        return [
            {
                "row_number": r["_row"],
                "sheet_name": ws.title if ws else "",
                "date": r.get("Дата", ""),
                "time": r.get("Время", ""),
                "name": r.get("Имя", ""),
                "phone": r.get("Телефон", ""),
                "instagram": r.get("Instagram", ""),
                "chat_id": r.get("ID чата", ""),
                "lead_id": r.get("ID сделки", ""),
                "status": r.get("Статус", ""),
                "came": r.get("Пришёл", ""),
                "result": r.get("Итог", ""),
                "comment": r.get("Комментарий", ""),
            }
            for r in rows
        ]
    except Exception:
        return []


def get_past_consultations_without_result() -> list[dict]:
    """Returns past consultations (time already passed) where result (Пришёл) not yet recorded."""
    if not settings.google_sheets_enabled:
        return []
    now = datetime.now(ZoneInfo(settings.timezone))
    today = now.strftime("%d.%m.%Y")
    try:
        ws, rows = _rows_for_date(today)
        result = []
        for r in rows:
            if r.get("Статус", "") not in ("Записан", "Напомнено"):
                continue
            if r.get("Пришёл", "").strip():
                continue  # Already filled
            time_str = r.get("Время", "")
            if not time_str:
                continue
            try:
                consult_hour, consult_min = [int(x) for x in time_str.split(":")]
                consult_end = now.replace(hour=consult_hour, minute=consult_min, second=0)
                # Only check if consultation ended 30+ min ago
                if (now - consult_end).total_seconds() < 30 * 60:
                    continue
            except ValueError:
                continue
            result.append({
                "row_number": r["_row"],
                "sheet_name": ws.title if ws else "",
                "date": r.get("Дата", ""),
                "time": r.get("Время", ""),
                "name": r.get("Имя", ""),
                "phone": r.get("Телефон", ""),
                "lead_id": r.get("ID сделки", ""),
                "came": r.get("Пришёл", ""),
                "result": r.get("Итог", ""),
                "comment": r.get("Комментарий", ""),
            })
        return result
    except Exception:
        return []


def get_upcoming_consultations_within(minutes: int) -> list[dict]:
    """Today's booked consultations starting in (0, minutes] from now.

    Bounded window on both ends — a consultation that already started, or one
    further out than `minutes`, is simply not in this list. No open-ended
    "older than X" query here (see reminders.py comment on the 10.07 incident).
    """
    if not settings.google_sheets_enabled:
        return []
    now = datetime.now(ZoneInfo(settings.timezone))
    today = now.strftime("%d.%m.%Y")
    try:
        ws, rows = _rows_for_date(today)
        result = []
        for r in rows:
            if r.get("Статус", "") not in ("Записан", "Напомнено"):
                continue
            time_str = r.get("Время", "")
            if not time_str:
                continue
            try:
                consult_hour, consult_min = [int(x) for x in time_str.split(":")]
                consult_start = now.replace(hour=consult_hour, minute=consult_min, second=0, microsecond=0)
            except ValueError:
                continue
            delta_min = (consult_start - now).total_seconds() / 60
            if not (0 < delta_min <= minutes):
                continue
            result.append({
                "row_number": r["_row"],
                "sheet_name": ws.title if ws else "",
                "date": r.get("Дата", ""),
                "time": r.get("Время", ""),
                "name": r.get("Имя", ""),
                "phone": r.get("Телефон", ""),
                "lead_id": r.get("ID сделки", ""),
            })
        return result
    except Exception:
        return []


# ─── Update helpers ───────────────────────────────────────────────────────────

def mark_reminder_sent(sheet_name: str, row_number: int) -> None:
    if not settings.google_sheets_enabled:
        return
    try:
        ss = _open_spreadsheet()
        ws = ss.worksheet(sheet_name)
        col_letter = _COL.get("Напоминание", "J")
        ws.update(f"{col_letter}{row_number}", [["Да"]])
        # Also update Статус to "Напомнено"
        status_col = _COL.get("Статус", "H")
        ws.update(f"{status_col}{row_number}", [["Напомнено"]])
    except Exception:
        pass


def update_came_status(sheet_name: str, row_number: int, came: str, result: str = "") -> None:
    if not settings.google_sheets_enabled:
        return
    try:
        ss = _open_spreadsheet()
        ws = ss.worksheet(sheet_name)
        came_col = _COL.get("Пришёл", "K")
        status_col = _COL.get("Статус", "H")
        ws.update(f"{came_col}{row_number}", [[came]])
        ws.update(f"{status_col}{row_number}", [["Пришёл" if came == "Да" else "Не пришёл"]])
        if result:
            result_col = _COL.get("Итог", "L")
            ws.update(f"{result_col}{row_number}", [[result]])
    except Exception:
        pass
