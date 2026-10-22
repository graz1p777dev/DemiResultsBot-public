from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.tasks.pipeline import move_lead_status


@patch("app.tasks.pipeline.log_action")
@patch("app.tasks.pipeline.amocrm.patch_lead_status")
def test_automatic_primary_contact_does_not_downgrade_scheduled(
    patch_status: Mock, log_action: Mock
) -> None:
    db = Mock()
    lead = SimpleNamespace(id=1, is_test=False, status_id=83194238, client=None)

    move_lead_status(db, lead, 83498534, "sales_message")

    patch_status.assert_not_called()
    assert log_action.call_args.args[3] == "skipped"
