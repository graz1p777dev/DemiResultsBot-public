"""Isolated, in-memory, loopback-only demo. No production imports or transports."""

import argparse
import html
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs


KNOWLEDGE = Path(__file__).with_name("knowledge.json")
MAX_BODY = 8192
MAX_TEXT = 2000
MAX_MESSAGES = 60
MODES = {"day", "night", "autonomous"}
NIGHT_NOTICE = "Наш магазин уже закрылся. Спасибо за сообщение! Мы ответим вам завтра с 10:00."


def load_knowledge(path=KNOWLEDGE):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("instructions_markdown"), str):
        raise ValueError("Некорректный knowledge.json: instructions_markdown")
    if (not isinstance(data.get("verified_facts"), list)
            or not isinstance(data.get("instruction_facts", []), list)
            or not isinstance(data.get("unknown"), dict)):
        raise ValueError("Некорректный knowledge.json: verified_facts/unknown")
    if not isinstance(data["unknown"].get("address"), str):
        raise ValueError("Некорректный knowledge.json: unknown.address")
    for fact in data["verified_facts"]:
        if (not isinstance(fact, dict) or fact.get("verified") is not True
                or not isinstance(fact.get("triggers"), list)
                or not fact["triggers"] or not all(isinstance(t, str) and t.strip() for t in fact["triggers"])
                or not isinstance(fact.get("answer"), str) or not fact["answer"].strip()):
            raise ValueError("Некорректный подтверждённый факт")
    for fact in data.get("instruction_facts", []):
        if (not isinstance(fact, dict) or fact.get("status") != "instruction_only"
                or not isinstance(fact.get("triggers"), list) or not fact["triggers"]
                or not all(isinstance(t, str) and t.strip() for t in fact["triggers"])
                or not isinstance(fact.get("answer"), str) or not fact["answer"].strip()):
            raise ValueError("Некорректный факт из инструкции")
    return data


def reply_for(message, knowledge):
    lowered = message.casefold()
    if any(word in lowered for word in ("запис", "запиш", "слот", "консультац")):
        return "Я не могу подтвердить запись или свободное время в этом демо. Сотрудник уточнит детали."
    if any(word in lowered for word in ("цена", "стоимост", "наличи", "сколько стоит")):
        return "Актуальные цены и наличие в этом демо не проверены. Уточните у сотрудника."
    matches = [f["answer"] for f in knowledge["verified_facts"]
               if any(t.casefold() in lowered for t in f["triggers"])]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        instructed = [f["answer"] for f in knowledge.get("instruction_facts", [])
                      if any(t.casefold() in lowered for t in f["triggers"])]
        if len(instructed) == 1:
            return instructed[0]
    if not matches and any(word in lowered for word in ("адрес", "где вы", "как добраться", "локаци")):
        return knowledge["unknown"]["address"]
    return "Пока нет однозначного подтверждённого ответа. Вопрос передан сотруднику в рамках локального демо."


class DemoState:
    def __init__(self):
        self.mode = "day"
        self.messages = []
        self.pending = None
        self.edited = None
        self.night_notified = False
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.Lock()

    def add(self, role, content):
        self.messages.append((role, content))
        self.messages = self.messages[-MAX_MESSAGES:]


def make_server(port=8765, knowledge_path=KNOWLEDGE):
    knowledge_path = Path(knowledge_path)
    load_knowledge(knowledge_path)
    state = DemoState()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def error(self, code, message):
            # HTTP status lines are latin-1; show the Russian recovery text in the body.
            body = (f'<!doctype html><html lang="ru"><meta charset="utf-8">'
                    f'<h1>Действие не выполнено</h1><p>{html.escape(message)}</p>'
                    '<a href="/">Вернуться к демо</a></html>').encode("utf-8")
            self.send_response(code, "Request rejected")
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'")
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            host = self.headers.get("Host", "")
            return host in {"127.0.0.1", f"127.0.0.1:{self.server.server_port}",
                            "localhost", f"localhost:{self.server.server_port}"}

        def do_GET(self):
            if not self.valid_host():
                return self.error(403, "Недопустимый Host")
            if self.path != "/":
                return self.error(404, "Не найдено")
            try:
                knowledge = load_knowledge(knowledge_path)
            except (OSError, ValueError, json.JSONDecodeError):
                return self.error(503, "Ошибка knowledge.json")
            esc = lambda value: html.escape(str(value), quote=True)
            with state.lock:
                rows = "".join(f'<div class="msg"><b>{esc(role)}:</b> {esc(content)}</div>'
                               for role, content in state.messages)
                pending = ""
                if state.pending is not None:
                    shown_reply = state.edited if state.edited is not None else state.pending
                    edit_status = ('<p>Правка сохранена. Теперь одобрите или отклоните ответ.</p>'
                                   if state.edited is not None else '<p>Черновик ещё не одобрен.</p>')
                    pending = (f'<section><h2>Демо-менеджер · ответ на проверке</h2>'
                               f'<p>{esc(shown_reply)}</p>{edit_status}'
                               '<form method="post" action="/action">'
                               f'<input type="hidden" name="token" value="{state.token}">'
                               '<textarea name="edited" maxlength="2000" aria-label="Текст для изменения">'
                               f'{esc(shown_reply)}</textarea><br>'
                               '<button name="decision" value="save">Сохранить правку</button></form>'
                               '<form method="post" action="/action">'
                               f'<input type="hidden" name="token" value="{state.token}">'
                               '<button name="decision" value="approve">Одобрить</button> '
                               '<button name="decision" value="reject">Отклонить</button></form></section>')
                mode = state.mode
                token = state.token
                mode_note = ('<p class="note">Сначала одобрите или отклоните текущий черновик; '
                             'после этого можно сменить режим.</p>' if state.pending is not None else '')
            options = "".join(f'<option value="{m}" {"selected" if m == mode else ""}>{label}</option>'
                              for m, label in (("day", "День · сотрудник согласует"),
                                               ("night", "Ночь · автошаблон"),
                                               ("autonomous", "Будущий автономный · DEMO")))
            page = f'''<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DemiResults · локальное демо</title>
<style>body{{font:16px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}}section{{border:1px solid #ccc;padding:1rem;margin:1rem 0}}.msg{{padding:.6rem;border-bottom:1px solid #ddd;white-space:pre-wrap}}textarea{{width:100%;box-sizing:border-box;min-height:5rem}}button,select{{font:inherit;padding:.35rem}}.note{{color:#555}}</style>
<h1>DemiResults · локальное демо</h1><p class="note">Только этот компьютер. Rule-based ответы; LLM не подключена. Никаких реальных отправок, записей и CRM-изменений.</p>
<form method="post" action="/mode"><input type="hidden" name="token" value="{token}">
<label>Режим <select name="mode">{options}</select></label> <button>Применить</button></form>{mode_note}
<p class="note">Демо-менеджер (без авторизации): проверяет дневной ответ перед появлением в чате. Ночью показывается один автошаблон за ночную сессию. Автономный режим существует лишь в этом демо.</p>
<section aria-label="Чат">{rows or '<p>Сообщений пока нет.</p>'}</section>{pending}
<form method="post" action="/message"><input type="hidden" name="token" value="{token}">
<label for="message">Сообщение клиента</label><textarea id="message" name="message" maxlength="2000" required></textarea>
<button>Отправить в локальный чат</button></form>
<details><summary>Инструкции из knowledge.json</summary><pre>{esc(knowledge['instructions_markdown'])}</pre></details>
</html>'''
            body = page.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not self.valid_host():
                return self.error(403, "Недопустимый Host")
            if self.path not in {"/mode", "/message", "/action"}:
                return self.error(404, "Не найдено")
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/x-www-form-urlencoded":
                return self.error(415, "Ожидается форма")
            try:
                size = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self.error(411, "Не указан размер")
            if size < 0 or size > MAX_BODY:
                return self.error(413, "Слишком большой запрос")
            try:
                fields = parse_qs(self.rfile.read(size).decode("utf-8"), strict_parsing=True, max_num_fields=5)
            except (UnicodeDecodeError, ValueError):
                return self.error(400, "Некорректная форма")
            one = lambda key: fields.get(key, [""])[0] if len(fields.get(key, [])) == 1 else ""
            with state.lock:
                if not secrets.compare_digest(one("token"), state.token):
                    return self.error(403, "Неверный токен")
                if self.path == "/mode":
                    if one("mode") not in MODES:
                        return self.error(400, "Неизвестный режим")
                    if state.pending is not None:
                        return self.error(409, "Сначала одобрите или отклоните текущий черновик. Затем смените режим.")
                    state.mode = one("mode")
                    if state.mode == "night":
                        state.night_notified = False
                elif self.path == "/message":
                    if state.mode == "day" and state.pending is not None:
                        return self.error(409, "Сначала решите вопрос с текущим черновиком")
                    message = one("message").strip()
                    if not message or len(message) > MAX_TEXT:
                        return self.error(400, "Недопустимое сообщение")
                    try:
                        knowledge = load_knowledge(knowledge_path)
                    except (OSError, ValueError, json.JSONDecodeError):
                        return self.error(503, "Ошибка knowledge.json")
                    state.add("Клиент", message)
                    if state.mode == "night":
                        if not state.night_notified:
                            state.add("Ночной шаблон · DEMO", NIGHT_NOTICE)
                            state.night_notified = True
                    elif state.mode == "day":
                        state.pending = reply_for(message, knowledge)
                        state.edited = None
                    else:
                        state.add("Автономный ответ · DEMO", reply_for(message, knowledge))
                else:
                    decision = one("decision")
                    edited = one("edited").strip()
                    if state.mode != "day" or state.pending is None or decision not in {"approve", "save", "reject"}:
                        return self.error(409, "Нет ответа для согласования")
                    if decision == "save" and (not edited or len(edited) > MAX_TEXT):
                        return self.error(400, "Недопустимое изменение")
                    if decision == "save":
                        state.edited = edited
                    else:
                        if decision == "reject":
                            state.add("Демо-менеджер · DEMO", "Черновик отклонён. Ответ клиенту не показан.")
                        else:
                            state.add("Демо-менеджер одобрил · DEMO", state.edited if state.edited is not None else state.pending)
                        state.pending = None
                        state.edited = None
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Локальное демо DemiResults")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = make_server(args.port)
    print(f"Локальное демо: http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
