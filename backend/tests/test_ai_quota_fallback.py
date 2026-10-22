"""Offline quota fallback checks; import with fake settings, never load env files."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import pytest
from openai import APIStatusError, BadRequestError
from tenacity import RetryError, stop_after_attempt, wait_none


@pytest.fixture
def service():
    settings = SimpleNamespace(
        openai_api_key="fake-openai", deepseek_api_key="fake-deepseek",
        openai_model_simple="gpt-test", openai_model_sales="gpt-sales",
        openai_model="gpt-test", openai_extractor_model="gpt-extractor",
        openai_input_cost_extractor=100, openai_output_cost_extractor=200,
        openai_input_cost_sales=100, openai_output_cost_sales=200,
        openai_input_cost_simple=100, openai_output_cost_simple=200,
        deepseek_input_cost_per_1m=0.07, deepseek_output_cost_per_1m=1.10,
    )
    spec = importlib.util.spec_from_file_location(
        "quota_service_test", Path(__file__).parents[1] / "app/services/openai_service.py",
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict("sys.modules", {"app.core.config": SimpleNamespace(settings=settings)}):
        spec.loader.exec_module(module)
    return module


def error(status=429, code="credit_balance_exhausted", cls=APIStatusError):
    return cls("mock provider failure", response=httpx.Response(
        status, request=httpx.Request("POST", "https://provider.invalid/completions"),
    ), body={"code": code})


def response(content='{"reply":"Ответ", "reasoning":"Контекст учтён"}'):
    return SimpleNamespace(
        model="deepseek-flash", choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
        usage={"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},
    )


def clients(service, failures, result=None):
    primary, backup = Mock(), Mock()
    primary.chat.completions.create.side_effect = failures
    backup.chat.completions.create.return_value = result or response()
    service._client = Mock(return_value=primary)
    service._deepseek_client = Mock(return_value=backup)
    return primary.chat.completions.create, backup.chat.completions.create


@pytest.mark.parametrize("code", ["credit_balance_exhausted", "insufficient_quota"])
def test_quota_preserves_full_messages_json_and_actual_costs(service, code):
    primary, backup = clients(service, error(code=code))
    result = service.generate_reply(
        [{"role": "user", "content": "Вопрос клиента"}], {"city": "Бишкек"},
        system_prompt="Полный системный промпт", memory_context="Память магазина",
    )
    original = primary.call_args.kwargs
    fallback = backup.call_args.kwargs
    assert fallback["messages"] == original["messages"]
    assert "Полный системный промпт" in fallback["messages"][0]["content"]
    assert "Память магазина" in fallback["messages"][0]["content"]
    assert fallback["response_format"] == {"type": "json_object"}
    assert fallback["model"] == "deepseek-flash"
    assert fallback["extra_body"] == {"thinking": {"type": "disabled"}}
    assert result.content == "Ответ" and result.reasoning == "Контекст учтён"
    assert result.model == "deepseek-flash" and result.provider == "deepseek"
    assert result.input_cost == 0.00007 and result.output_cost == 0.00011
    assert result.total_cost == 0.00018 and result.total_tokens == 1100
    assert result.raw_usage["provider"] == "deepseek"
    assert result.raw_usage["pricing_basis"] == "configured_estimate"
    assert primary.call_count == backup.call_count == 1


@pytest.mark.parametrize("status,code", [(400, "invalid_request"), (401, "invalid_api_key"),
                                        (429, "rate_limit_exceeded"), (500, "credit_balance_exhausted")])
def test_non_quota_errors_never_fallback(service, status, code):
    failure = error(status, code)
    _, backup = clients(service, failure)
    with pytest.raises(APIStatusError) as caught:
        service._create_completion(model="gpt-test", messages=[{"role": "user", "content": "hi"}])
    assert caught.value is failure
    backup.assert_not_called()


def test_temperature_retry_can_expose_quota(service):
    temperature_error = error(400, "temperature", BadRequestError)
    temperature_error.args = ("temperature not supported",)
    primary, backup = clients(service, [temperature_error, error()])
    service._create_completion(model="gpt-test", temperature=0.5,
                               messages=[{"role": "user", "content": "hi"}])
    assert primary.call_count == 2 and backup.call_count == 1
    assert "temperature" not in backup.call_args.kwargs


@pytest.mark.parametrize("images", [[], ["data:image/png;base64,AA=="]])
def test_image_reply_quota_never_uses_text_backup(service, images):
    _, backup = clients(service, error())
    service._download_images_as_data_urls = Mock(return_value=images)
    with pytest.raises(APIStatusError):
        service.generate_reply.__wrapped__([{"role": "user", "content": "[picture] https://image.invalid/a"}], {})
    backup.assert_not_called()


@pytest.mark.parametrize("content", ["", "not-json", "[]", "{}", '{"reply":""}'])
def test_invalid_backup_reaches_existing_retry_error_for_manual_path(service, content):
    _, backup = clients(service, error(), response(content))
    generate = service.generate_reply.retry_with(stop=stop_after_attempt(2), wait=wait_none())
    with pytest.raises(RetryError):
        generate([{"role": "user", "content": "вопрос"}], {})
    assert backup.call_count == 2


def test_backup_failure_and_missing_key_propagate(service):
    _, backup = clients(service, error())
    backup.side_effect = RuntimeError("mock unavailable")
    generate = service.generate_reply.retry_with(stop=stop_after_attempt(1), wait=wait_none())
    with pytest.raises(RetryError) as caught:
        generate([{"role": "user", "content": "вопрос"}], {})
    assert isinstance(caught.value.last_attempt.exception(), RuntimeError)
    service.settings.deepseek_api_key = ""
    backup.reset_mock()
    with pytest.raises(APIStatusError):
        service._create_completion(model="gpt-test", messages=[{"role": "user", "content": "hi"}])
    backup.assert_not_called()


def test_response_model_is_preserved_even_for_versioned_provider_name(service):
    actual = response()
    actual.model = "DeepSeek-V4.1-Flash-1017"
    clients(service, error(), actual)
    result = service.generate_reply([{"role": "user", "content": "вопрос"}], {})
    assert result.model == actual.model
    assert result.provider == "deepseek" and result.total_cost == 0.00018


def test_successful_openai_call_never_uses_backup(service):
    primary, backup = clients(service, None)
    actual = response()
    actual.model = "gpt-test"
    primary.return_value = actual
    result = service.generate_reply([{"role": "user", "content": "вопрос"}], {})
    assert result.model == "gpt-test" and result.provider == "openai"
    assert result.input_cost == 0.1 and result.output_cost == 0.02
    backup.assert_not_called()


@pytest.mark.parametrize("function", ["extract_fields", "summarize_dialogue", "translate_reply"])
def test_full_utility_functions_preserve_context_and_metadata(service, function):
    actual = response('{"name":"Тест"}' if function == "extract_fields" else "Полный ответ")
    primary, backup = clients(service, error(), actual)
    dialogue = [{"role": "user", "content": "Уникальный вопрос клиента"},
                {"role": "assistant", "content": "Предыдущий ответ"}]
    if function == "extract_fields":
        result = service.extract_fields(dialogue, "Контакт клиента")
        assert result.content["name"] == "Тест"
    elif function == "summarize_dialogue":
        summary, result = service.summarize_dialogue(dialogue)
        assert summary == "Полный ответ"
    else:
        result = service.translate_reply("Полный исходный ответ", "Уникальный вопрос клиента", "ky")
        assert result.content == "Полный ответ"
    assert backup.call_args.kwargs["messages"] == primary.call_args.kwargs["messages"]
    assert "Уникальный вопрос клиента" in backup.call_args.kwargs["messages"][1]["content"]
    assert result.model == "deepseek-flash" and result.provider == "deepseek"
    assert result.total_cost == 0.00018


def test_token_limit_translation_preserves_messages(service):
    _, backup = clients(service, error())
    messages = [{"role": "system", "content": "Full system"}, {"role": "user", "content": "Full user"}]
    service._create_completion(model="gpt-test", messages=messages, max_completion_tokens=256)
    assert backup.call_args.kwargs["max_tokens"] == 256
    assert "max_completion_tokens" not in backup.call_args.kwargs
    assert backup.call_args.kwargs["messages"] == messages


@pytest.mark.parametrize("options", [
    {"tools": []}, {"response_format": {"type": "json_schema", "json_schema": {}}},
    {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "mock"}}]}]},
])
def test_unsupported_requests_never_use_backup(service, options):
    _, backup = clients(service, error())
    with pytest.raises(APIStatusError):
        service._create_completion(**{"model": "gpt-test", "messages": [{"role": "user", "content": "Full text"}], **options})
    backup.assert_not_called()


def test_reply_check_receives_current_facts_above_stale_history(service):
    history = [{"role": "assistant", "content": "Магазин работает с 09:00 до 21:00."},
               {"role": "user", "content": "Когда можно прийти?"}]
    instructions = "Магазин работает с 10:00 до 21:00.\nПАМЯТЬ МАГАЗИНА: самовывоз доступен."
    fixed = "Магазин работает с 10:00 до 21:00."
    service._create_completion = Mock(return_value=response(json.dumps({"ok": False, "fixed_reply": fixed})))
    result, usage = service.verify_reply(history, history[0]["content"], business_instructions=instructions)
    messages = service._create_completion.call_args.kwargs["messages"]
    assert instructions in messages[0]["content"]
    assert "Они имеют приоритет над историей диалога" in messages[0]["content"]
    assert "не придумывай факты" in messages[0]["content"]
    payload = json.loads(messages[1]["content"])
    assert payload["dialogue"] == history
    assert payload["draft_reply"] == history[0]["content"]
    assert result == fixed and usage.purpose == "reply_check"
    assert "09:00" not in messages[0]["content"]


def test_reply_check_two_argument_call_remains_compatible(service):
    service._create_completion = Mock(return_value=response('{"ok":true,"fixed_reply":null}'))
    reply, _ = service.verify_reply([], "Исходный ответ")
    assert reply == "Исходный ответ"
    assert service._create_completion.call_args.kwargs["messages"][0]["content"] == service.REPLY_CHECK_SYSTEM_PROMPT


def test_generation_prioritizes_current_instructions_without_rewriting_facts(service):
    primary, _ = clients(service, None)
    primary.return_value = response()
    history = [{"role": "assistant", "content": "Раньше отвечала: 09:00–21:00"},
               {"role": "user", "content": "Когда открываетесь?"}]
    service.generate_reply(history, {}, system_prompt="Часы работы: 10:00–21:00", memory_context="Самовывоз доступен")
    messages = primary.call_args.kwargs["messages"]
    assert "Часы работы: 10:00–21:00" in messages[0]["content"]
    assert "Самовывоз доступен" in messages[0]["content"]
    assert "имеют приоритет над историей диалога" in messages[0]["content"]
    assert "не придумывай отсутствующие в них факты" in messages[0]["content"]
    assert "09:00" not in messages[0]["content"]
    assert "09:00–21:00" in messages[1]["content"]
