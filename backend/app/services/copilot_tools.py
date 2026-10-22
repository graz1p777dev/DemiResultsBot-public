"""Tool layer for the AI Copilot. The model never touches the database or
Supabase directly — every data access and every write goes through one of
these functions, each RBAC-checked against the caller's is_admin flag.

Write actions never mutate anything here — they return a proposed payload
that copilot_service turns into a CopilotPendingAction, executed only after
the user confirms.
"""
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.copilot_auth import CurrentUser
from app.models.entities import ApprovalRequest, ConsultationSlot, Expense, Lead, Message
from app.services import inventory_client


class ToolError(Exception):
    def __init__(self, message: str):
        self.message = message


def _require_admin(user: CurrentUser):
    if not user.is_admin:
        raise ToolError("Недостаточно прав: этот вопрос доступен только администраторам.")


# ── Read tools ────────────────────────────────────────────────────────────

def get_dialogues_summary(db: Session, user: CurrentUser) -> dict:
    total_leads = db.scalar(select(func.count()).select_from(Lead)) or 0
    active_ai = db.scalar(select(func.count()).select_from(Lead).where(Lead.ai_enabled == True)) or 0
    today = datetime.utcnow().date()
    messages_today = db.scalar(
        select(func.count()).select_from(Message)
        .where(Message.role == "user", func.date(Message.created_at) == today)
    ) or 0
    return {"total_leads": total_leads, "ai_enabled_leads": active_ai, "messages_today": messages_today}


def get_analytics_summary(db: Session, user: CurrentUser, period: str = "today") -> dict:
    _require_admin(user)
    since = {
        "today": datetime.utcnow().date(),
        "week": datetime.utcnow().date() - timedelta(days=7),
        "month": datetime.utcnow().date() - timedelta(days=30),
    }.get(period, datetime.utcnow().date())

    total = db.scalar(
        select(func.count()).select_from(ApprovalRequest).where(ApprovalRequest.created_at >= since)
    ) or 0
    approved = db.scalar(
        select(func.count()).select_from(ApprovalRequest)
        .where(ApprovalRequest.created_at >= since, ApprovalRequest.status.in_(["approved", "sent"]))
    ) or 0
    return {"period": period, "total_replies": total, "approved_replies": approved}


def get_consultations(db: Session, user: CurrentUser, target_date: str | None = None) -> dict:
    day = date.fromisoformat(target_date) if target_date else datetime.utcnow().date()
    slots = db.scalars(
        select(ConsultationSlot).where(ConsultationSlot.date == day, ConsultationSlot.status != "free")
    ).all()
    return {
        "date": day.isoformat(),
        "booked": [{"time": s.time.strftime("%H:%M"), "status": s.status} for s in slots],
    }


def get_products(user: CurrentUser, low_stock_only: bool = False) -> dict:
    try:
        products = inventory_client.fetch_products(low_stock_only=low_stock_only)
    except Exception:
        raise ToolError("Не удалось получить данные из Товароучёта — проверьте подключение к Supabase.")
    return {"products": products}


def get_recent_sales(user: CurrentUser, limit: int = 10) -> dict:
    _require_admin(user)
    try:
        sales = inventory_client.fetch_recent_sales(limit=limit)
    except Exception:
        raise ToolError("Не удалось получить данные о продажах из Товароучёта.")
    return {"sales": sales}


def get_open_shifts(user: CurrentUser) -> dict:
    try:
        shifts = inventory_client.fetch_open_shifts()
    except Exception:
        raise ToolError("Не удалось получить данные о сменах из Товароучёта.")
    return {"open_shifts": shifts}


def get_expenses(db: Session, user: CurrentUser, period: str = "month") -> dict:
    _require_admin(user)
    since = {
        "today": datetime.utcnow().date(),
        "week": datetime.utcnow().date() - timedelta(days=7),
        "month": datetime.utcnow().date() - timedelta(days=30),
    }.get(period, datetime.utcnow().date() - timedelta(days=30))
    rows = db.scalars(
        select(Expense).where(Expense.expense_date >= since).order_by(Expense.expense_date.desc())
    ).all()
    return {
        "period": period,
        "expenses": [
            {"title": e.title, "amount": e.amount, "currency": e.currency,
             "category": e.category, "date": e.expense_date.isoformat()}
            for e in rows
        ],
        "total": sum(e.amount for e in rows),
    }


# ── Write tools (propose only — executed on confirm) ───────────────────────

def propose_create_expense(user: CurrentUser, title: str, amount: float, category: str | None = None,
                            expense_date: str | None = None) -> dict:
    _require_admin(user)
    return {
        "title": title,
        "amount": amount,
        "currency": "KGS",
        "category": category or "Прочее",
        "expense_date": expense_date or datetime.utcnow().date().isoformat(),
    }


def propose_create_consultation(user: CurrentUser, consult_date: str, consult_time: str) -> dict:
    return {"date": consult_date, "time": consult_time, "status": "booked"}


def execute_create_expense(db: Session, username: str, payload: dict) -> Expense:
    expense = Expense(
        title=payload["title"],
        amount=float(payload["amount"]),
        currency=payload.get("currency", "KGS"),
        category=payload.get("category"),
        expense_date=date.fromisoformat(payload["expense_date"]),
        created_by=username,
    )
    db.add(expense)
    db.commit()
    return expense


def execute_create_consultation(db: Session, payload: dict) -> ConsultationSlot:
    d = date.fromisoformat(payload["date"])
    t = datetime.strptime(payload["time"], "%H:%M").time()
    existing = db.scalar(
        select(ConsultationSlot).where(ConsultationSlot.date == d, ConsultationSlot.time == t)
    )
    if existing:
        existing.status = "booked"
        db.commit()
        return existing
    slot = ConsultationSlot(date=d, time=t, status="booked")
    db.add(slot)
    db.commit()
    return slot


# ── OpenAI tool schemas ──────────────────────────────────────────────────

READ_TOOLS = {
    "get_dialogues_summary": get_dialogues_summary,
    "get_analytics_summary": get_analytics_summary,
    "get_consultations": get_consultations,
    "get_products": get_products,
    "get_recent_sales": get_recent_sales,
    "get_open_shifts": get_open_shifts,
    "get_expenses": get_expenses,
}

PROPOSE_TOOLS = {
    "propose_create_expense": propose_create_expense,
    "propose_create_consultation": propose_create_consultation,
}

TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "get_dialogues_summary", "description": "Сводка по диалогам с клиентами: сколько всего лидов, у скольких включён ИИ, сколько сообщений сегодня.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_analytics_summary", "description": "Аналитика по ответам ИИ за период (финансово-чувствительные метрики, только для админов).",
        "parameters": {"type": "object", "properties": {
            "period": {"type": "string", "enum": ["today", "week", "month"]},
        }},
    }},
    {"type": "function", "function": {
        "name": "get_consultations", "description": "Список забронированных консультаций на дату (по умолчанию сегодня).",
        "parameters": {"type": "object", "properties": {
            "target_date": {"type": "string", "description": "YYYY-MM-DD"},
        }},
    }},
    {"type": "function", "function": {
        "name": "get_products", "description": "Список товаров из Товароучёта, опционально только те, что скоро закончатся.",
        "parameters": {"type": "object", "properties": {
            "low_stock_only": {"type": "boolean"},
        }},
    }},
    {"type": "function", "function": {
        "name": "get_recent_sales", "description": "Последние продажи из Товароучёта (только для админов).",
        "parameters": {"type": "object", "properties": {
            "limit": {"type": "integer"},
        }},
    }},
    {"type": "function", "function": {
        "name": "get_open_shifts", "description": "Открытые сейчас кассовые смены — кто из сотрудников сейчас работает.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_expenses", "description": "Список расходов за период (только для админов).",
        "parameters": {"type": "object", "properties": {
            "period": {"type": "string", "enum": ["today", "week", "month"]},
        }},
    }},
    {"type": "function", "function": {
        "name": "propose_create_expense",
        "description": "Предложить создать расход. НЕ создаёт запись — только формирует карточку подтверждения для пользователя.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string"},
            "amount": {"type": "number"},
            "category": {"type": "string"},
            "expense_date": {"type": "string", "description": "YYYY-MM-DD, по умолчанию сегодня"},
        }, "required": ["title", "amount"]},
    }},
    {"type": "function", "function": {
        "name": "propose_create_consultation",
        "description": "Предложить забронировать слот консультации. НЕ бронирует — только формирует карточку подтверждения.",
        "parameters": {"type": "object", "properties": {
            "consult_date": {"type": "string", "description": "YYYY-MM-DD"},
            "consult_time": {"type": "string", "description": "HH:MM"},
        }, "required": ["consult_date", "consult_time"]},
    }},
]
