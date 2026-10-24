"""The public quality archive must distinguish failures and redact identifiers."""
import importlib.util
from pathlib import Path

import pytest

path = Path(__file__).resolve().parents[2] / 'scripts' / 'eval_prompt_quality.py'
spec = importlib.util.spec_from_file_location('quality_eval', path)
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


def test_empty_reply_is_allowed_only_for_explicit_silence():
    assert quality.evaluate_rules('', {'exact': ''}) == []
    assert 'empty_reply' in quality.evaluate_rules('', {})


def test_rules_detect_fabricated_price_and_unsolicited_questions():
    assert 'invented_price' in quality.evaluate_rules('Цена 999 сом', {'no_price': True})
    assert 'too_many_questions' in quality.evaluate_rules('Почему?', {'max_questions': 0})
    assert quality.evaluate_rules('Уточню цену у менеджера.', {'no_price': True}) == []


def test_redaction_walks_nested_transcript_without_changing_reply_language():
    output = quality.redact({'results': [{'reply': 'Макул, жазыңыз. https://media.example.test/private +123456789012'}]})
    reply = output['results'][0]['reply']
    assert reply == 'Макул, жазыңыз. [ссылка скрыта] [номер скрыт]'


@pytest.mark.parametrize('text', ['sk-proj-test', 'Bearer synthetic', '-----BEGIN FAKE PRIVATE KEY'])
def test_credential_like_output_blocks_archive(text):
    with pytest.raises(ValueError):
        quality.redact({'reply': text})
