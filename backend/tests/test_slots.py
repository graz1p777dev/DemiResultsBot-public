from datetime import date

from app.services.slots import is_working_day


def test_two_two_schedule() -> None:
    assert is_working_day(date(2026, 5, 19))
    assert is_working_day(date(2026, 5, 20))
    assert not is_working_day(date(2026, 5, 21))
    assert not is_working_day(date(2026, 5, 22))
    assert is_working_day(date(2026, 5, 23))

