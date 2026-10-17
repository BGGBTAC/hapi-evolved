"""Real Graphiti interfaces over mocked, budgeted provider HTTP; no live API calls."""
import json
import traceback
import unittest
from unittest.mock import patch
import httpx
from pydantic import BaseModel
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.prompts.models import Message
from graphiti_core.nodes import EntityNode
from budget import OperationLedger, BudgetExceeded
from configuration import provider_config
from embedding import ConfiguredVoyageEmbedder, validate_vectors
from providers import AnthropicSchemaClient, ProviderExtractionError, VoyageReranker, LocalRRFClient
from test_configuration import browser_config
from transport import BudgetTransport, SCHEMA_TOOL


def mixed_config():
    value = browser_config()
    value["llm"].update(provider="anthropic", apiKey="synthetic-anthropic-key", model="claude-synthetic")
    value["embedding"].update(provider="voyage", apiKey="synthetic-voyage-embedding-key", model="voyage-4", dimensions=256, inputUsdPerMTok="3")
    value["reranker"] = {"provider": "voyage", "apiKey": "synthetic-voyage-reranking-key", "model": "rerank-3", "inputUsdPerMTok": "4"}
    return value


class Extraction(BaseModel):
    value: str


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ledger = OperationLedger(":memory:")
        self.ledger.begin("op", "project", 0, "fingerprint", 1_000_000)
        self.config = provider_config(mixed_config())
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.aclose()
        self.ledger.db.close()

    async def client(self, role, handler):
        transport = BudgetTransport(self.ledger, "op", role.transport_config())
        await transport.inner.aclose()
        transport.inner = httpx.MockTransport(handler)
        client = httpx.AsyncClient(base_url=role.base + "/", transport=transport)
        self.clients.append(client)
        return client

    def anthropic_body(self, **changes):
        return {"model": "claude-synthetic", "system": "system text", "messages": [{"role": "user", "content": "data"}],
            "max_tokens": 4096, "tools": [{"name": SCHEMA_TOOL, "description": "Schema", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": True}, **changes}

    async def test_anthropic_schema_call_caps_output_and_accounts_native_usage_without_retries(self):
        calls = []
        def handle(request):
            body = json.loads(request.content)
            calls.append(body)
            self.assertGreater(self.ledger.spent("op"), len(request.content))
            return httpx.Response(200, json={"id": "msg_synthetic", "type": "message", "role": "assistant",
                "model": "claude-synthetic", "stop_reason": "tool_use", "stop_sequence": None,
                "content": [{"type": "tool_use", "id": "toolu_synthetic", "name": SCHEMA_TOOL, "input": {"value": "extracted"}}],
                "usage": {"input_tokens": 7, "output_tokens": 4, "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0, "server_tool_use": None}})
        http = await self.client(self.config.llm, handle)
        llm = AnthropicSchemaClient(LLMConfig(model="claude-synthetic", small_model="claude-synthetic", max_tokens=2048), http)
        messages = [Message(role="system", content="Extract"), Message(role="user", content="Quoted data")]
        result = await llm.generate_response(messages, Extraction, max_tokens=50000, attribute_extraction=True)
        self.assertEqual(result, {"value": "extracted"})
        self.assertEqual(self.ledger.spent("op"), 15)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["max_tokens"], 2048)
        self.assertEqual(calls[0]["tools"][0]["input_schema"], Extraction.model_json_schema())
        self.assertEqual(calls[0]["tool_choice"], {"type": "auto", "disable_parallel_tool_use": True})
        self.assertIn("calling graphiti_output exactly once", calls[0]["system"])
        self.assertNotIn("store", calls[0])
        self.assertEqual(messages[0].content, "Extract")

    async def test_auto_tool_choice_supports_nonempty_real_graphiti_schema_and_ignores_companion_blocks(self):
        from graphiti_core.prompts.extract_nodes import ExtractedEntities
        calls = []
        value = {"extracted_entities": [{"name": "Synthetic Project", "entity_type_id": 0, "episode_indices": [0]}]}
        def handle(request):
            body = json.loads(request.content)
            calls.append(body)
            # Reproduce the provider contract that rejects forced selection. This
            # test does not encode a model name or send a request to a provider.
            if body["tool_choice"]["type"] in ("tool", "any"):
                return httpx.Response(400, json={"error": {"message": "synthetic forced-tool rejection"}})
            return httpx.Response(200, json={"stop_reason": "tool_use", "content": [
                {"type": "thinking", "thinking": "synthetic-private-thinking", "signature": "synthetic-signature"},
                {"type": "text", "text": "synthetic-private-text"},
                {"type": "tool_use", "name": SCHEMA_TOOL, "input": value},
                {"type": "redacted_thinking", "data": "synthetic-private-redacted"}],
                "usage": {"input_tokens": 7, "output_tokens": 4}})
        http = await self.client(self.config.llm, handle)
        llm = AnthropicSchemaClient(LLMConfig(model="claude-synthetic", max_tokens=2048), http)
        result = await llm.generate_response([Message(role="system", content="Extract"), Message(role="user", content="Synthetic episode")], ExtractedEntities)
        self.assertEqual(result, value)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.ledger.spent("op"), 15)
        self.assertNotIn("synthetic-private", json.dumps(result))

    async def test_anthropic_invalid_structured_results_fail_once_without_private_diagnostics(self):
        tool = {"type": "tool_use", "name": SCHEMA_TOOL, "input": {"value": "synthetic-valid"}}
        variants = [
            None, [], {}, {"stop_reason": "tool_use", "content": None},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "synthetic-private-canary"}]},
            {"stop_reason": "tool_use", "content": []},
            {"stop_reason": "tool_use", "content": [tool, tool]},
            {"stop_reason": "tool_use", "content": [tool, {**tool, "name": "other"}]},
            {"stop_reason": "tool_use", "content": [{**tool, "name": "other"}]},
            {"stop_reason": "tool_use", "content": ["synthetic-private-canary"]},
            {"stop_reason": "tool_use", "content": [tool, {"type": ["synthetic-private-canary"]}]},
            {"stop_reason": "tool_use", "content": [tool, {"type": "server_tool_use", "input": "synthetic-private-canary"}]},
            {"stop_reason": "tool_use", "content": [{**tool, "input": "synthetic-private-canary"}]},
            {"stop_reason": "tool_use", "content": [{**tool, "input": {"value": ["synthetic-private-canary"]}}]},
        ]
        for value in variants:
            calls = []
            # Direct adapter responses exercise parser failures independently of
            # the transport's mandatory usage validation and accounting.
            def handle(request):
                calls.append(request)
                return httpx.Response(200, content=json.dumps(value))
            async with httpx.AsyncClient(base_url=self.config.llm.base + "/", transport=httpx.MockTransport(handle)) as http:
                llm = AnthropicSchemaClient(LLMConfig(model="claude-synthetic", max_tokens=2048), http)
                with self.assertRaises(ProviderExtractionError) as caught:
                    await llm.generate_response([Message(role="system", content="Extract"), Message(role="user", content="data")], Extraction)
            self.assertEqual(caught.exception.code, "anthropic_invalid_response")
            self.assertIsNone(caught.exception.status_code)
            self.assertNotIn("synthetic-private-canary", ''.join(traceback.format_exception(caught.exception)))
            self.assertEqual(len(calls), 1)

    def test_provider_diagnostic_constructor_never_accepts_arbitrary_fields(self):
        for code, status in [("synthetic-private-code", None), ([], None), (None, None),
                ("anthropic_http_error", "synthetic-private-status"), ("anthropic_http_error", True),
                ("anthropic_http_error", 299), ("anthropic_http_error", 600), ("anthropic_invalid_response", 400)]:
            with self.assertRaises(ValueError) as caught:
                ProviderExtractionError(code, status)
            self.assertEqual(str(caught.exception), "Invalid extraction diagnostic")

    async def test_anthropic_truncated_output_fails_even_when_partial_object_parses(self):
        http = await self.client(self.config.llm, lambda _: httpx.Response(200, json={"stop_reason": "max_tokens",
            "content": [{"type": "tool_use", "name": SCHEMA_TOOL, "input": {"value": "partial"}}],
            "usage": {"input_tokens": 1, "output_tokens": 2}}))
        llm = AnthropicSchemaClient(LLMConfig(model="claude-synthetic", max_tokens=2048), http)
        with self.assertRaises(ProviderExtractionError) as caught:
            await llm.generate_response([Message(role="system", content="Extract"), Message(role="user", content="data")], Extraction)
        self.assertEqual(caught.exception.code, "anthropic_output_truncated")
        self.assertIsNone(caught.exception.status_code)
        self.assertEqual(self.ledger.spent("op"), 5)

    async def test_anthropic_error_response_is_not_retried_or_reflected_into_prompt(self):
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(500, text="private upstream diagnostic")
        http = await self.client(self.config.llm, handle)
        llm = AnthropicSchemaClient(LLMConfig(model="claude-synthetic", max_tokens=2048), http)
        with self.assertRaises(ProviderExtractionError) as caught:
            await llm.generate_response([Message(role="system", content="Extract"), Message(role="user", content="data")])
        self.assertEqual(caught.exception.code, "anthropic_http_error")
        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual(str(caught.exception), "anthropic_http_error")
        self.assertNotIn("private upstream diagnostic", ''.join(traceback.format_exception(caught.exception)))
        self.assertEqual(len(calls), 1)
        self.assertGreater(self.ledger.spent("op"), 0)

    async def test_anthropic_rejects_server_tools_cache_thinking_and_nontext_before_charge(self):
        http = await self.client(self.config.llm, lambda _: self.fail("Network forbidden"))
        variants = [self.anthropic_body(thinking={"type": "enabled", "budget_tokens": 1000}),
            self.anthropic_body(cache_control={"type": "ephemeral"}),
            self.anthropic_body(tools=[{"type": "web_search_20250305", "name": "web_search"}]),
            self.anthropic_body(messages=[{"role": "user", "content": [{"type": "image", "source": {}}]}]),
            self.anthropic_body(tool_choice={"type": "auto"}),
            self.anthropic_body(tool_choice={"type": "tool", "name": SCHEMA_TOOL}),
            self.anthropic_body(tool_choice={"type": "any"}),
            self.anthropic_body(tool_choice={"type": "auto", "disable_parallel_tool_use": False}),
            self.anthropic_body(tool_choice={"type": "auto", "disable_parallel_tool_use": 1})]
        for body in variants:
            with self.assertRaises(ValueError):
                await http.post("messages", json=body)
        self.assertEqual(self.ledger.spent("op"), 0)

    async def test_all_provider_roles_block_insufficient_budget_before_network(self):
        self.ledger.db.execute("UPDATE operations SET budget=1")
        bodies = [(self.config.llm, "messages", self.anthropic_body()),
            (self.config.embedding, "embeddings", {"model": "voyage-4", "input": ["data"], "output_dimension": 256, "output_dtype": "float", "truncation": False}),
            (self.config.reranker, "rerank", {"model": "rerank-3", "query": "q", "documents": ["d"], "truncation": False, "return_documents": False})]
        for role, path, body in bodies:
            http = await self.client(role, lambda _: self.fail("Network forbidden"))
            with self.assertRaises(BudgetExceeded):
                await http.post(path, json=body)
        self.assertEqual(self.ledger.spent("op"), 0)

    async def test_missing_negative_fractional_bool_or_cache_usage_keeps_reservation(self):
        invalid = [{}, {"input_tokens": -1, "output_tokens": 1}, {"input_tokens": True, "output_tokens": 1},
            {"input_tokens": 1.5, "output_tokens": 1}, {"input_tokens": 1},
            {"input_tokens": 1, "output_tokens": 1, "cache_creation_input_tokens": 1}]
        for usage in invalid:
            self.ledger.db.execute("UPDATE operations SET spent=0")
            http = await self.client(self.config.llm, lambda _, value=usage: httpx.Response(200, json={"usage": value}))
            with self.assertRaises(BudgetExceeded):
                await http.post("messages", json=self.anthropic_body())
            self.assertGreater(self.ledger.spent("op"), 0)

    async def test_voyage_exact_dimensions_and_graphiti_singleton_interface(self):
        calls = []
        def handle(request):
            body = json.loads(request.content)
            calls.append(body)
            return httpx.Response(200, json={"data": [{"index": index, "embedding": [float(index)] * 256} for index in reversed(range(len(body["input"])))], "usage": {"total_tokens": 2}})
        http = await self.client(self.config.embedding, handle)
        embedder = ConfiguredVoyageEmbedder(self.config.embedding, http)
        # This real Graphiti method invokes create(input_data=[text]).
        node = EntityNode(name="Synthetic", group_id="project")
        await node.generate_name_embedding(embedder)
        self.assertEqual(len(node.name_embedding), 256)
        self.assertEqual(await embedder.create_batch(["first", "second"]), [[0.0] * 256, [1.0] * 256])
        self.assertEqual(self.ledger.spent("op"), 12)
        self.assertTrue(all(call["output_dimension"] == 256 and call["truncation"] is False and "input_type" not in call for call in calls))

    async def test_vectors_reject_invalid_or_duplicate_indices_values_and_dimensions(self):
        for entries in [[{"index": 0, "embedding": [0.0]}, {"index": 0, "embedding": [0.0]}],
            [{"index": 2, "embedding": [0.0]}], [{"index": True, "embedding": [0.0]}],
            [{"index": 0, "embedding": [float("nan")]}], [{"index": 0, "embedding": [True]}]]:
            with self.assertRaises(ValueError):
                validate_vectors(entries, len(entries), 1)

    async def test_voyage_reranker_reserves_repeated_query_and_reconciles_total_tokens(self):
        query, passages = "long query " * 1000, ["first", "second", "third"]
        reservations = []
        def handle(request):
            reservations.append(self.ledger.spent("op"))
            self.assertGreater(reservations[0], len(query.encode()) * len(passages) * 4)
            return httpx.Response(200, json={"data": [{"index": 1, "relevance_score": 0.9}, {"index": 2, "relevance_score": 0.5}, {"index": 0, "relevance_score": 0.1}], "usage": {"total_tokens": 123}})
        http = await self.client(self.config.reranker, handle)
        result = await VoyageReranker(self.config.reranker, http).rank(query, passages)
        self.assertEqual(result, [("second", 0.9), ("third", 0.5), ("first", 0.1)])
        self.assertEqual(self.ledger.spent("op"), 492)

    async def test_voyage_reranker_rejects_missing_duplicate_out_of_range_nonfinite_scores(self):
        for data in [[], [{"index": 0, "relevance_score": float("nan")}], [{"index": 1, "relevance_score": 0.5}], [{"index": 0, "relevance_score": True}]]:
            http = await self.client(self.config.reranker, lambda _, value=data: httpx.Response(200, content=json.dumps({"data": value, "usage": {"total_tokens": 1}}).encode()))
            with self.assertRaises(ValueError):
                await VoyageReranker(self.config.reranker, http).rank("q", ["d"])

    async def test_local_rrf_sentinel_never_falls_back_to_provider(self):
        with self.assertRaisesRegex(ValueError, "not enabled"):
            await LocalRRFClient().rank("q", ["d"])

    async def test_response_size_is_bounded_and_stream_closed_without_refunding(self):
        class Oversized(httpx.AsyncByteStream):
            closed = False
            async def __aiter__(self):
                yield b"x" * 80
                yield b"x" * 80
            async def aclose(self):
                self.closed = True
        stream = Oversized()
        http = await self.client(self.config.llm, lambda _: httpx.Response(200, stream=stream))
        with patch("transport.MAX_RESPONSE_BYTES", 100), self.assertRaises(BudgetExceeded):
            await http.post("messages", json=self.anthropic_body())
        self.assertTrue(stream.closed)
        self.assertGreater(self.ledger.spent("op"), 0)

    async def test_compressed_or_declared_oversized_response_is_rejected_before_reading(self):
        class Unread(httpx.AsyncByteStream):
            async def __aiter__(self):
                raise AssertionError("Must not consume invalid response")
                yield b""
        for headers in ({"content-length": "999999999"}, {"content-encoding": "gzip"}, {"content-length": "invalid"}):
            http = await self.client(self.config.llm, lambda _, value=headers: httpx.Response(200, headers=value, stream=Unread()))
            with self.assertRaises(BudgetExceeded):
                await http.post("messages", json=self.anthropic_body())
        self.assertGreater(self.ledger.spent("op"), 0)
