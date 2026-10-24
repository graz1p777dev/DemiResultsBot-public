from types import SimpleNamespace as NS
from unittest.mock import Mock
import pytest
from app.services import openai_service as service


@pytest.fixture
def asr(monkeypatch):
    # Replace all settings used by this path, independent of local environment.
    monkeypatch.setattr(service, 'settings', NS(openai_api_key='fake-text-key',
        openai_asr_api_key='fake-asr-key', openai_asr_model='gpt-transcribe',
        amocrm_access_token='fake-amo-secret'))
    create = Mock(return_value=NS(text='  Кыргызча жооп  ', languages=[]))
    client = NS(audio=NS(transcriptions=NS(create=create)))
    pool = Mock(return_value=client)
    text_client = Mock(side_effect=AssertionError('ASR must use the dedicated client'))
    monkeypatch.setattr(service, '_pooled_client', pool)
    monkeypatch.setattr(service, '_client', text_client)
    return NS(create=create, pool=pool, text_client=text_client)


def test_asr_dedicated_key_new_model_json_and_no_forced_language(asr):
    assert service.transcribe_audio_bytes(b'voice', 'recording.webm') == 'Кыргызча жооп'
    asr.pool.assert_called_once_with('asr', 'fake-asr-key')
    asr.text_client.assert_not_called()
    args = asr.create.call_args.kwargs
    assert args['model'] == 'gpt-transcribe'
    assert args['response_format'] == 'json'
    assert args['file'].name == 'recording.webm' and args['file'].getvalue() == b'voice'
    assert 'language' not in args and 'languages' not in args
    assert 'без перевода и дополнений' in args['prompt']


@pytest.mark.parametrize('languages,expected', [
    ([], ''), ([{'code': 'ky'}], 'ky'), ([NS(code='ru')], 'ru'), ([{}], ''),
])
def test_asr_reports_only_provider_language_never_invents_one(asr, languages, expected):
    asr.create.return_value = NS(text=' Распознанная речь ', languages=languages, language='russian')
    assert service._transcribe_recording(b'audio', 'voice.ogg') == ('Распознанная речь', expected)


def test_asr_accepts_provider_without_any_language_metadata(asr):
    asr.create.return_value = NS(text=' Саламатсызбы ')
    assert service._transcribe_recording(b'audio', 'voice.ogg') == ('Саламатсызбы', '')


@pytest.mark.parametrize('text', [None, '', '   '])
def test_asr_does_not_fabricate_text_for_an_empty_result(asr, text):
    asr.create.return_value = NS(text=text, languages=[])
    assert service._transcribe_recording(b'audio', 'voice.ogg') == ('', '')


def test_asr_configured_model_is_honored(asr, monkeypatch):
    monkeypatch.setattr(service.settings, 'openai_asr_model', 'synthetic-asr-model')
    service.transcribe_audio_bytes(b'audio')
    assert asr.create.call_args.kwargs['model'] == 'synthetic-asr-model'


def test_asr_key_works_without_a_text_model_key(asr, monkeypatch):
    monkeypatch.setattr(service.settings, 'openai_api_key', '')
    assert service.transcribe_audio_bytes(b'audio') == 'Кыргызча жооп'
    asr.pool.assert_called_once_with('asr', 'fake-asr-key')


def test_asr_legacy_key_fallback_uses_same_contract(asr, monkeypatch):
    monkeypatch.setattr(service.settings, 'openai_asr_api_key', '')
    asr.text_client.side_effect = None
    asr.text_client.return_value = asr.pool.return_value
    assert service.transcribe_audio_bytes(b'audio') == 'Кыргызча жооп'
    asr.pool.assert_not_called()
    asr.text_client.assert_called_once_with()
    assert asr.create.call_args.kwargs['model'] == 'gpt-transcribe'


def test_asr_missing_keys_fails_before_provider_call(asr, monkeypatch):
    monkeypatch.setattr(service.settings, 'openai_api_key', '')
    monkeypatch.setattr(service.settings, 'openai_asr_api_key', '')
    with pytest.raises(RuntimeError, match='key is not configured'):
        service.transcribe_audio_bytes(b'audio')
    asr.pool.assert_not_called()
    asr.create.assert_not_called()


@pytest.mark.parametrize('audio', [b'', b'x' * (25 * 1024 * 1024 + 1)])
def test_asr_rejects_empty_or_oversized_audio_before_provider_call(asr, audio):
    with pytest.raises(ValueError, match='Audio must contain'):
        service.transcribe_audio_bytes(audio)
    asr.pool.assert_not_called()
    asr.create.assert_not_called()


def test_asr_error_propagates_without_fabricated_text_or_fallback(asr):
    asr.create.side_effect = RuntimeError('synthetic recognition failure')
    with pytest.raises(RuntimeError, match='synthetic recognition failure'):
        service.transcribe_audio_bytes(b'audio')
    asr.create.assert_called_once()
    asr.text_client.assert_not_called()


@pytest.mark.parametrize('url,authenticated', [
    ('https://do-media-7107.fra1.digitaloceanspaces.com/voice.oga', False),
    ('https://demicosmetics1.amocrm.ru/voice.oga', True),
    ('https://amocrm.ru.evil.invalid/voice.oga', False),
    ('http://demicosmetics1.amocrm.ru/voice.oga', False),
])
def test_audio_download_credentials_scoped_to_provider(monkeypatch, url, authenticated):
    monkeypatch.setattr(service.settings, 'openai_api_key', 'fake')
    monkeypatch.setattr(service.settings, 'openai_asr_api_key', '')
    monkeypatch.setattr(service.settings, 'openai_asr_model', 'gpt-transcribe')
    monkeypatch.setattr(service.settings, 'amocrm_access_token', 'fake-amo-secret')
    http = NS(get=Mock(return_value=NS(content=b'audio', raise_for_status=Mock())))
    context = Mock(__enter__=Mock(return_value=http), __exit__=Mock(return_value=None))
    monkeypatch.setattr(service.httpx, 'Client', Mock(return_value=context))
    create = Mock(return_value=NS(text='  Текст голоса ', languages=[{'code': 'ru'}]))
    monkeypatch.setattr(service, '_client', lambda: NS(audio=NS(transcriptions=NS(create=create))))
    assert service.transcribe_voice(url) == ('Текст голоса','ru')
    assert http.get.call_args.kwargs['headers'] == ({'Authorization': 'Bearer fake-amo-secret'} if authenticated else {})
    assert create.call_args.kwargs['file'].name == 'voice.ogg'
    assert create.call_args.kwargs['file'].getvalue() == b'audio'
    assert create.call_args.kwargs['model'] == 'gpt-transcribe'
    assert create.call_args.kwargs['response_format'] == 'json'
    assert 'language' not in create.call_args.kwargs


def test_missing_transcript_never_generates_a_customer_reply(monkeypatch):
    completion=Mock()
    monkeypatch.setattr(service, '_create_completion', completion)
    with pytest.raises(RuntimeError, match='manager must listen'):
        service.generate_reply.__wrapped__([{'role':'user','content':'[voice] https://audio.invalid/a.ogg'}],{})
    completion.assert_not_called()


def test_buffered_typed_greeting_cannot_hide_an_untranscribed_voice(monkeypatch):
    completion=Mock()
    monkeypatch.setattr(service, '_create_completion', completion)
    with pytest.raises(RuntimeError,match='manager must listen'):
        service.generate_reply.__wrapped__([
            {'role':'user','content':'[voice] https://audio.invalid/a.ogg'},
            {'role':'user','content':'Здравствуйте'},
            {'role':'user','content':'[voice] https://audio.invalid/a.ogg Здравствуйте'},
        ],{})
    completion.assert_not_called()


def test_multiline_transcript_is_not_a_recognition_failure():
    result=service.strip_voice_marker('[voice] https://audio.invalid/a.ogg\nКожа сухая')
    assert result=='Кожа сухая'
