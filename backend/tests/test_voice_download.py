from types import SimpleNamespace as NS
from unittest.mock import Mock
import pytest
from app.services import openai_service as service


@pytest.mark.parametrize('url,authenticated', [
    ('https://do-media-7107.fra1.digitaloceanspaces.com/voice.oga', False),
    ('https://demicosmetics1.amocrm.ru/voice.oga', True),
    ('https://amocrm.ru.evil.invalid/voice.oga', False),
    ('http://demicosmetics1.amocrm.ru/voice.oga', False),
])
def test_audio_download_credentials_scoped_to_provider(monkeypatch, url, authenticated):
    monkeypatch.setattr(service.settings, 'openai_api_key', 'fake')
    monkeypatch.setattr(service.settings, 'amocrm_access_token', 'fake-amo-secret')
    http = NS(get=Mock(return_value=NS(content=b'audio', raise_for_status=Mock())))
    context = Mock(__enter__=Mock(return_value=http), __exit__=Mock(return_value=None))
    monkeypatch.setattr(service.httpx, 'Client', Mock(return_value=context))
    create = Mock(return_value=NS(text='  Текст голоса ',language='russian'))
    monkeypatch.setattr(service, '_client', lambda: NS(audio=NS(transcriptions=NS(create=create))))
    assert service.transcribe_voice(url) == ('Текст голоса','ru')
    assert bool(http.get.call_args.kwargs['headers']) is authenticated
    assert create.call_args.kwargs['file'][0] == 'voice.ogg'


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
