import io
import json
import logging
import re
from time import perf_counter

import httpx
from openai import APIStatusError, BadRequestError, OpenAI
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings
from app.services.prompts import (
    EXTRACTOR_SYSTEM_PROMPT,
    SALES_AGENT_SYSTEM_PROMPT,
    SALES_INTENT_SYSTEM_PROMPT,
)

_log = logging.getLogger(__name__)

CONSULTATIVE_METHOD_PROMPT = """
КОНСУЛЬТАТИВНЫЙ ПОДХОД (SPIN, Карнеги, Сьюэлл, Блаунт):
Цель — понять человека, помочь решить его задачу и выстроить долгосрочные отношения, а не просто продать. Больше слушай, не спорь, признавай эмоции.
Веди SPIN-диалог постепенно: узнай тип кожи, текущий уход, аллергии и прошлый опыт, что беспокоит, как давно и какой результат важен. Не запугивай; максимум один-два вопроса за раз. Не спрашивай то, что уже есть в истории или карточке.
На прямой вопрос о цене, наличии или адресе сначала ответь по достоверным данным. Предлагай товар или консультацию только когда потребность понятна, и кратко объясняй, почему это подходит. Если не подходит — скажи честно.
Используй имя только если оно известно и это звучит естественно. Учитывай прошлые покупки и предпочтения.
При возражении: 1) признай эмоцию, 2) уточни причину, 3) предложи решение без давления. На «дорого» уточни, смущает ли цена или нужно сравнение; на «подумаю» или «не уверен» мягко уточни сомнение.
Пиши коротко, тепло и без канцелярита.
""".strip()

_PICTURE_RE = re.compile(r'\[picture\]\s*(https?://\S+)')
_VOICE_RE = re.compile(r'\[voice\][ \t]*(https?://\S+)[ \t]*')

# Marker the manager fills in on a 'wants to buy' card. Kept in sync with telegram.py / webhooks.py.
PURCHASE_PLACEHOLDER = "{ответ пользователя}"


class AIResult(BaseModel):
    content: str | dict
    model: str
    provider: str | None = None
    purpose: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    input_cost: float = 0
    output_cost: float = 0
    total_cost: float = 0
    latency_ms: int | None = None
    raw_usage: dict | None = None
    reasoning: str | None = None


def _client() -> OpenAI:
    return OpenAI(api_key=settings.openai_api_key)


def _create_completion(**kwargs):
    """chat.completions.create, устойчивый к моделям, не принимающим temperature.

    gpt-5.x отвечает 400 «temperature does not support 0.5, only the default (1)».
    Из-за этого бот молча переставал отвечать сложным клиентам: sales-модель по
    умолчанию именно такая. Держать список «кто что поддерживает» бессмысленно —
    он устареет к следующему релизу OpenAI. Поэтому ловим конкретный отказ один
    раз и повторяем запрос без параметра.
    """
    allow_quota_fallback = kwargs.pop("_allow_quota_fallback", True)
    try:
        try:
            return _client().chat.completions.create(**kwargs)
        except BadRequestError as exc:
            if "temperature" not in kwargs or "temperature" not in str(exc):
                raise
            _log.warning("model %s rejects temperature, retrying with the default", kwargs.get("model"))
            kwargs.pop("temperature")
            return _client().chat.completions.create(**kwargs)
    except APIStatusError as exc:
        if (exc.status_code != 429
                or exc.code not in {"credit_balance_exhausted", "insufficient_quota"}
                or not allow_quota_fallback
                or not settings.deepseek_api_key
                or set(kwargs) - {"model", "messages", "temperature", "response_format", "max_tokens", "max_completion_tokens"}
                or kwargs.get("response_format", {}).get("type", "text") not in {"text", "json_object"}
                or not all(isinstance(message.get("content"), str) for message in kwargs.get("messages", []))):
            raise
        _log.warning("OpenAI quota exhausted; using existing DeepSeek text client")
        fallback_kwargs = {**kwargs, "model": "deepseek-flash", "extra_body": {"thinking": {"type": "disabled"}}}
        if "max_completion_tokens" in fallback_kwargs:
            if "max_tokens" in fallback_kwargs:
                raise ValueError("Conflicting completion token limits")
            fallback_kwargs["max_tokens"] = fallback_kwargs.pop("max_completion_tokens")
        response = _deepseek_client().chat.completions.create(**fallback_kwargs)
        # The fallback must fail through to the caller's existing manual path,
        # rather than turn an empty or malformed JSON response into a draft.
        content = response.choices[0].message.content
        if not content or not content.strip():
            raise ValueError("DeepSeek returned an empty completion")
        if kwargs.get("response_format", {}).get("type") == "json_object":
            if not isinstance(json.loads(content), dict):
                raise ValueError("DeepSeek did not return a JSON object")
        object.__setattr__(response, "_fallback_provider", "deepseek")
        return response


def _usage_payload(response) -> dict:
    usage = getattr(response, "usage", None)
    payload = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage or {})
    model = getattr(response, "model", None)
    if getattr(response, "_fallback_provider", None) == "deepseek" or (isinstance(model, str) and model.lower().startswith("deepseek-")):
        payload.update(provider="deepseek", model=model)
    return payload


def _result(
    content: str | dict,
    model: str,
    purpose: str,
    usage: dict,
    latency_ms: int,
    input_cost_per_1m: float | None = None,
    output_cost_per_1m: float | None = None,
    reasoning: str | None = None,
) -> AIResult:
    provider = usage.get("provider")
    if provider == "deepseek":
        model = usage["model"]
        input_cost_per_1m = settings.deepseek_input_cost_per_1m
        output_cost_per_1m = settings.deepseek_output_cost_per_1m
        usage = {**usage, "pricing_basis": "configured_estimate"}
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    _in = input_cost_per_1m if input_cost_per_1m is not None else settings.openai_input_cost_per_1m_tokens
    _out = output_cost_per_1m if output_cost_per_1m is not None else settings.openai_output_cost_per_1m_tokens
    input_cost = prompt_tokens / 1_000_000 * _in
    output_cost = completion_tokens / 1_000_000 * _out
    return AIResult(
        content=content,
        model=model,
        provider=provider or ("deepseek" if model.startswith("deepseek-") else "openai"),
        purpose=purpose,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=int(usage.get("total_tokens") or prompt_tokens + completion_tokens),
        input_cost=round(input_cost, 8),
        output_cost=round(output_cost, 8),
        total_cost=round(input_cost + output_cost, 8),
        latency_ms=latency_ms,
        raw_usage=usage or None,
        reasoning=reasoning,
    )


def _extract_image_urls(dialogue: list[dict]) -> list[str]:
    urls = []
    for msg in dialogue:
        if msg.get("role") == "user":
            for m in _PICTURE_RE.finditer(msg.get("content", "")):
                urls.append(m.group(1))
    return urls


def _annotate_pictures(text: str) -> str:
    """Replace `[picture] <url>` with a marker the text classifier can act on.

    The reply generator gets the actual pixels, but classify_sales_intent runs on
    a text-only model: it would see a bare amoCRM URL and cannot tell a jar of
    cream from a selfie. Leaving the URL in also invites the model to invent
    what the image shows. The marker says only what is certain — a photo exists.
    """
    return _PICTURE_RE.sub("[КЛИЕНТ ПРИСЛАЛ ФОТО]", text)


def strip_voice_marker(text: str) -> str:
    """Replace a leading `[voice] <url>` with the Whisper transcript that follows it.

    Every AI call (intent classifier, reply generator, language detection) should
    read the words the client actually said, not a bare amoCRM audio URL none of
    them can open. If transcription failed and no words follow, fall back to a
    marker so the model still knows a voice message arrived.
    """
    if not _VOICE_RE.search(text):
        return text
    # History prefixes and buffered messages can contain several voice markers.
    # Keep transcripts/speaker labels, never give a text model an audio URL.
    def replace(match):
        tail = text[match.end():].strip()
        return "" if tail and not tail.startswith(('[voice]', '[клиент', '[менеджер', '[бот')) else "[клиент отправил голосовое сообщение, распознать не удалось] "
    return _VOICE_RE.sub(replace, text).strip()


def _annotate_dialogue(dialogue: list[dict]) -> list[dict]:
    return [
        {**m, "content": strip_voice_marker(_annotate_pictures(m.get("content", "")))}
        for m in dialogue
    ]


def _download_images_as_data_urls(urls: list[str], limit: int = 3) -> list[str]:
    """Download images ourselves and return base64 data URLs.

    amoCRM drive links are not publicly accessible, so OpenAI cannot fetch
    them server-side (returns 400). Downloading and inlining as base64
    avoids that. Images that fail to download are skipped.
    """
    import base64

    data_urls: list[str] = []
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        for url in urls[-limit:]:
            try:
                resp = client.get(url)
                if not resp.is_success or not resp.content:
                    _log.warning("image download failed url=%.80s status=%s", url, resp.status_code)
                    continue
                content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
                if not content_type.startswith("image/"):
                    content_type = "image/jpeg"
                encoded = base64.b64encode(resp.content).decode()
                data_urls.append(f"data:{content_type};base64,{encoded}")
            except Exception as exc:
                _log.warning("image download error url=%.80s: %s", url, exc)
    return data_urls


def _clean_dialogue(dialogue: list[dict]) -> list[dict]:
    cleaned = []
    for msg in dialogue:
        content = _PICTURE_RE.sub("[клиент прислал фото]", msg.get("content", ""))
        content = strip_voice_marker(content)
        cleaned.append({"role": msg["role"], "content": content})
    return cleaned


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def generate_reply(
    dialogue: list[dict],
    slot_context: dict,
    system_prompt: str | None = None,
    memory_context: str | None = None,
    use_sales_model: bool = False,
    model_override: str | None = None,
) -> AIResult:
    for message in reversed(dialogue):
        if message.get('role') == 'assistant':
            break
        if message.get('role') == 'user' and '[клиент отправил голосовое сообщение, распознать не удалось]' in strip_voice_marker(message.get('content', '')):
            raise RuntimeError('Voice transcription unavailable; manager must listen to the original audio. Do not ask the client to repeat it as text.')
    _model = model_override or (settings.openai_model_sales if use_sales_model else settings.openai_model_simple)
    _in_cost = settings.openai_input_cost_sales if use_sales_model else settings.openai_input_cost_simple
    _out_cost = settings.openai_output_cost_sales if use_sales_model else settings.openai_output_cost_simple
    if not settings.openai_api_key:
        return AIResult(
            content="Здравствуйте 👋 Подскажите, пожалуйста, что сейчас беспокоит вашу кожу?",
            model=_model,
            purpose="sales_agent",
        )
    started = perf_counter()

    image_urls = _extract_image_urls(dialogue)
    cleaned = _clean_dialogue(dialogue)

    # Build context header injected into every request regardless of system prompt
    now_bk = slot_context.get("now_bishkek", "")
    is_working = slot_context.get("is_working_hours", True)
    minutes_since = slot_context.get("minutes_since_last_message", 9999)

    time_note = f"[СИСТЕМНОЕ ВРЕМЯ БИШКЕК: {now_bk} {slot_context.get('date_bishkek', '')}]\n"

    if minutes_since <= 60:
        time_note += "[НЕ ПРИВЕТСТВУЙ — диалог продолжается, прошло менее 60 минут с последнего сообщения клиента.]\n"
    else:
        time_note += "[ПРИВЕТСТВИЕ: если диалог начался только что (нет предыдущих ответов ассистента) — поздоровайся «Здравствуйте» один раз. Если ассистент уже отвечал — не приветствуй снова.]\n"

    if not is_working:
        time_note += "[НЕРАБОЧЕЕ ВРЕМЯ. ОБЯЗАТЕЛЬНО: в начале ответа сообщи что магазин работает с 10:00 до 21:00. НЕ предлагай запись на консультацию.]\n"
        # Clear free slots so model cannot offer a specific time
        slot_context = {**slot_context, "free_slots": []}
    client_lang = slot_context.get("client_language", "ru")
    if client_lang and client_lang != "ru":
        _lang_names = {"ky": "кыргызском", "kz": "казахском", "en": "английском", "tr": "турецком", "uz": "узбекском", "de": "немецком", "fr": "французском", "zh": "китайском"}
        lang_label = _lang_names.get(client_lang, client_lang)
        time_note += f"[ЯЗЫК КЛИЕНТА: {lang_label} ({client_lang}). СТРОГО ОБЯЗАТЕЛЬНО: пиши ответ ТОЛЬКО на {lang_label} языке. Никакого русского!]\n"

    context_text = time_note + json.dumps(
        {"dialogue": cleaned, "check_consultation_slots": slot_context},
        ensure_ascii=False,
    )

    data_urls = _download_images_as_data_urls(image_urls) if image_urls else []
    if data_urls:
        content: list[dict] = [{"type": "image_url", "image_url": {"url": url}} for url in data_urls]
        content.append({"type": "text", "text": context_text})
        user_message: dict = {"role": "user", "content": content}
    else:
        user_message = {"role": "user", "content": context_text}

    _base_prompt = system_prompt or SALES_AGENT_SYSTEM_PROMPT
    if memory_context and memory_context.strip():
        _base_prompt = _base_prompt + "\n\n---\nПАМЯТЬ МАГАЗИНА (используй эти данные при ответах):\n" + memory_context.strip()
    _base_prompt = _base_prompt + "\n\n---\n" + CONSULTATIVE_METHOD_PROMPT
    _base_prompt = _base_prompt + (
        "\n\n---\nПРИОРИТЕТ ФАКТОВ: текущие системные инструкции и память магазина "
        "имеют приоритет над историей диалога. Прошлые ответы ассистента могут содержать "
        "устаревшие или ошибочные факты. При расхождении используй текущие инструкции "
        "и память магазина; не придумывай отсутствующие в них факты."
        "\n\n---\nФОРМАТ СООБЩЕНИЙ: иногда, когда это звучит естественно, разделяй ответ "
        "на два коротких сообщения: сначала ответ, затем один следующий вопрос. Между ними ставь "
        "маркер <NEXT_MESSAGE> на отдельной строке. Максимум три сообщения. Не используй маркер "
        "в каждом ответе, не дели одну мысль и не повторяй приветствие в каждой части."
        "\n\n---\nФОРМАТ ОТВЕТА: верни строго JSON без пояснений вокруг: "
        '{"reasoning": "1-3 предложения от первого лица — что учла и почему ответила именно так", '
        '"reply": "текст ответа клиенту, как обычно"}.'
    )
    try:
        response = _create_completion(
            model=_model,
            _allow_quota_fallback=not image_urls,
            temperature=0.5,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _base_prompt},
                user_message,
            ],
        )
    except BadRequestError:
        if not data_urls:
            raise
        # Images rejected by the API — retry text-only so the client still gets a reply
        _log.warning("generate_reply 400 with images, retrying text-only")
        response = _create_completion(
            model=_model,
            _allow_quota_fallback=not image_urls,
            temperature=0.5,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _base_prompt},
                {"role": "user", "content": context_text},
            ],
        )
    latency_ms = int((perf_counter() - started) * 1000)
    raw_content = response.choices[0].message.content or ""
    try:
        parsed = json.loads(raw_content)
        reply_text = str(parsed.get("reply", "")).strip()
        reasoning_text = str(parsed.get("reasoning", "")).strip() or None
    except (json.JSONDecodeError, AttributeError):
        _log.warning("generate_reply: model did not return JSON, using raw content as reply")
        reply_text = raw_content.strip()
        reasoning_text = None
    if getattr(response, "_fallback_provider", None) == "deepseek" and not reply_text:
        raise ValueError("DeepSeek returned no reply")
    return _result(
        content=reply_text,
        model=_model,
        purpose="sales_agent",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=_in_cost,
        output_cost_per_1m=_out_cost,
        reasoning=reasoning_text,
    )


REPLY_CHECK_SYSTEM_PROMPT = """Ты — контролёр качества ответов Айым, помощника косметолога Demi Results.
Тебе дают историю диалога и черновик ответа. Проверь ответ по чек-листу:

1. Понятно ли из ответа, что ассистент понял, что хочет клиент?
2. Не повторяет ли ответ информацию/вопросы, которые уже были в диалоге?
3. Нет ли лишних вопросов (максимум 1-2 вопроса, только нужные)?
4. Не предлагается ли консультация слишком рано (до понимания проблемы) или повторно после отказа?
5. Звучит ли ответ как сообщение живого человека (тепло, коротко, без шаблонности)?
6. Ответ короче 4 предложений?
7. Маркер <NEXT_MESSAGE> допустим только между законченными короткими мыслями,
   максимум два раза. При исправлении сохрани уместное разделение этим маркером.
8. Проверь факты по переданным актуальным бизнес-инструкциям и памяти магазина.
   Они имеют приоритет над историей диалога, включая прошлые ответы ассистента.
   Исправь противоречащие им часы работы, цены, адреса и условия только по этим данным.
   Если актуальных данных нет, не придумывай факты и не считай старые ответы ассистента подтверждением.

Верни строго JSON:
{"ok": true, "fixed_reply": null}
— если ответ проходит все пункты.
{"ok": false, "fixed_reply": "исправленный текст"}
— если есть проблемы: перепиши ответ так, чтобы он прошёл все пункты. Сохраняй язык, тон «на Вы», эмодзи умеренно. Не добавляй новых фактов, цен и слотов.
"""


def verify_reply(
    dialogue: list[dict], reply: str, *, business_instructions: str | None = None,
) -> tuple[str, AIResult | None]:
    """Self-check pass: validate the draft reply against the quality checklist.

    Returns (final_reply, usage). On any failure returns the original reply.
    business_instructions contains the caller's current trusted prompt and bot memory.
    """
    if not settings.openai_api_key or not reply.strip():
        return reply, None
    try:
        started = perf_counter()
        # Last few turns are enough context for the checklist
        recent = _clean_dialogue(dialogue[-10:])
        payload = json.dumps({"dialogue": recent, "draft_reply": reply}, ensure_ascii=False)
        check_prompt = REPLY_CHECK_SYSTEM_PROMPT
        if business_instructions and business_instructions.strip():
            check_prompt += "\n\nАКТУАЛЬНЫЕ БИЗНЕС-ИНСТРУКЦИИ И ПАМЯТЬ МАГАЗИНА:\n" + business_instructions.strip()
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": check_prompt},
                {"role": "user", "content": payload},
            ],
        )
        latency_ms = int((perf_counter() - started) * 1000)
        data = json.loads(response.choices[0].message.content or "{}")
        usage = _result(
            content="",
            model=settings.openai_extractor_model,
            purpose="reply_check",
            usage=_usage_payload(response),
            latency_ms=latency_ms,
            input_cost_per_1m=settings.openai_input_cost_extractor,
            output_cost_per_1m=settings.openai_output_cost_extractor,
        )
        fixed = (data.get("fixed_reply") or "").strip()
        if not data.get("ok") and fixed:
            _log.info("reply_check rewrote reply: %.80s -> %.80s", reply, fixed)
            return fixed, usage
        return reply, usage
    except Exception as exc:
        _log.warning("verify_reply failed: %s", exc)
        return reply, None


def summarize_dialogue(dialogue: list[dict]) -> tuple[str, AIResult | None]:
    """Generate a brief hypervisor summary of the full conversation for managers."""
    if not dialogue:
        return "", None
    if not settings.openai_api_key:
        return "", None
    try:
        text = "\n".join(
            f"{'Клиент' if m['role'] == 'user' else 'Бот'}: {strip_voice_marker(str(m.get('content', '')))[:300]}"
            for m in dialogue
        )
        t0 = perf_counter()
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0,
            messages=[
                {"role": "system", "content": (
                    "Ты — помощник менеджера. Прочитай диалог и напиши краткое резюме для менеджера в 2-3 предложениях. "
                    "Укажи: что беспокоит клиента, на каком этапе разговор, было ли уже предложено что-то. "
                    "Пиши по-русски, кратко и по делу."
                )},
                {"role": "user", "content": text},
            ],
        )
        latency_ms = int((perf_counter() - t0) * 1000)
        result = _result(
            response.choices[0].message.content or "",
            model=settings.openai_extractor_model,
            purpose="hypervisor",
            usage=_usage_payload(response),
            latency_ms=latency_ms,
            input_cost_per_1m=settings.openai_input_cost_extractor,
            output_cost_per_1m=settings.openai_output_cost_extractor,
        )
        return result.content.strip(), result
    except Exception:
        return "", None


def detect_language(text: str) -> str:
    """Return ISO 639-1 language code for text (e.g. 'ru', 'ky', 'en'). Defaults to 'ru' on error."""
    if not settings.openai_api_key or not text.strip():
        return "ru"
    try:
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0,
            messages=[
                {"role": "system", "content": (
                    "Определи язык текста. Ответь ТОЛЬКО кодом языка ISO 639-1, без пробелов и пояснений. "
                    "Примеры: ru, ky, kz, en, tr, uz, de, fr, zh. "
                    "ВАЖНО: кыргызский — ky, казахский — kz; они пишутся кириллицей, но это НЕ русский (ru)."
                )},
                {"role": "user", "content": text[:400]},
            ],
        )
        code = (response.choices[0].message.content or "ru").strip().lower()
        return code[:5] if code else "ru"
    except Exception:
        return "ru"


def detect_and_translate(client_message: str, ai_reply: str) -> dict[str, str | None]:
    """Detect client message language. If not Russian, return Russian translations of both texts."""
    if not settings.openai_api_key:
        return {"client_translation": None, "ai_reply_translation": None}
    try:
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0,
            messages=[
                {"role": "system", "content": (
                    "Определи язык сообщения клиента. "
                    "ВАЖНО: кыргызский и казахский — это НЕ русский, даже если написаны кириллицей. "
                    "Если язык НЕ русский — переведи оба текста на русский язык. "
                    "Ответь строго JSON: "
                    "{\"is_russian\": true|false, \"client\": null|\"перевод\", \"reply\": null|\"перевод\"}. "
                    "Если русский: client=null, reply=null."
                )},
                {"role": "user", "content": (
                    f"Сообщение клиента:\n{strip_voice_marker(client_message)[:600]}\n\n"
                    f"Ответ бота:\n{ai_reply[:600]}"
                )},
            ],
        )
        raw = (response.choices[0].message.content or "").strip()
        data = json.loads(raw)
        if data.get("is_russian", True):
            return {"client_translation": None, "ai_reply_translation": None}
        return {
            "client_translation": str(data.get("client") or "").strip() or None,
            "ai_reply_translation": str(data.get("reply") or "").strip() or None,
        }
    except Exception:
        return {"client_translation": None, "ai_reply_translation": None}


def _deepseek_client() -> OpenAI:
    return OpenAI(api_key=settings.deepseek_api_key, base_url="https://api.deepseek.com/v1")


def call_gemini(model: str, messages: list[dict], temperature: float = 0.5) -> tuple[str, dict]:
    """Call Google's Generative Language API directly over REST (no extra SDK dependency).

    `messages` uses the same OpenAI-style shape the Laboratory tester already builds
    (role: system/user/assistant, content: str or list of content parts). Returns
    (reply_text, usage) where usage has prompt_tokens/completion_tokens/total_tokens.
    """
    if not settings.gemini_api_key:
        return "Здравствуйте 👋 (Gemini API key не настроен)", {}

    system_text = ""
    contents: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "system":
            system_text = content if isinstance(content, str) else str(content)
            continue
        parts: list[dict] = []
        if isinstance(content, str):
            parts.append({"text": content})
        elif isinstance(content, list):
            for block in content:
                if block.get("type") == "text":
                    parts.append({"text": block.get("text", "")})
                elif block.get("type") == "image_url":
                    url = block.get("image_url", {}).get("url", "")
                    if url.startswith("data:"):
                        header, _, b64data = url.partition(",")
                        mime = header.split(";")[0].replace("data:", "") or "image/jpeg"
                        parts.append({"inline_data": {"mime_type": mime, "data": b64data}})
        contents.append({"role": "model" if role == "assistant" else "user", "parts": parts})

    body: dict = {"contents": contents, "generationConfig": {"temperature": temperature}}
    if system_text:
        body["systemInstruction"] = {"parts": [{"text": system_text}]}

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    with httpx.Client(timeout=60) as client:
        resp = client.post(url, params={"key": settings.gemini_api_key}, json=body)
        resp.raise_for_status()
        data = resp.json()

    text = ""
    candidates = data.get("candidates") or []
    if candidates:
        for part in candidates[0].get("content", {}).get("parts", []):
            text += part.get("text", "")
    usage_meta = data.get("usageMetadata", {})
    usage = {
        "prompt_tokens": usage_meta.get("promptTokenCount", 0),
        "completion_tokens": usage_meta.get("candidatesTokenCount", 0),
        "total_tokens": usage_meta.get("totalTokenCount", 0),
    }
    return text.strip(), usage


def _classify_intent_with_vision(
    fallback: dict,
    latest_message: str,
    dialogue: list[dict],
    image_urls: list[str],
) -> AIResult | None:
    """Classify intent while actually looking at the photos the client sent.

    The prompt promises to spot `прислал фото товара`, but the default classifier
    is a text-only model that only ever sees the amoCRM URL. Without this the rule
    can never fire — a jar of cream and a selfie of acne look identical to it.

    Returns None on any failure so the caller falls back to text classification:
    a wrong `is_purchase` skips the AI reply and moves the lead to the purchase
    stage, so guessing is worse than classifying on text alone.
    """
    data_urls = _download_images_as_data_urls(image_urls)
    if not data_urls:
        return None

    payload = json.dumps(
        {
            # Classification needs the recent intent, not the full transcript.
            # Reply generation still receives the last 30 messages below.
            "dialogue": _annotate_dialogue(dialogue[-12:]),
            "latest_message": strip_voice_marker(_annotate_pictures(latest_message)),
        },
        ensure_ascii=False,
    )
    content_blocks: list[dict] = [{"type": "text", "text": payload}]
    content_blocks += [{"type": "image_url", "image_url": {"url": u}} for u in data_urls]

    try:
        started = perf_counter()
        response = _create_completion(
            model=settings.openai_model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SALES_INTENT_SYSTEM_PROMPT},
                {"role": "user", "content": content_blocks},
            ],
        )
        latency_ms = int((perf_counter() - started) * 1000)
    except Exception:
        _log.warning(
            "vision intent classification failed for %d image(s), falling back to text",
            len(data_urls),
            exc_info=True,
        )
        return None

    content = _normalize_intent(fallback, response.choices[0].message.content)
    return _result(
        content=content,
        model=settings.openai_model,
        purpose="sales_intent_vision",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_extractor,
        output_cost_per_1m=settings.openai_output_cost_extractor,
    )


def _normalize_intent(fallback: dict, raw: str | None) -> dict:
    content = fallback | json.loads(raw or "{}")
    content["is_sales"] = bool(content.get("is_sales"))
    content["is_complex"] = bool(content.get("is_complex", True))
    # Anything truthy would route the lead to the purchase stage and skip the AI
    # reply entirely, so coerce explicitly instead of trusting the model's JSON.
    content["is_purchase"] = bool(content.get("is_purchase"))
    return content


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def classify_sales_intent(dialogue: list[dict], latest_message: str) -> AIResult:
    fallback = {"is_sales": True, "is_complex": True, "is_purchase": False, "reason": "no_key"}
    model = "deepseek-v4-flash"

    image_urls = _extract_image_urls([{"role": "user", "content": latest_message}])
    if image_urls and settings.openai_api_key:
        result = _classify_intent_with_vision(fallback, latest_message, dialogue, image_urls)
        if result is not None:
            return result

    payload = json.dumps(
        {
            "dialogue": _annotate_dialogue(dialogue[-20:]),
            "latest_message": strip_voice_marker(_annotate_pictures(latest_message)),
        },
        ensure_ascii=False,
    )

    if not settings.deepseek_api_key:
        # fallback to openai if deepseek not configured
        if not settings.openai_api_key:
            return AIResult(content=fallback, model=model, purpose="sales_intent")
        started = perf_counter()
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SALES_INTENT_SYSTEM_PROMPT},
                {"role": "user", "content": payload},
            ],
        )
        latency_ms = int((perf_counter() - started) * 1000)
        content = _normalize_intent(fallback, response.choices[0].message.content)
        return _result(content=content, model=settings.openai_extractor_model,
                       purpose="sales_intent", usage=_usage_payload(response), latency_ms=latency_ms,
                       input_cost_per_1m=settings.openai_input_cost_extractor,
                       output_cost_per_1m=settings.openai_output_cost_extractor)

    started = perf_counter()
    response = _deepseek_client().chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SALES_INTENT_SYSTEM_PROMPT},
            {"role": "user", "content": payload},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    content = _normalize_intent(fallback, response.choices[0].message.content)
    return _result(
        content=content,
        model=model,
        purpose="sales_intent",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.deepseek_input_cost_per_1m,
        output_cost_per_1m=settings.deepseek_output_cost_per_1m,
    )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def extract_fields(dialogue: list[dict], contacts: str | None) -> AIResult:
    empty = {
        "skin_problem": [],
        "age": None,
        "consultation_format": None,
        "city": None,
        "experience": None,
        "consultation_confirmed": False,
        "consultation_date": None,
        "consultation_time": None,
        "name": None,
        "contacts": None,
    }
    if not settings.openai_api_key:
        return AIResult(content=empty, model=settings.openai_extractor_model, purpose="lead_extractor")
    started = perf_counter()
    response = _create_completion(
        model=settings.openai_extractor_model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": EXTRACTOR_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"dialogue": _clean_dialogue(dialogue), "contacts": contacts}, ensure_ascii=False)},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    return _result(
        content=empty | json.loads(response.choices[0].message.content or "{}"),
        model=settings.openai_extractor_model,
        purpose="lead_extractor",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_extractor,
        output_cost_per_1m=settings.openai_output_cost_extractor,
    )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def ai_edit_reply(original_reply: str, client_message: str, edit_prompt: str) -> AIResult:
    if not settings.openai_api_key:
        return AIResult(content=original_reply, model=settings.openai_model, purpose="ai_edit")
    started = perf_counter()
    system = (
        "Ты редактируешь готовый ответ менеджера по продажам. "
        "Получаешь оригинальный ответ и инструкцию по его изменению. "
        "Верни ТОЛЬКО исправленный текст ответа — без комментариев, без кавычек, без пояснений. "
        "Сохраняй стиль и тон оригинала. Отвечай на том же языке что и оригинал."
    )
    user = (
        f"Сообщение клиента:\n{strip_voice_marker(client_message)}\n\n"
        f"Оригинальный ответ:\n{original_reply}\n\n"
        f"Инструкция по изменению:\n{edit_prompt}"
    )
    response = _create_completion(
        model=settings.openai_model_sales,
        temperature=0.4,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    return _result(
        content=(response.choices[0].message.content or "").strip(),
        model=settings.openai_model_sales,
        purpose="ai_edit",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_sales,
        output_cost_per_1m=settings.openai_output_cost_sales,
    )


_LANGUAGE_ALIASES = {
    "ru": "русский",
    "rus": "русский",
    "russian": "русский",
    "рус": "русский",
    "русский": "русский",
    "ru-ru": "русский",
    "ky": "кыргызский",
    "kg": "кыргызский",
    "kyrgyz": "кыргызский",
    "kyrgyzstan": "кыргызский",
    "кыргыз": "кыргызский",
    "кыргызский": "кыргызский",
    "киргизский": "кыргызский",
    "киргиз": "кыргызский",
    "en": "английский",
    "eng": "английский",
    "english": "английский",
    "англ": "английский",
    "английский": "английский",
    "kz": "казахский",
    "kk": "казахский",
    "kazakh": "казахский",
    "казахский": "казахский",
    "uz": "узбекский",
    "uzbek": "узбекский",
    "узбекский": "узбекский",
    "tr": "турецкий",
    "turkish": "турецкий",
    "турецкий": "турецкий",
}


def normalize_target_language(language: str) -> str:
    cleaned = re.sub(r"\s+", " ", (language or "").strip().lower())
    cleaned = cleaned.strip(" .,!?:;\"'")
    return _LANGUAGE_ALIASES.get(cleaned, cleaned or "русский")


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def translate_reply(original_reply: str, client_message: str, target_language: str) -> AIResult:
    language = normalize_target_language(target_language)
    if not settings.openai_api_key:
        return AIResult(content=original_reply, model=settings.openai_model, purpose="translate_reply")
    started = perf_counter()
    system = (
        "Ты профессионально переводишь сообщения менеджера магазина косметики. "
        "Переведи ответ на целевой язык. Сохрани смысл, дружелюбный тон, обращения, числа, цены, "
        "названия брендов, ссылки, телефоны и переносы строк. Не добавляй новые обещания и факты. "
        "Верни ТОЛЬКО переведенный текст, без комментариев, кавычек и пояснений."
    )
    user = (
        f"Целевой язык: {language}\n\n"
        f"Сообщение клиента для контекста:\n{strip_voice_marker(client_message) or '-'}\n\n"
        f"Ответ для перевода:\n{original_reply}"
    )
    response = _create_completion(
        model=settings.openai_model_sales,
        temperature=0.1,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    return _result(
        content=(response.choices[0].message.content or "").strip(),
        model=settings.openai_model_sales,
        purpose="translate_reply",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_sales,
        output_cost_per_1m=settings.openai_output_cost_sales,
    )


def explain_reply(client_message: str, reply: str, conversation_summary: str | None = None) -> AIResult:
    """Explain briefly why the bot answered the way it did (for managers)."""
    if not settings.openai_api_key:
        return AIResult(content="", model=settings.openai_extractor_model, purpose="explain_reply")
    started = perf_counter()
    system = (
        "Ты — AI-ассистент Айым магазина косметики Demi Results, объясняющий менеджеру логику своего ответа. "
        "Тебе дают сообщение клиента и твой ответ. Объясни КРАТКО (2-4 строки, от первого лица) почему ты ответила именно так: "
        "какую цель преследовал ответ, почему задан этот вопрос или предложена консультация. "
        "Пиши просто и по делу, на русском. Без вступлений и заключений."
    )
    user = f"Сообщение клиента:\n{strip_voice_marker(client_message)}\n\nМой ответ:\n{reply}"
    if conversation_summary:
        user = f"Контекст диалога:\n{conversation_summary}\n\n{user}"
    response = _create_completion(
        model=settings.openai_extractor_model,
        temperature=0.3,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    return _result(
        content=(response.choices[0].message.content or "").strip(),
        model=settings.openai_extractor_model,
        purpose="explain_reply",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_extractor,
        output_cost_per_1m=settings.openai_output_cost_extractor,
    )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
def analyze_manager_corrections(examples: list[dict]) -> AIResult:
    """Group manager edits of bot drafts into common mistake patterns for the Laboratory analysis tool."""
    if not settings.openai_api_key:
        return AIResult(content={"categories": [], "suggested_prompt_changes": "", "expected_improvement": ""},
                         model=settings.openai_model_sales, purpose="mistake_analysis")
    started = perf_counter()
    system = (
        "Ты — аналитик качества AI-бота продаж. Тебе дают примеры диалогов, где менеджер исправил черновик "
        "бота перед отправкой клиенту: сообщение клиента (client_message), черновик бота (ai_reply) и то, что "
        "менеджер отправил в итоге (final_reply). Сравни ai_reply и final_reply в каждом примере, пойми ЧТО "
        "именно менеджер поменял и почему, и сгруппируй повторяющиеся типы ошибок бота в 3-6 категорий. "
        "Ответь строго JSON вида: "
        '{"categories": [{"label": "краткое название ошибки на русском", "count": число_примеров}], '
        '"suggested_prompt_changes": "конкретные формулировки для добавления в системный промпт бота", '
        '"expected_improvement": "честная экспертная оценка ожидаемого эффекта в свободной форме, '
        'явно как оценка, а не измеренная метрика"}'
    )
    response = _create_completion(
        model=settings.openai_model_sales,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"examples": [dict(e, client_message=strip_voice_marker(e.get('client_message', ''))) for e in examples]}, ensure_ascii=False)},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    data = json.loads(response.choices[0].message.content or "{}")
    data.setdefault("categories", [])
    data.setdefault("suggested_prompt_changes", "")
    data.setdefault("expected_improvement", "")
    return _result(
        content=data,
        model=settings.openai_model_sales,
        purpose="mistake_analysis",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_sales,
        output_cost_per_1m=settings.openai_output_cost_sales,
    )


def calibrate_prompt_from_single_reject(
    client_message: str, ai_reply: str, reason: str, current_prompt: str
) -> AIResult:
    """Propose one small, surgical system-prompt patch after a single manager reject.

    Used by "aggressive" bot mode, which calls this after EVERY reject and appends
    the result to the live prompt unattended — so the instruction below explicitly
    asks for a minimal, targeted addition rather than a rewrite, to avoid the
    prompt ballooning or drifting after a string of disagreements.
    """
    if not settings.openai_api_key:
        return AIResult(content={"prompt_patch": "", "reasoning": ""},
                         model=settings.openai_model_sales, purpose="reject_calibration")
    started = perf_counter()
    system = (
        "Ты — аналитик качества AI-бота продаж. Менеджер только что отклонил один черновик ответа бота "
        "клиенту и указал причину отказа. Тебе дают: сообщение клиента (client_message), черновик бота "
        "(ai_reply), причину отказа менеджера (reason) и текущий системный промпт бота (current_prompt). "
        "Предложи МАЛЕНЬКОЕ точечное дополнение или правку формулировки в промпте, которое предотвратит "
        "именно эту конкретную ошибку в будущем. Это НЕ полная переработка промпта — только небольшая "
        "точечная правка, максимум 1-2 предложения, добавляемая к промпту. Если причина слишком расплывчата "
        "или специфична только для этого случая, чтобы сформулировать общее правило, верни пустую строку. "
        "Ответь строго JSON вида: "
        '{"prompt_patch": "текст для добавления в промпт бота, или пустая строка", '
        '"reasoning": "краткое объяснение почему это должно помочь"}'
    )
    user = json.dumps(
        {
            "client_message": strip_voice_marker(client_message),
            "ai_reply": ai_reply,
            "reason": reason,
            "current_prompt": current_prompt,
        },
        ensure_ascii=False,
    )
    response = _create_completion(
        model=settings.openai_model_sales,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    latency_ms = int((perf_counter() - started) * 1000)
    data = json.loads(response.choices[0].message.content or "{}")
    data.setdefault("prompt_patch", "")
    data.setdefault("reasoning", "")
    return _result(
        content=data,
        model=settings.openai_model_sales,
        purpose="reject_calibration",
        usage=_usage_payload(response),
        latency_ms=latency_ms,
        input_cost_per_1m=settings.openai_input_cost_sales,
        output_cost_per_1m=settings.openai_output_cost_sales,
    )


def generate_purchase_template(dialogue: list[dict], client_message: str) -> tuple[str, AIResult | None]:
    """Draft a short reply lead-in for a 'wants to buy' card.

    The manager only fills in the concrete detail (price, availability, link),
    so the phrase must END with PURCHASE_PLACEHOLDER. Returns (template, usage);
    falls back to a bare placeholder on any failure.
    """
    if not settings.openai_api_key or not client_message.strip():
        return PURCHASE_PLACEHOLDER, None
    try:
        started = perf_counter()
        system = (
            "Ты — Айым, помощник косметолога Demi Results. Клиент хочет купить конкретный товар "
            "или спрашивает его цену/наличие. Точную информацию (цену, наличие, ссылку) впишет менеджер. "
            "Составь КОРОТКОЕ начало ответа клиенту: 1 предложение, тёплый тон, обращение на «Вы», "
            "на языке клиента, без приветствий. "
            f"Фраза должна ЗАКАНЧИВАТЬСЯ ровно на маркер {PURCHASE_PLACEHOLDER}. "
            f"Пример: «Цена нашей услуги очистки — {PURCHASE_PLACEHOLDER}». "
            f"Верни ТОЛЬКО текст с маркером {PURCHASE_PLACEHOLDER}, без кавычек и пояснений."
        )
        recent = _clean_dialogue(dialogue[-6:])
        user = json.dumps(
            {"dialogue": recent, "latest_message": strip_voice_marker(client_message)},
            ensure_ascii=False,
        )
        response = _create_completion(
            model=settings.openai_extractor_model,
            temperature=0.3,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        latency_ms = int((perf_counter() - started) * 1000)
        template = (response.choices[0].message.content or "").strip().strip('"').strip()
        if not template:
            template = PURCHASE_PLACEHOLDER
        elif PURCHASE_PLACEHOLDER not in template:
            template = f"{template} {PURCHASE_PLACEHOLDER}"
        usage = _result(
            content="",
            model=settings.openai_extractor_model,
            purpose="purchase_template",
            usage=_usage_payload(response),
            latency_ms=latency_ms,
            input_cost_per_1m=settings.openai_input_cost_extractor,
            output_cost_per_1m=settings.openai_output_cost_extractor,
        )
        return template, usage
    except Exception as exc:
        _log.warning("generate_purchase_template failed: %s", exc)
        return PURCHASE_PLACEHOLDER, None


def transcribe_voice(url: str) -> tuple[str, str]:
    """Download audio from URL and transcribe with Whisper. Returns (text, lang_code like 'ru'/'ky')."""
    from urllib.parse import urlsplit
    if not settings.openai_api_key:
        raise RuntimeError('Voice transcription provider is not configured')
    auth_headers: dict = {}
    host = (urlsplit(url).hostname or '').lower()
    if settings.amocrm_access_token and urlsplit(url).scheme == 'https' and (host == 'amocrm.ru' or host.endswith('.amocrm.ru')):
        auth_headers["Authorization"] = f"Bearer {settings.amocrm_access_token}"
    with httpx.Client(timeout=60, follow_redirects=True) as http:
        resp = http.get(url, headers=auth_headers)
        resp.raise_for_status()
        audio_bytes = resp.content
    filename = url.split("?")[0].rstrip("/").split("/")[-1] or "voice.ogg"
    if not any(filename.endswith(ext) for ext in (".mp3", ".mp4", ".ogg", ".wav", ".m4a", ".webm", ".mpeg", ".mpga")):
        filename = "voice.ogg"
    response = _client().audio.transcriptions.create(
        model="whisper-1",
        file=(filename, io.BytesIO(audio_bytes)),
        response_format="verbose_json",
        prompt="Кыргызча жана орусча сүйлөшүү. Кыргыз тилиндеги сөздөрдү так транскрипциялаңыз.",
    )
    text = (response.text or "").strip()
    lang = (getattr(response, "language", None) or "ru").lower()
    _lang_map = {"russian": "ru", "kyrgyz": "ky", "english": "en", "uzbek": "uz", "kazakh": "kk"}
    lang = _lang_map.get(lang, lang[:2])
    return text, lang


def transcribe_audio_bytes(audio_bytes: bytes, filename: str = "dictation.webm") -> str:
    """Transcribe a browser recording for CRM text dictation."""
    if not settings.openai_api_key:
        raise RuntimeError("OpenAI API key is not configured")
    audio = io.BytesIO(audio_bytes)
    audio.name = filename
    response = _client().audio.transcriptions.create(
        model="gpt-4o-mini-transcribe",
        file=audio,
        prompt=(
            "Диктовка сотрудника CRM Demi Results. Точно распознай русский или кыргызский текст, "
            "названия косметики, имена и номера телефонов. Верни только расшифровку."
        ),
    )
    return (response.text or "").strip()
