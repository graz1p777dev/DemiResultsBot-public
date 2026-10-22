from app.services.message_policy import is_plus_only_message, service_message_reason


def test_clear_service_messages_are_rejected() -> None:
    assert service_message_reason("@userinfobot") == "bot_handle"
    assert service_message_reason("CRM логин: user / pass") == "crm_credentials"
    assert service_message_reason("Telegram менеджер: 123456 (имя: demi)") == "manager_configuration"


def test_customer_messages_and_media_are_allowed() -> None:
    assert service_message_reason("Здравствуйте, можно адрес?") is None
    assert service_message_reason("Я забыл пароль от личного кабинета") is None
    assert service_message_reason("[picture] https://example.test/photo.jpg") is None


def test_plus_is_a_real_customer_opt_in() -> None:
    assert is_plus_only_message("+")
    assert is_plus_only_message("  ++  ")
    assert not is_plus_only_message("+996 555 00 00 00")
    assert not is_plus_only_message("хочу узнать подробнее +")
