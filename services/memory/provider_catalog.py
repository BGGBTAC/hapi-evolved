"""Bounded, non-inference provider catalogs; never reflect provider diagnostics."""
import asyncio
import json
import httpx
from configuration import ANTHROPIC_BASE, MODEL_ID, OPENAI_BASE, InvalidConfiguration, validate_api_key

MAX_CATALOG_BYTES = 1_048_576
MAX_MODELS = 5000
MAX_CATALOG_PAGES = 10
CATALOG_TIMEOUT_SECONDS = 12


class CatalogUnavailable(Exception):
    pass


class ProviderUnauthorized(Exception):
    pass


async def list_models(provider, api_key):
    validate_api_key(api_key)
    if provider not in ("openai", "anthropic", "voyage"):
        raise InvalidConfiguration()
    # Voyage documents no non-inference catalog endpoint. Do not invent one or
    # treat syntactically valid credentials as provider-verified credentials.
    if provider == "voyage":
        return {"models": [], "verified": False}
    base = OPENAI_BASE if provider == "openai" else ANTHROPIC_BASE
    headers = {"accept-encoding": "identity"}
    if provider == "openai":
        headers["authorization"] = "Bearer " + api_key
    else:
        headers.update({"x-api-key": api_key, "anthropic-version": "2023-06-01"})
    params = {} if provider == "openai" else {"limit": "1000"}
    ids = set()
    cursors = set()
    total_bytes = 0
    total_models = 0
    try:
        async with asyncio.timeout(CATALOG_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
                for _ in range(MAX_CATALOG_PAGES):
                    async with client.stream("GET", base + "/models", headers=headers, params=params) as response:
                        if response.status_code in (401, 403):
                            raise ProviderUnauthorized()
                        if response.status_code != 200 or response.headers.get("content-encoding", "identity") != "identity":
                            raise CatalogUnavailable()
                        declared = response.headers.get("content-length")
                        if declared is not None and (not declared.isdecimal()
                                or int(declared) > MAX_CATALOG_BYTES - total_bytes):
                            raise CatalogUnavailable()
                        body = bytearray()
                        async for chunk in response.aiter_raw():
                            total_bytes += len(chunk)
                            if total_bytes > MAX_CATALOG_BYTES:
                                raise CatalogUnavailable()
                            body.extend(chunk)
                    data = json.loads(body)
                    entries = data.get("data") if isinstance(data, dict) else None
                    if not isinstance(entries, list):
                        raise CatalogUnavailable()
                    total_models += len(entries)
                    if total_models > MAX_MODELS:
                        raise CatalogUnavailable()
                    for entry in entries:
                        model = entry.get("id") if isinstance(entry, dict) else None
                        if not isinstance(model, str) or not MODEL_ID.fullmatch(model) or api_key in model:
                            raise CatalogUnavailable()
                        ids.add(model)
                    if provider == "openai":
                        return {"models": sorted(ids), "verified": True}
                    if type(data.get("has_more")) is not bool:
                        raise CatalogUnavailable()
                    if not data["has_more"]:
                        return {"models": sorted(ids), "verified": True}
                    cursor = data.get("last_id")
                    if (not entries or not isinstance(cursor, str) or cursor != entries[-1]["id"]
                            or cursor in cursors):
                        raise CatalogUnavailable()
                    cursors.add(cursor)
                    params["after_id"] = cursor
                raise CatalogUnavailable()
    except ProviderUnauthorized:
        raise
    except Exception:
        raise CatalogUnavailable() from None
