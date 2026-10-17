import asyncio
import json
import unittest
import httpx
from budget import OperationLedger, BudgetExceeded
from transport import BudgetTransport, SCHEMA_TOOL


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def config(self, role="llm"):
        return {"base": "https://model.invalid/v1", "provider": "openai", "role": role,
            "model": "test-embedding" if role == "embedding" else "test-model", "max_output_tokens": 20,
            "input_rate": "1", "output_rate": "2", "dimensions": 1536}


    async def test_charge_before_network_and_reconcile_receipt(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("op", "p", 0, "hash", 10_000)
        transport = BudgetTransport(ledger, "op", self.config())
        requests = []
        async def handle(request):
            requests.append(json.loads(request.content))
            self.assertGreater(ledger.spent("op"), 100)
            return httpx.Response(200, json={"usage": {"prompt_tokens": 5, "completion_tokens": 3}})
        transport.inner = httpx.MockTransport(handle)
        async with httpx.AsyncClient(transport=transport) as client:
            await client.post("https://model.invalid/v1/chat/completions", json={"model": "test-model", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 1000})
        self.assertEqual(requests[0]["max_completion_tokens"], 20)
        self.assertFalse(requests[0]["store"])
        self.assertEqual(ledger.spent("op"), 11)

    async def test_responses_api_has_capped_output_no_storage_and_exact_receipt(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("response", "p", 0, "hash", 10_000)
        transport = BudgetTransport(ledger, "response", self.config())
        requests = []
        async def handle(request):
            requests.append(json.loads(request.content))
            self.assertGreater(ledger.spent("response"), 100)
            return httpx.Response(200, json={"usage": {"input_tokens": 7, "output_tokens": 4}})
        transport.inner = httpx.MockTransport(handle)
        async with httpx.AsyncClient(transport=transport) as client:
            await client.post("https://model.invalid/v1/responses", json={"model": "test-model", "input": "hello", "max_output_tokens": 1000, "store": True})
            with self.assertRaises(ValueError):
                await client.post("https://model.invalid/v1/responses", json={"model": "test-model", "input": "hello", "tools": [{"type": "web_search"}]})
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["max_output_tokens"], 20)
        self.assertFalse(requests[0]["store"])
        self.assertEqual(ledger.spent("response"), 15)

    async def test_exhausted_budget_never_reaches_provider(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("op", "p", 0, "hash", 1)
        transport = BudgetTransport(ledger, "op", self.config("embedding"))
        transport.inner = httpx.MockTransport(lambda request: self.fail("Provider must not be called"))
        async with httpx.AsyncClient(transport=transport) as client:
            with self.assertRaises(BudgetExceeded):
                await client.post("https://model.invalid/v1/embeddings", json={"model": "test-embedding", "input": "hello"})

    async def test_changed_dimensions_fail_before_charge_or_network(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("dimensions", "p", 0, "hash", 10000)
        config = self.config("embedding")
        transport = BudgetTransport(ledger, "dimensions", config)
        config["dimensions"] = 3072
        transport.inner = httpx.MockTransport(lambda request: self.fail("Provider must not be called"))
        async with httpx.AsyncClient(transport=transport) as client:
            for dimensions in [3072, 1536.0, "1536", True]:
                with self.assertRaises(ValueError):
                    await client.post("https://model.invalid/v1/embeddings", json={"model": "test-embedding", "input": "hello", "dimensions": dimensions})
        self.assertEqual(ledger.spent("dimensions"), 0)

    async def test_wrong_endpoint_is_rejected_before_request(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("op", "p", 0, "hash", 10_000)
        transport = BudgetTransport(ledger, "op", self.config("embedding"))
        transport.inner = httpx.MockTransport(lambda request: self.fail("Provider must not be called"))
        async with httpx.AsyncClient(transport=transport) as client:
            for url in ["https://other.invalid/v1/embeddings", "https://model.invalid/embeddings", "https://model.invalid:444/v1/embeddings",
                        "https://model.invalid/admin/embeddings", "https://model.invalid/v1/embeddings?redirect=secret",
                        "https://user:password@model.invalid/v1/embeddings"]:
                with self.assertRaises(ValueError):
                    await client.post(url, json={"model": "test-embedding", "input": "hello"})
        self.assertEqual(ledger.spent("op"), 0)

    async def test_provider_errors_keep_upper_bound_and_do_not_follow_redirects(self):
        for status in [302, 500]:
            ledger = OperationLedger(":memory:")
            ledger.begin("op", "p", 0, "hash", 10_000)
            transport = BudgetTransport(ledger, "op", self.config("embedding"))
            calls = []
            def handle(request):
                calls.append(str(request.url))
                return httpx.Response(status, headers={"location": "https://private.invalid/secret"})
            transport.inner = httpx.MockTransport(handle)
            async with httpx.AsyncClient(transport=transport) as client:
                response = await client.post("https://model.invalid/v1/embeddings", json={"model": "test-embedding", "input": "hello"})
                self.assertEqual(response.status_code, status)
            self.assertEqual(len(calls), 1)
            self.assertGreater(ledger.spent("op"), 0)

    async def test_anthropic_exact_auto_contract_and_http_rejection_keep_single_reservation(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("op", "p", 0, "hash", 10_000)
        transport = BudgetTransport(ledger, "op", {**self.config(), "provider": "anthropic"})
        body = {"model": "test-model", "system": "Extract synthetic data", "messages": [{"role": "user", "content": "Synthetic data"}],
            "max_tokens": 1000, "tools": [{"name": SCHEMA_TOOL, "description": "Schema", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": True}}
        calls, reserved = [], []
        def handle(request):
            calls.append(json.loads(request.content))
            reserved.append(ledger.spent("op"))
            return httpx.Response(400, json={"error": {"message": "synthetic-private-error"}})
        await transport.inner.aclose()
        transport.inner = httpx.MockTransport(handle)
        async with httpx.AsyncClient(transport=transport) as client:
            for choice in [{"type": "tool", "name": SCHEMA_TOOL}, {"type": "any"},
                    {"type": "auto", "disable_parallel_tool_use": 1}]:
                with self.assertRaises(ValueError):
                    await client.post("https://model.invalid/v1/messages", json={**body, "tool_choice": choice})
            self.assertEqual(ledger.spent("op"), 0)
            self.assertEqual(calls, [])
            response = await client.post("https://model.invalid/v1/messages", json=body)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["tool_choice"], body["tool_choice"])
        self.assertEqual(calls[0]["max_tokens"], 20)
        self.assertGreater(reserved[0], 0)
        self.assertEqual(ledger.spent("op"), reserved[0])
        ledger.db.close()

if __name__ == "__main__": unittest.main()
