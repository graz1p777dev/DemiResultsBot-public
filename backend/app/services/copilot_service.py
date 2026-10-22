"""Orchestrates the AI Copilot: knowledge-base lookup for CRM usage
questions, OpenAI function-calling for business-data questions and proposed
actions, RBAC enforcement (via copilot_tools), and persistence.
"""
import json
import logging

from openai import OpenAI, OpenAIError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.copilot_auth import CurrentUser
from app.data.copilot_kb import search_kb_scored
from app.models.entities import CopilotMessage, CopilotPendingAction
from app.services import copilot_tools

_log = logging.getLogger(__name__)

KB_MATCH_THRESHOLD = 1.2  # min IDF-weighted score to answer straight from the KB, no LLM round trip

TOOL_TO_KB_KEY = {
    "get_dialogues_summary": "dialogues",
    "get_analytics_summary": "analytics",
    "get_consultations": "consultations",
    "get_products": "inventory",
    "get_recent_sales": "inventory",
    "get_open_shifts": "inventory",
    "get_expenses": "expenses",
    "propose_create_expense": "expenses",
    "propose_create_consultation": "consultations",
}


def _kb_button(key: str) -> dict | None:
    from app.data.copilot_kb import KB
    entry = next((e for e in KB if e["key"] == key), None)
    if not entry or not entry.get("url"):
        return None
    return {"label": f"Открыть «{entry['title']}»", "href": entry["url"]}


def _kb_buttons_mentioned_in(text: str) -> list[dict]:
    """The system prompt tells the model to name the exact section title —
    ground the button in what it actually said, not a pre-guessed KB match.
    A pre-guessed match can rank top by keyword overlap while the model
    (using semantic understanding the keyword search doesn't have) correctly
    talks about a different section — attaching the guessed button then
    contradicts the reply text."""
    from app.data.copilot_kb import KB
    buttons = []
    for entry in KB:
        if entry["title"] in text or entry["url"] in text:
            btn = _kb_button(entry["key"])
            if btn and btn not in buttons:
                buttons.append(btn)
    return buttons


def _answer_from_kb(entry: dict) -> str:
    lines = [entry["description"]]
    if entry.get("actions"):
        lines.append("\n**Как это сделать:**")
        for i, action in enumerate(entry["actions"], 1):
            lines.append(f"{i}. {action}")
    if entry.get("tips"):
        lines.append("\n" + entry["tips"][0])
    return "\n".join(lines)


def _kb_sitemap() -> str:
    from app.data.copilot_kb import KB
    return "\n".join(f"- {e['title']} ({e['url']}): {e['description']}" for e in KB)


def _find_kb_entry_by_url(path: str | None) -> dict | None:
    if not path:
        return None
    from app.data.copilot_kb import KB
    return next((e for e in KB if e["url"] == path), None)


def _system_prompt(user: CurrentUser, page_context: dict | None, page_entry: dict | None) -> str:
    ctx = ""
    if page_context and page_context.get("path"):
        ctx = f"\nПользователь сейчас находится на странице: {page_context['path']}."
        if page_entry:
            ctx += (
                f" Это раздел «{page_entry['title']}»: {page_entry['description']} "
                f"Что там можно делать: {'; '.join(page_entry.get('actions', [])) or '—'}. "
                "Если вопрос звучит как «как это сделать», «как добавить», «тут»/«здесь» без явного "
                "указания раздела — считай, что речь именно об этой странице, а не о какой-то другой."
            )
        if page_context.get("extra"):
            ctx += f" Доп. контекст: {json.dumps(page_context['extra'], ensure_ascii=False)}."
    return (
        "Ты — рабочий ИИ-помощник внутри CRM Demi Results для владельца, руководителей и сотрудников. "
        "Твоя задача — помочь человеку выполнить действие в CRM или понять реальные данные, а не просто дать общее описание.\n\n"
        "Правила ответа:\n"
        "1. Сначала дай прямой ответ или ближайшее конкретное действие.\n"
        "2. Для инструкции укажи точный раздел и 2–6 последовательных шагов с реальными названиями кнопок из базы знаний.\n"
        "3. Учитывай текущую страницу и роль пользователя. Не предлагай действие, на которое нет доступа.\n"
        "4. Не выдумывай цифры, клиентов, сделки, кнопки, статусы или возможности. Данные компании получай только инструментами.\n"
        "5. Ясно разделяй подтверждённый факт, расчёт и предположение. Если данных недостаточно — задай один короткий уточняющий вопрос.\n"
        "6. Перед любой записью или изменением покажи, что именно будет изменено, и дождись подтверждения.\n"
        "7. При ошибке объясни человеческим языком, что проверить сейчас; не отправляй пользователя к разработчику без конкретной диагностики.\n"
        "8. Пиши на языке пользователя, спокойно и кратко. Для русского используй понятные слова без технического жаргона.\n\n"
        "Вот полный список разделов CRM — единственный источник правды о том, что есть в системе:\n"
        f"{_kb_sitemap()}\n\n"
        "Если вопрос касается того, как что-то сделать в CRM, и подходящий раздел есть в списке выше — "
        "отвечай на основе этого описания и обязательно назови точное название раздела в ответе. "
        "НИКОГДА не говори, что функция недоступна, не реализована или требует обращения к "
        "разработчикам/техподдержке, если соответствующий раздел есть в списке выше — в этом случае "
        "просто объясни, как это сделать через указанный раздел. "
        "Не выдумывай разделы или кнопки, которых нет в списке. "
        "Для вопросов о данных компании (продажи, расходы, консультации, товары, сотрудники) вызывай "
        "соответствующий инструмент — никогда не придумывай цифры сам. "
        "Если инструмент недоступен из-за прав доступа — вежливо сообщи, что этот раздел недоступен, "
        "не пытайся обойти ограничение. "
        f"Пользователь: {user.username}, администратор: {'да' if user.is_admin else 'нет'}."
        f"{ctx} "
        "Создание товаров есть в CRM — это в Товароучёте, кнопка «Создать новый товар или услугу» "
        "на странице товаров. Не путай это с созданием клиентов/задач — их в CRM пока правда нет, "
        "об этом (и только об этом) можно сказать, что не реализовано."
    )


def _dispatch_tool(db: Session, user: CurrentUser, name: str, args: dict) -> tuple[dict, dict | None]:
    """Returns (tool_result_for_model, pending_action_payload_or_None)."""
    try:
        if name in copilot_tools.PROPOSE_TOOLS:
            fn = copilot_tools.PROPOSE_TOOLS[name]
            payload = fn(user=user, **args)
            return {"status": "awaiting_confirmation", "proposed": payload}, payload

        fn = copilot_tools.READ_TOOLS.get(name)
        if not fn:
            return {"error": f"Unknown tool {name}"}, None

        if name in ("get_dialogues_summary", "get_analytics_summary", "get_consultations", "get_expenses"):
            result = fn(db=db, user=user, **args)
        else:
            result = fn(user=user, **args)
        return result, None
    except copilot_tools.ToolError as e:
        return {"error": e.message}, None


def handle_message(
    db: Session,
    user: CurrentUser,
    conversation_id: int,
    user_text: str,
    page_context: dict | None = None,
) -> dict:
    page_entry = _find_kb_entry_by_url((page_context or {}).get("path"))

    kb_hits = search_kb_scored(user_text, top_k=20)
    if page_entry:
        # Пользователь спрашивает "как это сделать" находясь на конкретной
        # странице — если для неё есть хоть какое-то текстовое совпадение,
        # не даём странице с чуть большим случайным перевесом победить
        # страницу, на которой человек реально находится.
        for i, (score, entry) in enumerate(kb_hits):
            if entry["key"] == page_entry["key"] and score > 0:
                kb_hits[i] = (score + 2.0, entry)
                break
        kb_hits.sort(key=lambda t: t[0], reverse=True)

    if kb_hits and kb_hits[0][0] >= KB_MATCH_THRESHOLD:
        _, entry = kb_hits[0]
        reply = _answer_from_kb(entry)
        button = _kb_button(entry["key"])
        return {"reply": reply, "buttons": [button] if button else [], "quick_actions": [], "pending_action": None}

    if not settings.openai_api_key:
        return {
            "reply": "ИИ-помощник временно недоступен: не настроен ключ OpenAI.",
            "buttons": [], "quick_actions": [], "pending_action": None,
        }

    client = OpenAI(api_key=settings.openai_api_key)
    messages = [
        {"role": "system", "content": _system_prompt(user, page_context, page_entry)},
        {"role": "user", "content": user_text},
    ]

    buttons: list[dict] = []
    pending_payload: dict | None = None
    pending_tool_name: str | None = None

    try:
        response = client.chat.completions.create(
            model=settings.copilot_openai_model,
            messages=messages,
            tools=copilot_tools.TOOL_SCHEMAS,
            tool_choice="auto",
        )
        msg = response.choices[0].message

        if msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content, "tool_calls": [
                {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ]})
            for tc in msg.tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                result, pending = _dispatch_tool(db, user, name, args)
                if pending is not None:
                    pending_payload = pending
                    pending_tool_name = name
                kb_key = TOOL_TO_KB_KEY.get(name)
                if kb_key and "error" not in result:
                    btn = _kb_button(kb_key)
                    if btn and btn not in buttons:
                        buttons.append(btn)
                messages.append({
                    "role": "tool", "tool_call_id": tc.id,
                    "content": json.dumps(result, ensure_ascii=False, default=str),
                })

            follow_up = client.chat.completions.create(
                model=settings.copilot_openai_model,
                messages=messages,
            )
            reply = follow_up.choices[0].message.content or ""
        else:
            reply = msg.content or ""
    except OpenAIError as e:
        _log.warning("Copilot OpenAI call failed: %s", e)
        return {
            "reply": "ИИ-помощник временно недоступен — не удалось связаться с провайдером ИИ. Попробуйте ещё раз чуть позже.",
            "buttons": [], "quick_actions": [], "pending_action": None,
        }

    # Кнопка должна соответствовать тому, что модель реально написала —
    # не угадыванию по ключевым словам, которое может указывать на другой
    # раздел, чем тот, о котором она рассказала в ответе.
    for btn in _kb_buttons_mentioned_in(reply):
        if btn not in buttons:
            buttons.append(btn)

    pending_action = None
    if pending_payload is not None:
        action = CopilotPendingAction(
            conversation_id=conversation_id,
            tool_name=pending_tool_name,
            payload=pending_payload,
            status="pending",
        )
        db.add(action)
        db.commit()
        db.refresh(action)
        pending_action = {"id": action.id, "tool_name": action.tool_name, "payload": action.payload}

    return {"reply": reply, "buttons": buttons, "quick_actions": [], "pending_action": pending_action}


def save_message(db: Session, conversation_id: int, role: str, content: str,
                  buttons: list | None = None, quick_actions: list | None = None) -> CopilotMessage:
    message = CopilotMessage(
        conversation_id=conversation_id, role=role, content=content,
        buttons=buttons or None, quick_actions=quick_actions or None,
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return message
