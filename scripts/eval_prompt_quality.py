"""Opt-in live AI quality checks. Reads trusted settings, never calls customer transports.

Run only in an authorized runtime with --allow-live-ai; output contains synthetic
dialogs and prompt digests, never the private prompt, memory, keys or DB history.
"""
import argparse
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter


def evaluate_rules(reply, rules):
    failures = []
    if not reply.strip() and rules.get('exact') != '':
        failures.append('empty_reply')
    if 'exact' in rules and reply != rules['exact']:
        failures.append('exact')
    if reply.count('?') > rules.get('max_questions', 2):
        failures.append('too_many_questions')
    if len(reply) > 1100:
        failures.append('too_long')
    for phrase in rules.get('not_contains', []):
        if phrase.casefold() in reply.casefold():
            failures.append('forbidden_phrase:' + phrase)
    if rules.get('contains_any') and not any(p.casefold() in reply.casefold() for p in rules['contains_any']):
        failures.append('missing_expected_content')
    if rules.get('no_price') and re.search(r'\d[\d ]*\s*(?:сом|руб)', reply, re.I):
        failures.append('invented_price')
    if rules.get('no_dosage') and re.search(r'\d+\s*(?:мг|mg)\b', reply, re.I):
        failures.append('medication_dosage')
    return failures


def redact(value):
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r'https?://\S+', '[ссылка скрыта]', value)
        value = re.sub(r'(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)', '[номер скрыт]', value)
        if re.search(r'sk-proj-|Bearer |-----BEGIN .*PRIVATE KEY', value):
            raise ValueError('Credential-like output; refuse archive')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-live-ai', action='store_true')
    parser.add_argument('--suite', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--candidate-prompt', type=Path, help='Private staged JSON with an after field; never archived')
    args = parser.parse_args()
    if not args.allow_live_ai:
        parser.error('Explicit --allow-live-ai is required; this uses paid model calls')
    if args.output.exists():
        parser.error('Output already exists; preserve the earlier run')
    from sqlalchemy import select, text
    from app.db.session import SessionLocal
    from app.models.entities import Setting
    from app.services import openai_service as ai
    from app.tasks.pipeline import _is_closing_acknowledgement

    with SessionLocal() as db:
        db.execute(text('SET TRANSACTION READ ONLY'))
        values = {key: db.scalar(select(Setting.value).where(Setting.key == key)) or ''
                  for key in ('bot_system_prompt', 'bot_memory', 'bot_model_sales', 'bot_model_simple')}
        db.rollback()
    prompt = values['bot_system_prompt'] or ai.SALES_AGENT_SYSTEM_PROMPT
    if args.candidate_prompt:
        prompt = json.loads(args.candidate_prompt.read_text())['after']
    memory = values['bot_memory']
    trusted = '\n\n'.join(v for v in (prompt, memory) if v)
    suite = json.loads(args.suite.read_text())
    context = {'now_bishkek': '12:00', 'date_bishkek': '2026-10-24',
               'is_working_hours': True, 'minutes_since_last_message': 5,
               'requested_date': '24.10.2026', 'free_slots': []}

    def run_turn(case_id, history, turn, language):
        dialogue = history + [{'role': 'user', 'content': turn['user']}]
        started = perf_counter()
        previous_reply = next((m['content'] for m in reversed(history) if m['role'] == 'assistant'), None)
        if _is_closing_acknowledgement(turn['user'], previous_reply=previous_reply) and previous_reply is not None:
            return {'id': case_id, 'history': history, 'user': turn['user'], 'draft': '', 'reply': '',
                    'path': 'deterministic_closing_acknowledgement', 'failures': evaluate_rules('', turn.get('rules', {}))}
        try:
            slots = {**context, 'client_language': language, 'free_slots': turn.get('slots', []),
                     'minutes_since_last_message': 5 if history else 9999}
            result = ai.generate_reply(dialogue, slots, system_prompt=prompt, memory_context=memory,
                                       model_override=values['bot_model_sales'] or None)
            draft = str(result.content)
            reply, checked = ai.verify_reply(dialogue, draft, business_instructions=trusted, slot_context=slots)
            return {'id': case_id, 'history': history, 'user': turn['user'], 'draft': draft, 'reply': reply,
                    'path': 'live_generation_and_quality_check', 'model': result.model, 'provider': result.provider,
                    'checker_model': checked.model if checked else None, 'checker_available': checked is not None,
                    'seconds': round(perf_counter() - started, 3),
                    'failures': evaluate_rules(reply, turn.get('rules', {}))}
        except Exception as exc:
            return {'id': case_id, 'history': history, 'user': turn['user'], 'draft': '', 'reply': '',
                    'error_type': type(exc).__name__, 'failures': ['generation_error']}

    def single(case):
        return run_turn(case['id'], case.get('history', []), case, case.get('language', 'ru'))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(single, suite['cases']))
    for conversation in suite['conversations']:
        history = []
        for index, turn in enumerate(conversation['turns'], 1):
            row = run_turn(f"{conversation['id']}/{index}", list(history), turn, conversation['language'])
            results.append(row)
            history.append({'role': 'user', 'content': turn['user']})
            if row['reply']:
                history.append({'role': 'assistant', 'content': row['reply']})
    for case in suite.get('summaries', []):
        reply, usage = ai.summarize_dialogue(case['history'])
        results.append({'id': case['id'], 'history': case['history'], 'user': 'Сформировать резюме для менеджера',
                        'reply': reply, 'path': 'live_hypervisor_summary', 'model': usage.model if usage else None,
                        'provider': usage.provider if usage else None, 'failures': evaluate_rules(reply, case['rules'])})
    data = redact({'created_at_utc': datetime.now(timezone.utc).isoformat(), 'synthetic_only': True,
                   'no_customer_send': True, 'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
                   'memory_sha256': hashlib.sha256(memory.encode()).hexdigest(), 'results': results})
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    failures = [row['id'] for row in results if row['failures']]
    print(json.dumps({'cases': len(results), 'failed_cases': failures, 'checker_unavailable':
                      sum(row.get('path') == 'live_generation_and_quality_check' and not row['checker_available'] for row in results)}))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
