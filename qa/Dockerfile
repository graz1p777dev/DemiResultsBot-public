# A dependency-only existing image may be supplied for an offline rebuild.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
FROM ${PYTHON_IMAGE}
WORKDIR /workspace
COPY backend/requirements-local.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock && pip check
COPY backend/app backend/app
COPY backend/tests backend/tests
COPY scripts/test_pg_release.py scripts/test_celery_release.py scripts/
COPY demo demo
COPY qa/run.sh qa/celery_worker.py qa/
ENTRYPOINT ["bash", "/workspace/qa/run.sh"]
