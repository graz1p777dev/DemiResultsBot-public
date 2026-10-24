"""Reply-bound edit proposals. No customer send happens while preparing a preview."""
import json
import secrets
from datetime import datetime, timezone

import httpx
from sqlalchemy import delete, or_, select

from app.core.config import settings
from app.models.entities import ApprovalRequest, Lead, Setting
from app.services import telegram
from app.services.openai_service import ai_edit_reply, transcribe_audio_bytes


def _now():
    return datetime.now(timezone.utc).timestamp()


def _put(db, key, value):
    db.add(Setting(key=key, value=json.dumps({**value, 'expires_at': _now()+1800}), is_secret=False))
    db.commit()


def _get(db, key, actor, chat):
    row = db.scalar(select(Setting).where(Setting.key == key))
    if not row:
        return None
    data = json.loads(row.value)
    if data.get('actor') != actor or data.get('chat') != chat or data.get('expires_at', 0) < _now():
        return None
    return data


def prompt_edit(db, approval, actor, chat, message_id):
    if not approval or approval.status not in {'pending', 'edited'}:
        return False
    result = telegram.send_text(chat,
        '✏️ Ответьте на это сообщение готовым текстом. Голосом можно объяснить, '
        'как изменить ответ. Затем появится предпросмотр для подтверждения.',
        reply_markup={'force_reply': True, 'selective': True}, reply_to_message_id=message_id)
    prompt_id = (result.get('result') or {}).get('message_id')
    if prompt_id:
        _put(db, f'telegram_edit_prompt:{chat}:{prompt_id}',
             {'approval_id': approval.id, 'actor': actor, 'chat': chat, 'original_id': message_id})
    return bool(prompt_id)


def _target(db, message, actor, chat):
    replied = message.get('reply_to_message') or {}
    mid = replied.get('message_id')
    if not mid:
        return None
    prompt = _get(db, f'telegram_edit_prompt:{chat}:{mid}', actor, chat)
    if prompt:
        return prompt
    for row in (replied.get('reply_markup') or {}).get('inline_keyboard', []):
        for button in row:
            action, _, raw_id = button.get('callback_data', '').partition(':')
            if action not in {'approve', 'edit', 'reject', 'pedit'} or not raw_id.isdigit():
                continue
            approval = db.get(ApprovalRequest, int(raw_id))
            if approval and (chat, str(mid)) in telegram._parse_message_ids(approval.telegram_message_id):
                return {'approval_id': approval.id, 'original_id': mid}
    # Telegram can omit the original inline keyboard in reply_to_message.
    # Resolve the stored message pair too; never infer an approval from its text.
    compact = json.dumps({chat: str(mid)}, separators=(',', ':'))[1:-1]
    spaced = json.dumps({chat: str(mid)})[1:-1]
    candidates = db.scalars(select(ApprovalRequest).where(
        ApprovalRequest.status.in_(['pending', 'edited']),
        or_(ApprovalRequest.telegram_message_id == str(mid),
            ApprovalRequest.telegram_message_id.contains(compact),
            ApprovalRequest.telegram_message_id.contains(spaced)),
    ).limit(10)).all()
    for approval in candidates:
        if (chat, str(mid)) in telegram._parse_message_ids(approval.telegram_message_id):
            return {'approval_id': approval.id, 'original_id': mid}
    return None


def _voice_text(voice):
    if voice.get('file_size', 0) > 20*1024*1024:
        raise ValueError('Telegram voice exceeds download limit')
    with httpx.Client(timeout=60) as client:
        response = client.post(telegram._api_url('getFile'), json={'file_id': voice['file_id']})
        response.raise_for_status()
        data = response.json()
        path = (data.get('result') or {}).get('file_path')
        if not data.get('ok') or not path or '..' in path.split('/'):
            raise ValueError('Telegram audio is unavailable')
        chunks, size = [], 0
        with client.stream('GET', f'https://api.telegram.org/file/bot{settings.telegram_bot_token}/{path}') as audio:
            audio.raise_for_status()
            for chunk in audio.iter_bytes():
                size += len(chunk)
                if size > 20*1024*1024:
                    raise ValueError('Telegram voice exceeds download limit')
                chunks.append(chunk)
    filename = path.rsplit('/', 1)[-1]
    if filename.endswith('.oga'):
        filename = filename[:-4] + '.ogg'
    return transcribe_audio_bytes(b''.join(chunks), filename)


def _link(chat, mid):
    if chat.startswith('-100'):
        return f'https://t.me/c/{chat[4:]}/{mid}'
    # Private message jump support depends on the Telegram client; the preview
    # also replies to the instruction, so its built-in reply always remains.
    peer = settings.telegram_bot_token.split(':', 1)[0]
    if not peer.isdigit():
        peer = chat
    return f'tg://openmessage?user_id={peer}&message_id={mid}'


def prepare_reply(db, message, actor, chat):
    target = _target(db, message, actor, chat)
    if not target:
        return None
    approval = db.get(ApprovalRequest, target['approval_id'])
    if not approval or approval.status not in {'pending', 'edited'}:
        telegram.send_text(chat, 'Этот ответ уже обработан. Откройте актуальную карточку.')
        return {'ok': False, 'error': 'approval_not_editable'}
    voice = message.get('voice') or message.get('audio')
    text = (message.get('text') or '').strip()
    if not voice and not text:
        return {'ok': True, 'action': 'ignored_non_text'}
    snapshot, original = approval.edited_reply, approval.ai_reply
    if voice:
        instruction = _voice_text(voice)
        if not instruction.strip():
            raise ValueError('Empty voice instruction')
        result = ai_edit_reply(snapshot or original or '', approval.client_message, instruction)
        from app.tasks.pipeline import save_ai_usage
        save_ai_usage(db, approval.lead_id, result)
        text = str(result.content).strip()
    if not text or len(text) > 12000:
        raise ValueError('Empty or oversized edit')
    token = secrets.token_hex(12)
    data = {'approval_id': approval.id, 'actor': actor, 'chat': chat,
            'snapshot': snapshot, 'original': original, 'text': text}
    _put(db, f'telegram_edit_proposal:{token}', data)
    links = 'Исходный ответ: '+_link(chat, target['original_id'])
    if voice:
        links += '\nГолосовая инструкция: '+_link(chat, message['message_id'])
    parts = [text[i:i+1600] for i in range(0, len(text), 1600)]
    for index, part in enumerate(parts):
        last = index == len(parts)-1
        keyboard = {'inline_keyboard': [[
            {'text':'✅ Принять и отправить','callback_data':f'edit_accept:{token}'},
            {'text':'❌ Отклонить правку','callback_data':f'edit_discard:{token}'}]]} if last else None
        telegram.send_text(chat, '✏️ Изменённый ответ:\n'+part+('\n\n'+links if last else ''),
            reply_markup=keyboard, reply_to_message_id=message['message_id'])
    return {'ok': True, 'action': 'edit_preview'}


def create_proposal(db, approval, actor, chat, reply, prompt=None):
    """CRM uses the same non-mutating preview and snapshot as Telegram."""
    if not approval or approval.status not in {'pending', 'edited'}:
        raise ValueError('Approval is no longer editable')
    snapshot, original = approval.edited_reply, approval.ai_reply
    if prompt:
        result = ai_edit_reply(reply, approval.client_message, prompt)
        from app.tasks.pipeline import save_ai_usage
        save_ai_usage(db, approval.lead_id, result)
        reply = str(result.content).strip()
    if not reply or len(reply) > 10000:
        raise ValueError('Empty or oversized edit')
    token = secrets.token_hex(12)
    _put(db, f'telegram_edit_proposal:{token}', {'approval_id': approval.id,
        'actor': actor, 'chat': chat, 'snapshot': snapshot, 'original': original, 'text': reply})
    return token, reply


def confirm(db, token, actor, chat, accept, approval_id=None):
    key = f'telegram_edit_proposal:{token}'
    data = _get(db, key, actor, chat)
    if not data or (approval_id is not None and data['approval_id'] != approval_id):
        return False
    # Atomic consumption: repeated callback/update must never resend.
    consumed = db.execute(delete(Setting).where(Setting.key == key).returning(Setting.id)).first()
    db.commit()
    if not consumed:
        return False
    if not accept:
        return True
    approval = db.get(ApprovalRequest, data['approval_id'])
    if not approval or approval.status not in {'pending', 'edited'} or approval.ai_reply != data['original']:
        return False
    from app.tasks.pipeline import apply_edited_reply, approve_request
    approval = apply_edited_reply(db, approval.id, actor, data['text'],
        expected_reply=data['snapshot'], check_snapshot=True, expected_ai_reply=data['original'])
    if not approval:
        return False
    return approve_request(db, approval.id, actor, expected_reply=data['text'], check_snapshot=True)
