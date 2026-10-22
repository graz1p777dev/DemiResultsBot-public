from fastapi import APIRouter
from sqlalchemy import text

from app.db.session import engine

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/health/db")
def health_db() -> dict:
    with engine.connect() as connection:
        connection.execute(text("select 1"))
    return {"status": "ok", "database": "ok"}
