from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.slots import check_consultation_slots

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("/check_consultation_slots")
def check_slots(
    requested_date: str | None = None,
    requested_time: str | None = None,
    db: Session = Depends(get_db),
) -> dict:
    return check_consultation_slots(db, requested_date, requested_time)

