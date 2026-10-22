import base64
import hashlib
import hmac
import json
import os
import time
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.entities import CrmUser

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_EXPIRE_DAYS = 30
COOKIE_NAME = "crm_token"


# ── Password hashing (PBKDF2-SHA256, no external deps) ──────────────────────

def hash_password(plain: str) -> str:
    salt = os.urandom(32)
    key = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt, 200_000)
    return base64.b64encode(salt + key).decode()


def verify_password(plain: str, stored: str) -> bool:
    try:
        data = base64.b64decode(stored)
        salt, key = data[:32], data[32:]
        new_key = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt, 200_000)
        return hmac.compare_digest(new_key, key)
    except Exception:
        return False


# ── JWT (HS256, stdlib only) — compatible with jose.jwtVerify ────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (4 - len(s) % 4))


def create_token(username: str, is_admin: bool) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps({
        "sub": username,
        "is_admin": is_admin,
        "exp": int(time.time()) + TOKEN_EXPIRE_DAYS * 86400,
    }).encode())
    msg = f"{header}.{payload}".encode()
    sig = _b64url(hmac.new(settings.jwt_secret.encode(), msg, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


# ── Endpoints ─────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.scalars(
        select(CrmUser).where(CrmUser.username == body.username, CrmUser.is_active == True)
    ).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    token = create_token(user.username, user.is_admin)
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=TOKEN_EXPIRE_DAYS * 86400,
        httponly=True, samesite="lax", secure=True,
    )
    return {"username": user.username, "is_admin": user.is_admin}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, samesite="lax", secure=True)
    return {"ok": True}
