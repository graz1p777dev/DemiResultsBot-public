import re
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from server import MAX_BODY, NIGHT_NOTICE, load_knowledge, make_server, reply_for


class DemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.token = re.search(r'name="token" value="([^"]+)"', self.get())[1]

    def get(self):
        with urlopen(self.base + "/") as response:
            return response.read().decode("utf-8")

    def post(self, path, **fields):
        fields.setdefault("token", self.token)
        request = Request(self.base + path, data=urlencode(fields).encode("utf-8"), method="POST")
        with urlopen(request) as response:
            return response.status

    def test_knowledge_answers_and_unknowns(self):
        knowledge = load_knowledge()
        self.assertIn("Байтик Баатыра 39", reply_for("Какой адрес?", knowledge))
        self.assertIn("10:00", reply_for("Какой график?", knowledge))
        self.assertIn("По системной инструкции", reply_for("Какая доставка?", knowledge))
        self.assertIn("не проверены", reply_for("Какая цена?", knowledge))
        self.assertIn("не могу подтвердить", reply_for("Запишите меня завтра", knowledge))
        self.assertIn("нет однозначного", reply_for("Расскажите о креме", knowledge))

    def test_day_approval_edit_reject_and_escaping(self):
        self.post("/mode", mode="day")
        self.post("/message", message="<script>alert(1)</script>")
        page = self.get()
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn("<script>", page)
        self.assertIn("Демо-менеджер · ответ на проверке", page)
        self.assertIn("Черновик ещё не одобрен", page)
        with self.assertRaises(HTTPError) as caught:
            self.post("/message", message="another")
        self.assertEqual(caught.exception.code, 409)
        caught.exception.close()
        with self.assertRaises(HTTPError) as caught:
            self.post("/mode", mode="night")
        self.assertEqual(caught.exception.code, 409)
        self.assertIn("Сначала одобрите", caught.exception.read().decode("utf-8"))
        caught.exception.close()
        self.assertIn("Демо-менеджер · ответ на проверке", self.get())
        self.post("/action", decision="save", edited="<b>Ответ</b>")
        saved_page = self.get()
        self.assertIn("Правка сохранена", saved_page)
        self.assertIn("&lt;b&gt;Ответ&lt;/b&gt;", saved_page)
        self.assertNotIn("Демо-менеджер одобрил", saved_page)
        self.post("/action", decision="approve")
        self.assertIn("Демо-менеджер одобрил · DEMO", self.get())
        self.assertIn("&lt;b&gt;Ответ&lt;/b&gt;", self.get())
        self.post("/message", message="ещё вопрос")
        self.post("/action", decision="reject")
        self.assertIn("Черновик отклонён", self.get())
        self.post("/message", message="график")
        self.post("/action", decision="approve")
        self.assertIn("10:00", self.get())

    def test_night_and_future_demo(self):
        self.post("/mode", mode="night")
        self.post("/message", message="адрес")
        self.post("/message", message="график")
        page = self.get()
        self.assertIn("Ночной шаблон · DEMO", page)
        self.assertEqual(page.count(NIGHT_NOTICE), 1)
        self.assertIn("Клиент:</b> адрес", page)
        self.assertIn("Клиент:</b> график", page)
        self.assertNotIn("ответ на проверке", page)
        self.post("/mode", mode="night")
        self.post("/message", message="новая ночная сессия")
        self.assertEqual(self.get().count(NIGHT_NOTICE), 2)
        self.post("/mode", mode="autonomous")
        self.post("/message", message="адрес")
        self.assertIn("Автономный ответ · DEMO", self.get())

    def test_boundaries(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        request = Request(self.base + "/", headers={"Host": "example.com"})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()
        with self.assertRaises(HTTPError) as caught:
            self.post("/message", message="x" * (MAX_BODY + 1))
        self.assertEqual(caught.exception.code, 413)
        caught.exception.close()
        with self.assertRaises(HTTPError) as caught:
            self.post("/mode", mode="night", token="wrong")
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()


if __name__ == "__main__":
    unittest.main()
