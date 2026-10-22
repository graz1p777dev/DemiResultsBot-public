"""Fence committed work if an advisory-lock connection disappears.

Each ORM transaction locks a per-lead epoch row. A successor must change that
row before doing work; the old Session then refuses its next transaction.
"""
from uuid import uuid4

from sqlalchemy import event, select
from sqlalchemy.dialects.postgresql import insert

from app.models.entities import Setting


class StalePipelineFence(RuntimeError):
    pass


def install(db, lead_id):
    key = f"pipeline_fence:{lead_id}"
    token = uuid4().hex
    statement = insert(Setting).values(key=key, value=token, is_secret=False)
    db.execute(statement.on_conflict_do_update(index_elements=[Setting.key], set_={"value": token}))
    db.commit()

    def guard(session, transaction, connection):
        current = connection.scalar(select(Setting.value).where(Setting.key == key).with_for_update())
        if current != token:
            raise StalePipelineFence("Pipeline ownership changed")
    event.listen(db, "after_begin", guard)
    return guard


def remove(db, guard):
    if guard is not None:
        event.remove(db, "after_begin", guard)
