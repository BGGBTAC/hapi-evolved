import asyncio
import json
import unittest
from unittest.mock import patch
import httpx
import provider_catalog
from configuration import InvalidConfiguration


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk


class ProviderCatalogTests(unittest.IsolatedAsyncioTestCase):
    key = "synthetic-catalog-key-never-sent"

    async def catalog(self, response, requests, provider="openai"):
        original = httpx.AsyncClient
        responses = iter(response if isinstance(response, list) else [response])
        def create(**kwargs):
            self.assertEqual(kwargs, {"timeout": 10, "follow_redirects": False, "trust_env": False})
            def handle(request):
                requests.append(request)
                current = next(responses)
                if isinstance(current, Exception):
                    raise current
                return current
            return original(**kwargs, transport=httpx.MockTransport(handle))
        with patch.object(provider_catalog.httpx, "AsyncClient", create):
            return await provider_catalog.list_models(provider, self.key)

    def page(self, ids, has_more=False, **extra):
        value = {"data": [{"id": model} for model in ids], "has_more": has_more,
            "first_id": ids[0] if ids else None, "last_id": ids[-1] if ids else None, **extra}
        return httpx.Response(200, stream=Chunks([json.dumps(value).encode()]))

    async def test_only_model_ids_are_returned_from_fixed_get_without_inference(self):
        body = json.dumps({"data": [{"id": "model-b", "owner": "private-owner"}, {"id": "model-a"}, {"id": "model-b"}]}).encode()
        requests = []
        result = await self.catalog(httpx.Response(200, stream=Chunks([body[:10], body[10:]])), requests)
        self.assertEqual(result, {"models": ["model-a", "model-b"], "verified": True})
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), "https://api.openai.com/v1/models")
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].headers["authorization"], "Bearer " + self.key)
        self.assertNotIn("x-api-key", requests[0].headers)
        self.assertEqual(requests[0].content, b"")

    async def test_anthropic_pages_use_fixed_origin_separate_auth_and_validated_cursors(self):
        requests = []
        result = await self.catalog([
            self.page(["claude-b", "claude-a"], has_more=True, ignored=self.key),
            self.page(["claude-c", "claude-b"]),
        ], requests, "anthropic")
        self.assertEqual(result, {"models": ["claude-a", "claude-b", "claude-c"], "verified": True})
        self.assertEqual(len(requests), 2)
        self.assertEqual(str(requests[0].url), "https://api.anthropic.com/v1/models?limit=1000")
        self.assertEqual(str(requests[1].url), "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a")
        for request in requests:
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.headers["x-api-key"], self.key)
            self.assertEqual(request.headers["anthropic-version"], "2023-06-01")
            self.assertEqual(request.headers["accept-encoding"], "identity")
            self.assertNotIn("authorization", request.headers)
            self.assertEqual(request.content, b"")

    async def test_voyage_is_unverified_without_constructing_http_client(self):
        with patch.object(provider_catalog.httpx, "AsyncClient") as client:
            self.assertEqual(await provider_catalog.list_models("voyage", self.key),
                {"models": [], "verified": False})
            client.assert_not_called()

    async def test_empty_catalogs_are_verified_for_catalog_providers(self):
        for provider in ("openai", "anthropic"):
            self.assertEqual(await self.catalog(self.page([]), [], provider), {"models": [], "verified": True})

    async def test_error_bodies_and_redirects_are_never_read_or_reflected(self):
        for provider in ("openai", "anthropic"):
            for status in [301, 302, 307, 401, 403, 429, 500]:
                with self.subTest(provider=provider, status=status):
                    stream = Chunks([self.key.encode()])
                    response = httpx.Response(status, stream=stream, headers={"location": "https://internal.invalid/"})
                    requests = []
                    error_type = provider_catalog.ProviderUnauthorized if status in (401, 403) else provider_catalog.CatalogUnavailable
                    with self.assertRaises(error_type) as error:
                        await self.catalog(response, requests, provider)
                    self.assertEqual(stream.reads, 0)
                    self.assertEqual(len(requests), 1)
                    self.assertNotIn(self.key, str(error.exception))

    async def test_anthropic_later_page_auth_failure_does_not_return_partial_catalog(self):
        stream = Chunks([self.key.encode()])
        requests = []
        with self.assertRaises(provider_catalog.ProviderUnauthorized):
            await self.catalog([self.page(["claude-a"], has_more=True),
                httpx.Response(401, stream=stream)], requests, "anthropic")
        self.assertEqual(len(requests), 2)
        self.assertEqual(stream.reads, 0)

    async def test_declared_and_streamed_response_sizes_are_bounded(self):
        for response in [
            httpx.Response(200, headers={"content-length": str(provider_catalog.MAX_CATALOG_BYTES + 1)}, stream=Chunks([])),
            httpx.Response(200, headers={"content-length": "invalid"}, stream=Chunks([])),
            httpx.Response(200, headers={"content-encoding": "gzip"}, stream=Chunks([])),
            httpx.Response(200, stream=Chunks([b"x" * 65536] * 17)),
        ]:
            with self.assertRaises(provider_catalog.CatalogUnavailable):
                await self.catalog(response, [])

    async def test_malformed_unbounded_or_secret_echoed_model_data_are_rejected(self):
        invalid = [None, [], {}, {"data": "not-a-list"}, {"data": [{}]}, {"data": [{"id": "invalid\nmodel"}]},
            {"data": [{"id": self.key}]}, {"data": [{"id": "model"}] * (provider_catalog.MAX_MODELS + 1)}]
        for provider in ("openai", "anthropic"):
            for value in invalid:
                with self.assertRaises(provider_catalog.CatalogUnavailable):
                    await self.catalog(httpx.Response(200, stream=Chunks([json.dumps(value).encode()])), [], provider)
            for body in (b"{", b"\xff"):
                with self.assertRaises(provider_catalog.CatalogUnavailable):
                    await self.catalog(httpx.Response(200, stream=Chunks([body])), [], provider)
            with self.assertRaises(provider_catalog.CatalogUnavailable) as error:
                await self.catalog(httpx.ReadTimeout(self.key), [], provider)
            self.assertNotIn(self.key, str(error.exception))

    async def test_anthropic_rejects_malformed_pagination_before_next_request(self):
        for pagination in [
            {"has_more": None}, {"has_more": 1}, {"has_more": "false"},
            {"has_more": True, "last_id": None}, {"has_more": True, "last_id": "other-model"},
            {"has_more": True, "last_id": self.key}, {"has_more": True, "last_id": "bad\ncursor"},
        ]:
            requests = []
            with self.assertRaises(provider_catalog.CatalogUnavailable):
                await self.catalog(self.page(["claude-a"], **pagination), requests, "anthropic")
            self.assertEqual(len(requests), 1)
        with self.assertRaises(provider_catalog.CatalogUnavailable):
            await self.catalog(self.page([], has_more=True), [], "anthropic")
        with self.assertRaises(provider_catalog.CatalogUnavailable):
            await self.catalog(httpx.Response(200, stream=Chunks([b'{"data": []}'])), [], "anthropic")

    async def test_anthropic_repeated_cursors_and_page_limit_are_rejected(self):
        requests = []
        with self.assertRaises(provider_catalog.CatalogUnavailable):
            await self.catalog([self.page(["claude-a"], has_more=True),
                self.page(["claude-a"], has_more=True)], requests, "anthropic")
        self.assertEqual(len(requests), 2)
        requests = []
        pages = [self.page([f"claude-{index}"], has_more=True) for index in range(provider_catalog.MAX_CATALOG_PAGES)]
        with self.assertRaises(provider_catalog.CatalogUnavailable):
            await self.catalog(pages, requests, "anthropic")
        self.assertEqual(len(requests), provider_catalog.MAX_CATALOG_PAGES)

    async def test_anthropic_aggregate_bytes_bound_declared_and_streamed_pages(self):
        for declared in (True, False):
            first = self.page(["claude-a"], has_more=True)
            first_size = len(first.stream.chunks[0])
            second = self.page(["claude-b"])
            second_stream = second.stream
            second_size = len(second_stream.chunks[0])
            if declared:
                second.headers["content-length"] = str(second_size)
            with patch.object(provider_catalog, "MAX_CATALOG_BYTES", first_size + second_size - 1):
                with self.assertRaises(provider_catalog.CatalogUnavailable):
                    await self.catalog([first, second], [], "anthropic")
            self.assertEqual(second_stream.reads, 0 if declared else 1)

    async def test_anthropic_aggregate_model_limit_counts_duplicates(self):
        with patch.object(provider_catalog, "MAX_MODELS", 2):
            with self.assertRaises(provider_catalog.CatalogUnavailable):
                await self.catalog([self.page(["claude-a", "claude-b"], has_more=True),
                    self.page(["claude-a"])], [], "anthropic")

    async def test_total_timeout_interrupts_a_later_page(self):
        class Stalled(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.Event().wait()
                yield b""
        requests = []
        with patch.object(provider_catalog, "CATALOG_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(provider_catalog.CatalogUnavailable):
                await asyncio.wait_for(self.catalog([self.page(["claude-a"], has_more=True),
                    httpx.Response(200, stream=Stalled())], requests, "anthropic"), timeout=1)
        self.assertEqual(len(requests), 2)

    async def test_invalid_key_never_constructs_an_http_client(self):
        with patch.object(provider_catalog.httpx, "AsyncClient") as client:
            for provider in ("openai", "anthropic", "voyage"):
                for key in (None, "short", "a" * 4097, "key\r\nheader", "key with spaces"):
                    with self.assertRaises(InvalidConfiguration):
                        await provider_catalog.list_models(provider, key)
            client.assert_not_called()

    async def test_unknown_provider_never_constructs_an_http_client(self):
        with patch.object(provider_catalog.httpx, "AsyncClient") as client:
            for provider in (None, "OpenAI", "unknown", "https://internal.invalid", [], {}):
                with self.assertRaises(InvalidConfiguration):
                    await provider_catalog.list_models(provider, self.key)
            client.assert_not_called()


if __name__ == "__main__": unittest.main()
