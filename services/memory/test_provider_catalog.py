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

    async def catalog(self, response, requests):
        original = httpx.AsyncClient
        def create(**kwargs):
            self.assertEqual(kwargs, {"timeout": 10, "follow_redirects": False, "trust_env": False})
            def handle(request):
                requests.append(request)
                if isinstance(response, Exception):
                    raise response
                return response
            return original(**kwargs, transport=httpx.MockTransport(handle))
        with patch.object(provider_catalog.httpx, "AsyncClient", create):
            return await provider_catalog.list_models(self.key)

    async def test_only_model_ids_are_returned_from_fixed_get_without_inference(self):
        body = json.dumps({"data": [{"id": "model-b", "owner": "private-owner"}, {"id": "model-a"}, {"id": "model-b"}]}).encode()
        requests = []
        result = await self.catalog(httpx.Response(200, stream=Chunks([body[:10], body[10:]])), requests)
        self.assertEqual(result, ["model-a", "model-b"])
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), "https://api.openai.com/v1/models")
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].headers["authorization"], "Bearer " + self.key)
        self.assertEqual(requests[0].content, b"")

    async def test_error_bodies_and_redirects_are_never_read_or_reflected(self):
        for status in [301, 302, 307, 401, 403, 429, 500]:
            stream = Chunks([self.key.encode()])
            response = httpx.Response(status, stream=stream, headers={"location": "https://internal.invalid/"})
            requests = []
            error_type = provider_catalog.ProviderUnauthorized if status in (401, 403) else provider_catalog.CatalogUnavailable
            with self.assertRaises(error_type) as error:
                await self.catalog(response, requests)
            self.assertEqual(stream.reads, 0)
            self.assertEqual(len(requests), 1)
            self.assertNotIn(self.key, str(error.exception))

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
        for value in invalid:
            with self.assertRaises(provider_catalog.CatalogUnavailable):
                await self.catalog(httpx.Response(200, stream=Chunks([json.dumps(value).encode()])), [])
        with self.assertRaises(provider_catalog.CatalogUnavailable) as error:
            await self.catalog(httpx.ReadTimeout(self.key), [])
        self.assertNotIn(self.key, str(error.exception))

    async def test_invalid_key_never_constructs_an_http_client(self):
        with patch.object(provider_catalog.httpx, "AsyncClient") as client:
            with self.assertRaises(InvalidConfiguration):
                await provider_catalog.list_models("key\r\nheader")
            client.assert_not_called()


if __name__ == "__main__": unittest.main()
