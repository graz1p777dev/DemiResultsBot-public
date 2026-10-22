"""Read-only access to the separate `inventory` Supabase project (products,
stock, sales, cash shifts). Copilot only *reads* through here — the
inventory app owns writes via its own Supabase auth/RLS, which this backend
does not share. Uses the service-role key via PostgREST REST calls (httpx is
already a dependency; no new SDK needed).
"""
import logging

import httpx

from app.core.config import settings

_log = logging.getLogger(__name__)


def _configured() -> bool:
    return bool(settings.supabase_url and settings.supabase_service_role_key)


def _headers() -> dict:
    key = settings.supabase_service_role_key
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }


def _get(path: str, params: dict) -> list[dict]:
    if not _configured():
        raise RuntimeError("Supabase inventory access is not configured")
    url = f"{settings.supabase_url.rstrip('/')}/rest/v1/{path}"
    try:
        resp = httpx.get(url, headers=_headers(), params=params, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as e:
        _log.warning("inventory_client request failed: %s %s", path, e)
        raise


def fetch_products(low_stock_only: bool = False, limit: int = 50) -> list[dict]:
    params = {
        "select": "name,sku,unit,retail_price,min_stock_level,is_active",
        "is_active": "eq.true",
        "order": "name.asc",
        "limit": str(limit),
    }
    products = _get("inventory_products", params)
    if not low_stock_only:
        return products

    balances = _get("inventory_stock_balances", {"select": "product_id,quantity"})
    stock_by_product: dict[str, float] = {}
    for row in balances:
        pid = row.get("product_id")
        stock_by_product[pid] = stock_by_product.get(pid, 0) + float(row.get("quantity") or 0)

    # Products aren't fetched with their id above (kept minimal for the summary
    # case); re-fetch with id when we need to match against stock balances.
    products_with_id = _get("inventory_products", {**params, "select": params["select"] + ",id"})
    low_stock = []
    for p in products_with_id:
        qty = stock_by_product.get(p.get("id"), 0)
        if qty <= float(p.get("min_stock_level") or 0):
            low_stock.append({**{k: v for k, v in p.items() if k != "id"}, "current_stock": qty})
    return low_stock


def fetch_recent_sales(limit: int = 10) -> list[dict]:
    params = {
        "select": "doc_number,total_amount,posted_at,status",
        "doc_type": "eq.sale",
        "status": "eq.posted",
        "order": "posted_at.desc",
        "limit": str(limit),
    }
    return _get("inventory_documents", params)


def fetch_open_shifts() -> list[dict]:
    params = {
        "select": "shift_number,register_id,opened_at,sales_count,sales_amount",
        "status": "eq.open",
        "order": "opened_at.desc",
    }
    return _get("inventory_shifts", params)
