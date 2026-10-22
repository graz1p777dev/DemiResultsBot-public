from app.services.telegram import waiting_clients_keyboard, waiting_clients_list


def test_waiting_clients_are_paginated() -> None:
    contacts = [(f"+996700000{i:03d}", str(9000 + i)) for i in range(32)]
    text = waiting_clients_list(contacts, page=1)

    assert "страница 2/3" in text
    assert "16." in text
    assert "30." in text
    assert "31." not in text
    keyboard = waiting_clients_keyboard(len(contacts), page=1)
    assert keyboard is not None
    callbacks = [button["callback_data"] for button in keyboard["inline_keyboard"][0]]
    assert callbacks == ["waiting:0", "waiting:1", "waiting:2"]
