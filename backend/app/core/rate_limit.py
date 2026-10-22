import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.responses import JSONResponse

from app.core.config import settings

_hits: dict[str, deque[float]] = defaultdict(deque)


async def webhook_rate_limit_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    if not request.url.path.startswith("/webhooks/"):
        return await call_next(request)

    client_host = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window_start = now - 60
    hits = _hits[client_host]
    while hits and hits[0] < window_start:
        hits.popleft()
    if len(hits) >= settings.webhook_rate_limit_per_minute:
        return JSONResponse({"detail": "rate limit exceeded"}, status_code=429)
    hits.append(now)
    return await call_next(request)

