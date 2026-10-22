from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import hash_password
from app.db.session import get_db
from app.models.entities import CrmUser

router = APIRouter(prefix="/admin/crm-users", tags=["crm-users"])


class CreateUser(BaseModel):
    username: str
    password: str
    is_admin: bool = False


class UpdateUser(BaseModel):
    password: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None


@router.get("")
def list_users(db: Session = Depends(get_db)) -> list[dict]:
    users = db.scalars(select(CrmUser).order_by(CrmUser.id)).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "is_admin": u.is_admin,
            "is_active": u.is_active,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


@router.post("")
def create_user(body: CreateUser, db: Session = Depends(get_db)) -> dict:
    if db.scalars(select(CrmUser).where(CrmUser.username == body.username)).first():
        raise HTTPException(status_code=409, detail="Пользователь уже существует")
    user = CrmUser(
        username=body.username,
        password_hash=hash_password(body.password),
        is_admin=body.is_admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin}


@router.patch("/{user_id}")
def update_user(user_id: int, body: UpdateUser, db: Session = Depends(get_db)) -> dict:
    user = db.get(CrmUser, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Не найден")
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.is_active is not None:
        user.is_active = body.is_active
    db.commit()
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin, "is_active": user.is_active}


@router.delete("/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db)) -> dict:
    user = db.get(CrmUser, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Не найден")
    db.delete(user)
    db.commit()
    return {"ok": True}
