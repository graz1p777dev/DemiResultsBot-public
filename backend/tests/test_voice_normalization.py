"""Voice prompt regressions with fake settings and captured completions only."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest


VOICE_URL = "https://audio.invalid/first.ogg"
SECOND_URL = "https://audio.invalid/second.ogg"
PLAIN_LINK = "https://shop.invalid/catalog?item=42"
FAILURE = "[клиент отправил голосовое сообщение, распознать не удалось]"
TRANSCRIPT = "Кожа сухая, нужна консультация"
LONG_URL = "https://audio.invalid/" + "x" * 700 + ".ogg?token=fake"


@pytest.fixture
def service(monkeypatch):
    settings = SimpleNamespace(
        openai_api_key="fake-openai", deepseek_api_key="fake-deepseek",
        openai_model_simple="gpt-test", openai_model_sales="gpt-sales",
        openai_model="gpt-test", openai_extractor_model="gpt-extractor",
        openai_input_cost_extractor=0, openai_output_cost_extractor=0,
        openai_input_cost_sales=0, openai_output_cost_sales=0,
        openai_input_cost_simple=0, openai_output_cost_simple=0,
        deepseek_input_cost_per_1m=0, deepseek_output_cost_per_1m=0,
    )
    spec = importlib.util.spec_from_file_location(
        "voice_normalization_test_service",
        Path(__file__).parents[1] / "app/services/openai_service.py",
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict("sys.modules", {"app.core.config": SimpleNamespace(settings=settings)}):
        spec.loader.exec_module(module)

    def unexpected_client(*args, **kwargs):
        pytest.fail("Voice normalization tests must never construct a provider client")

    monkeypatch.setattr(module, "_client", unexpected_client)
    monkeypatch.setattr(module, "_deepseek_client", unexpected_client)
    monkeypatch.setattr(module, "_create_completion", Mock(return_value=SimpleNamespace(
        model="gpt-test",
        choices=[SimpleNamespace(message=SimpleNamespace(content="{}"))],
        usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    )))
    return module


@pytest.mark.parametrize("text,words", [
    (f"[voice] {VOICE_URL} {TRANSCRIPT}", [TRANSCRIPT]),
    (f"[клиент · 23.10 10:00] [voice] {VOICE_URL} {TRANSCRIPT}",
     ["[клиент · 23.10 10:00]", TRANSCRIPT]),
    (f"Здравствуйте [voice] {VOICE_URL} {TRANSCRIPT}", ["Здравствуйте", TRANSCRIPT]),
    (f"[voice] {VOICE_URL} Кожа сухая [voice] {SECOND_URL} Нужна консультация",
     ["Кожа сухая", "Нужна консультация"]),
    (f"[voice] {VOICE_URL} {TRANSCRIPT}\nСпасибо", [TRANSCRIPT, "Спасибо"]),
])
def test_strip_voice_marker_preserves_words_and_removes_every_audio_url(service, text, words):
    result = service.strip_voice_marker(text)
    assert "[voice]" not in result
    assert "audio.invalid" not in result
    for word in words:
        assert word in result


@pytest.mark.parametrize("text", [
    f"[voice] {VOICE_URL}",
    f"  [voice] {VOICE_URL}  \n",
    f"[клиент · 23.10 10:00] [voice] {VOICE_URL}",
    f"[voice] {VOICE_URL} [voice] {SECOND_URL}",
])
def test_strip_voice_marker_reports_missing_transcript(service, text):
    result = service.strip_voice_marker(text)
    assert FAILURE in result
    assert "[voice]" not in result
    assert "audio.invalid" not in result
    if "[клиент" in text:
        assert "[клиент · 23.10 10:00]" in result


@pytest.mark.parametrize("text", [
    "", "  Обычный текст\nс переносом  ", PLAIN_LINK,
    f"Посмотрите {PLAIN_LINK}",
    f"Ссылка на аудио без маркера: {VOICE_URL}",
    "[picture] https://images.invalid/photo.jpg",
])
def test_strip_voice_marker_preserves_nonvoice_content_exactly(service, text):
    assert service.strip_voice_marker(text) == text


UTILITIES = [
    "summarize_dialogue", "extract_fields", "detect_and_translate", "translate_reply",
    "explain_reply", "analyze_manager_corrections", "calibrate_prompt_from_single_reject",
]


def capture_utility_prompt(service, function, text):
    dialogue = [{"role": "user", "content": text},
                {"role": "assistant", "content": "Предыдущий ответ"}]
    examples = [{"client_message": text, "ai_reply": "Черновик", "final_reply": "Правка"}]
    original_dialogue, original_examples = copy.deepcopy(dialogue), copy.deepcopy(examples)
    args = {
        "summarize_dialogue": (dialogue,),
        "extract_fields": (dialogue, "Контакт"),
        "detect_and_translate": (text, "Ответ"),
        "translate_reply": ("Ответ", text, "ky"),
        "explain_reply": (text, "Ответ", "Контекст"),
        "analyze_manager_corrections": (examples,),
        "calibrate_prompt_from_single_reject": (text, "Ответ", "Причина", "Промпт"),
    }
    result = getattr(service, function)(*args[function])
    if function == "summarize_dialogue":
        assert result[1] is not None, "Summary must not silently fall back after a test error"
    service._create_completion.assert_called_once()
    assert dialogue == original_dialogue
    assert examples == original_examples
    messages = service._create_completion.call_args.kwargs["messages"]
    user_content = messages[-1]["content"]
    if function == "extract_fields":
        return json.loads(user_content)["dialogue"][0]["content"]
    if function == "analyze_manager_corrections":
        return json.loads(user_content)["examples"][0]["client_message"]
    if function == "calibrate_prompt_from_single_reject":
        return json.loads(user_content)["client_message"]
    return user_content


@pytest.mark.parametrize("function", UTILITIES)
@pytest.mark.parametrize("text,words", [
    pytest.param(f"[voice] {VOICE_URL} {TRANSCRIPT}", [TRANSCRIPT], id="leading"),
    pytest.param(f"[клиент · 23.10 10:00] [voice] {VOICE_URL} {TRANSCRIPT}",
                 ["[клиент · 23.10 10:00]", TRANSCRIPT], id="history-prefix"),
    pytest.param(f"Здравствуйте [voice] {VOICE_URL} Кожа сухая "
                 f"[voice] {SECOND_URL} Нужна консультация",
                 ["Здравствуйте", "Кожа сухая", "Нужна консультация"], id="embedded-repeated"),
    pytest.param(f"[voice] {LONG_URL} {TRANSCRIPT}", [TRANSCRIPT], id="strip-before-truncation"),
    pytest.param(f"[voice] {VOICE_URL}", [FAILURE], id="missing-transcript"),
    pytest.param(f"[клиент · 23.10 10:00] [voice] {VOICE_URL}",
                 ["[клиент · 23.10 10:00]", FAILURE], id="prefixed-missing-transcript"),
])
def test_utility_serializes_normalized_client_content(service, function, text, words):
    prompt = capture_utility_prompt(service, function, text)
    assert "[voice]" not in prompt
    assert "audio.invalid" not in prompt
    for word in words:
        assert word in prompt


@pytest.mark.parametrize("function", UTILITIES)
def test_utility_preserves_plain_text_and_nonvoice_links(service, function):
    text = f"Обычный вопрос клиента {PLAIN_LINK}"
    assert text in capture_utility_prompt(service, function, text)
