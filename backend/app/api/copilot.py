from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.copilot_auth import CurrentUser, get_current_user
from app.db.session import get_db
from app.models.entities import CopilotConversation, CopilotMessage, CopilotPendingAction
from app.services import copilot_service, copilot_tools

router = APIRouter(prefix="/copilot", tags=["copilot"])


def _message_out(m: CopilotMessage) -> dict:
    return {
        "id": m.id, "role": m.role, "content": m.content,
        "buttons": m.buttons or [], "quick_actions": m.quick_actions or [],
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _get_conversation(db: Session, user: CurrentUser, conversation_id: int) -> CopilotConversation:
    conv = db.get(CopilotConversation, conversation_id)
    if not conv or conv.username != user.username:
        raise HTTPException(404, "Conversation not found")
    return conv


class ChatRequest(BaseModel):
    message: str
    conversation_id: int | None = None
    page_context: dict | None = None


@router.post("/chat")
def chat(body: ChatRequest, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    if not body.message.strip():
        raise HTTPException(400, "Empty message")

    if body.conversation_id:
        conv = _get_conversation(db, user, body.conversation_id)
    else:
        title = body.message.strip()[:60]
        conv = CopilotConversation(username=user.username, title=title)
        db.add(conv)
        db.commit()
        db.refresh(conv)

    copilot_service.save_message(db, conv.id, "user", body.message)

    result = copilot_service.handle_message(
        db=db, user=user, conversation_id=conv.id,
        user_text=body.message, page_context=body.page_context,
    )

    assistant_msg = copilot_service.save_message(
        db, conv.id, "assistant", result["reply"],
        buttons=result["buttons"], quick_actions=result["quick_actions"],
    )
    conv.updated_at = datetime.utcnow()
    db.commit()

    return {
        "conversation_id": conv.id,
        "message": _message_out(assistant_msg),
        "pending_action": result["pending_action"],
    }


@router.get("/conversations")
def list_conversations(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    convs = db.scalars(
        select(CopilotConversation)
        .where(CopilotConversation.username == user.username)
        .order_by(CopilotConversation.updated_at.desc())
    ).all()
    return [{"id": c.id, "title": c.title, "updated_at": c.updated_at.isoformat()} for c in convs]


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    conv = _get_conversation(db, user, conversation_id)
    messages = db.scalars(
        select(CopilotMessage).where(CopilotMessage.conversation_id == conv.id).order_by(CopilotMessage.created_at)
    ).all()
    return {"id": conv.id, "title": conv.title, "messages": [_message_out(m) for m in messages]}


class RenameRequest(BaseModel):
    title: str


@router.patch("/conversations/{conversation_id}")
def rename_conversation(conversation_id: int, body: RenameRequest, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    conv = _get_conversation(db, user, conversation_id)
    conv.title = body.title.strip()[:255] or conv.title
    db.commit()
    return {"ok": True, "title": conv.title}


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: int, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    conv = _get_conversation(db, user, conversation_id)
    db.query(CopilotMessage).filter(CopilotMessage.conversation_id == conv.id).delete()
    db.query(CopilotPendingAction).filter(CopilotPendingAction.conversation_id == conv.id).delete()
    db.delete(conv)
    db.commit()
    return {"ok": True}


class ConfirmActionRequest(BaseModel):
    edits: dict | None = None


@router.post("/actions/{action_id}/confirm")
def confirm_action(action_id: int, body: ConfirmActionRequest, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    action = db.get(CopilotPendingAction, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    _get_conversation(db, user, action.conversation_id)
    if action.status != "pending":
        raise HTTPException(409, f"Action already {action.status}")

    payload = {**action.payload, **(body.edits or {})}

    if action.tool_name == "propose_create_expense":
        expense = copilot_tools.execute_create_expense(db, user.username, payload)
        reply = f"Готово — расход «{expense.title}» на {expense.amount} {expense.currency} добавлен."
    elif action.tool_name == "propose_create_consultation":
        slot = copilot_tools.execute_create_consultation(db, payload)
        reply = f"Готово — консультация на {slot.date.isoformat()} {slot.time.strftime('%H:%M')} забронирована."
    else:
        raise HTTPException(400, f"Unknown action type {action.tool_name}")

    action.status = "confirmed"
    db.commit()

    assistant_msg = copilot_service.save_message(db, action.conversation_id, "assistant", reply)
    return {"ok": True, "message": _message_out(assistant_msg)}


@router.post("/actions/{action_id}/cancel")
def cancel_action(action_id: int, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    action = db.get(CopilotPendingAction, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    _get_conversation(db, user, action.conversation_id)
    if action.status == "pending":
        action.status = "cancelled"
        db.commit()
    return {"ok": True}
