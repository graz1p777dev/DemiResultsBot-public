#!/bin/bash
set -euo pipefail
cd /
# The separate PG service owns the disposable Unix socket. No TCP is used.
env -i PATH=/usr/local/bin:/usr/bin:/bin python /workspace/scripts/test_pg_release.py
env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONPATH=/workspace/backend \
  timeout 120 python -m pytest /workspace/backend/tests -q -o faulthandler_timeout=30
env -i PATH=/usr/local/bin:/usr/bin:/bin python -m unittest discover -s /workspace/demo -p test_demo.py -v
env -i PATH=/usr/local/bin:/usr/bin:/bin python /workspace/scripts/test_celery_release.py
