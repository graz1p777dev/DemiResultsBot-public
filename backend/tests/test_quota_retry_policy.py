import httpx2
import pytest
from openai import APIStatusError
from tenacity import wait_none
from test_ai_quota_fallback import service, clients, error


@pytest.mark.parametrize('code', ['credit_balance_exhausted', 'insufficient_quota'])
def test_real_sdk_does_not_retry_exhausted_credit(service, code):
    calls=[]
    def handle(request):
        calls.append(request)
        return httpx2.Response(429,json={'error':{'message':'quota','type':code,'code':code}})
    with service._QuotaAwareOpenAI(api_key='fake',http_client=httpx2.Client(transport=httpx2.MockTransport(handle))) as client:
        with pytest.raises(APIStatusError):
            client.chat.completions.create(model='fake',messages=[{'role':'user','content':'synthetic'}])
    assert len(calls)==1


@pytest.mark.parametrize('status,body', [(429,{'error':{'code':'rate_limit_exceeded'}}),(500,{'error':{'code':'server_error'}}),(429,{'error':'invalid'}),(429,[])])
def test_sdk_keeps_transient_error_retries(service,status,body):
    client=service._QuotaAwareOpenAI(api_key='fake')
    try:
        response=httpx2.Response(status,json=body,request=httpx2.Request('POST','https://example.invalid'))
        assert client._should_retry(response)
    finally:client.close()


def test_cooldown_skips_quota_calls_expires_and_resets_on_key_change(service,monkeypatch):
    clock=[100.0]
    monkeypatch.setattr(service,'monotonic',lambda:clock[0])
    primary,backup=clients(service,error())
    request={'model':'fake','messages':[{'role':'user','content':'synthetic'}]}
    for _ in range(5):service._create_completion(**request)
    assert primary.call_count==1 and backup.call_count==5
    clock[0]=401
    service._create_completion(**request)
    assert primary.call_count==2
    service.settings.openai_api_key='different-fake-key'
    service._create_completion(**request)
    assert primary.call_count==3


def test_cooldown_does_not_widen_fallback_to_media_or_opt_out(service):
    primary,backup=clients(service,error())
    service._create_completion(model='fake',messages=[{'role':'user','content':'synthetic'}])
    for kwargs in [
        {'messages':[{'role':'user','content':[{'type':'image_url','image_url':{'url':'https://example.invalid/a.png'}}]}]},
        {'messages':[{'role':'user','content':'synthetic'}],'_allow_quota_fallback':False},
    ]:
        with pytest.raises(APIStatusError):service._create_completion(model='fake',**kwargs)
    assert primary.call_count==3 and backup.call_count==1


def test_application_retry_does_not_repeat_quota_without_backup(service):
    service.settings.deepseek_api_key=''
    primary,backup=clients(service,error())
    function=service.extract_fields.retry_with(wait=wait_none())
    with pytest.raises(APIStatusError):function([{'role':'user','content':'synthetic'}],None)
    assert primary.call_count==1
    backup.assert_not_called()
