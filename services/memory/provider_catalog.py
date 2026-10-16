"""Bounded, non-inference OpenAI catalog lookup; never reflect provider diagnostics."""
import asyncio
import json
import httpx
from configuration import MODEL_ID, OPENAI_BASE, validate_api_key

MAX_CATALOG_BYTES = 1_048_576
MAX_MODELS = 5000


class CatalogUnavailable(Exception):
    pass


class ProviderUnauthorized(Exception):
    pass


async def list_models(api_key):
    validate_api_key(api_key)
    try:
        async with asyncio.timeout(12):
            async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
                async with client.stream("GET", OPENAI_BASE + "/models",
                        headers={"authorization": "Bearer " + api_key, "accept-encoding": "identity"}) as response:
                    if response.status_code in (401, 403):
                        raise ProviderUnauthorized()
                    if response.status_code != 200 or response.headers.get("content-encoding", "identity") != "identity":
                        raise CatalogUnavailable()
                    declared = response.headers.get("content-length")
                    if declared is not None and (not declared.isdecimal() or int(declared) > MAX_CATALOG_BYTES):
                        raise CatalogUnavailable()
                    body = bytearray()
                    async for chunk in response.aiter_raw():
                        if len(body) + len(chunk) > MAX_CATALOG_BYTES:
                            raise CatalogUnavailable()
                        body.extend(chunk)
        data = json.loads(body)
        entries = data.get("data") if isinstance(data, dict) else None
        if not isinstance(entries, list) or len(entries) > MAX_MODELS:
            raise CatalogUnavailable()
        ids = set()
        for entry in entries:
            model = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(model, str) or not MODEL_ID.fullmatch(model) or api_key in model:
                raise CatalogUnavailable()
            ids.add(model)
        return sorted(ids)
    except ProviderUnauthorized:
        raise
    except Exception:
        raise CatalogUnavailable() from None
