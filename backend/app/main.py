import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import admin, health, slots, webhooks
from app.api import auth as auth_router
from app.api import copilot as copilot_router
from app.api import crm_users as crm_users_router
from app.core.admin_auth import admin_auth_middleware
from app.core.config import settings
from app.core.logging import configure_logging
from app.core.rate_limit import webhook_rate_limit_middleware

configure_logging()
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title=settings.api_title, lifespan=lifespan)
app.mount("/media", StaticFiles(directory="/app/media", check_dir=False), name="media")
app.middleware("http")(webhook_rate_limit_middleware)
app.middleware("http")(admin_auth_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health.router)
app.include_router(webhooks.router)
app.include_router(admin.router)
app.include_router(slots.router)
app.include_router(auth_router.router)
app.include_router(crm_users_router.router)
app.include_router(copilot_router.router)
