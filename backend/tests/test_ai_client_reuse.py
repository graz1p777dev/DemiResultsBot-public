from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from test_ai_quota_fallback import service


@pytest.mark.parametrize('factory_name', ['_client', '_deepseek_client'])
def test_reuses_client_in_same_process_and_thread(service, monkeypatch, factory_name):
    factory = Mock(side_effect=lambda **kwargs: Mock(is_closed=lambda: False))
    monkeypatch.setattr(service, '_QuotaAwareOpenAI', factory)
    monkeypatch.setattr(service, 'OpenAI', factory)
    get_client = getattr(service, factory_name)
    first = get_client()
    assert all(get_client() is first for _ in range(10))
    assert factory.call_count == 1


@pytest.mark.parametrize('factory_name,key_name', [('_client','openai_api_key'), ('_deepseek_client','deepseek_api_key')])
def test_key_rotation_closes_previous_client(service, monkeypatch, factory_name, key_name):
    factory = Mock(side_effect=lambda **kwargs: Mock(is_closed=lambda: False))
    monkeypatch.setattr(service, '_QuotaAwareOpenAI', factory)
    monkeypatch.setattr(service, 'OpenAI', factory)
    get_client = getattr(service, factory_name)
    previous = get_client()
    setattr(service.settings, key_name, 'rotated-fake-key')
    assert get_client() is not previous
    previous.close.assert_called_once()
    assert factory.call_args.kwargs['api_key'] == 'rotated-fake-key'


def test_clients_are_not_shared_across_threads_or_fork(service, monkeypatch):
    factory = Mock(side_effect=lambda **kwargs: Mock(is_closed=lambda: False))
    monkeypatch.setattr(service, '_QuotaAwareOpenAI', factory)
    monkeypatch.setattr(service.os, 'getpid', lambda: 100)
    parent = service._client()
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(service._client).result() is not parent
    monkeypatch.setattr(service.os, 'getpid', lambda: 101)
    assert service._client() is not parent
    parent.close.assert_not_called()


def test_closed_client_is_replaced(service, monkeypatch):
    factory = Mock(side_effect=lambda **kwargs: Mock(is_closed=Mock(return_value=False)))
    monkeypatch.setattr(service, '_QuotaAwareOpenAI', factory)
    previous = service._client()
    previous.is_closed.return_value = True
    assert service._client() is not previous
