from app.services.outgoing import (
    MESSAGE_SEPARATOR,
    message_delay_seconds,
    split_outgoing_messages,
)


def test_marker_and_paragraphs_create_separate_messages():
    assert split_outgoing_messages(
        f"Цена известна.{MESSAGE_SEPARATOR}Какой формат Вам удобнее?"
    ) == ["Цена известна.", "Какой формат Вам удобнее?"]
    assert split_outgoing_messages("Первое.\n\nВторое.") == ["Первое.", "Второе."]


def test_internal_marker_never_reaches_client():
    parts = split_outgoing_messages(MESSAGE_SEPARATOR.join(["1", "2", "3", "4"]))
    assert parts == ["1", "2", "3\n\n4"]
    assert all(MESSAGE_SEPARATOR not in part for part in parts)


def test_short_answer_stays_whole_and_delay_is_bounded():
    assert split_outgoing_messages("Один ответ.") == ["Один ответ."]
    assert 0.7 <= message_delay_seconds("Следующее сообщение") <= 2.55
