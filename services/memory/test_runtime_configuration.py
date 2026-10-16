"""Exercise real internal HTTP handlers with synthetic credentials and no network/Neo4j writes."""
import asyncio
import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx
from configuration import provider_config
from test_configuration import browser_config


class RuntimeConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"EVOLVED_SERVICE_TOKEN": "synthetic-service-token-" * 2,
            "EVOLVED_MEMORY_STATE": str(Path(self.directory.name) / "operations.db"),
            "NEO4J_PASSWORD": "synthetic-not-connected"}, clear=True)
        self.env.start()
        self.driver = SimpleNamespace(verify_connectivity=AsyncMock(), close=AsyncMock())
        with patch("neo4j.AsyncGraphDatabase.driver", return_value=self.driver):
            spec = importlib.util.spec_from_file_location("runtime_test_app", Path(__file__).with_name("app.py"))
            self.app = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.app)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app.app), base_url="http://test",
            headers={"authorization": "Bearer " + self.app.service_token})

    async def asyncTearDown(self):
        await self.client.aclose()
        self.app.ledger.db.close()
        self.env.stop()
        self.directory.cleanup()

    def operation(self, project="project-a", **changes):
        return {"projects": [{"projectId": project, "generation": 0}], "query": "Synthetic question",
                "operationId": "op-" + project, "budgetMicros": 100000, "providerConfig": browser_config(), **changes}

    def graph(self):
        return SimpleNamespace(build_indices_and_constraints=AsyncMock(), search=AsyncMock(return_value=[]), close=AsyncMock()), SimpleNamespace(aclose=AsyncMock())

    def binding_request(self, project="project-a", **changes):
        return {"projectId": project, "embeddingModel": "text-embedding-3-small", "embeddingDimensions": 1536, **changes}

    def graph_counts(self, nodes=0, relationships=0):
        run = AsyncMock(return_value=SimpleNamespace(single=AsyncMock(return_value={"nodes": nodes, "relationships": relationships})))
        @asynccontextmanager
        async def session():
            yield SimpleNamespace(run=run)
        self.driver.session = session
        return run

    async def test_empty_binding_accepts_failed_and_purged_history_without_changing_receipts(self):
        run = self.graph_counts()
        for state in ["failed", "purged"]:
            self.app.ledger.begin(state, "project-a", 0, "synthetic", 100)
            self.app.ledger.db.execute("UPDATE operations SET status=? WHERE id=?", (state, state))
        before = [dict(row) for row in self.app.ledger.db.execute("SELECT * FROM operations ORDER BY id")]
        response = await self.client.post("/configuration/binding", json=self.binding_request())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"empty": True})
        self.assertEqual([dict(row) for row in self.app.ledger.db.execute("SELECT * FROM operations ORDER BY id")], before)
        self.assertEqual(self.app.ledger.binding("project-a"), ("text-embedding-3-small", 1536))
        pattern = run.call_args.kwargs["pattern"]
        import re
        for group in ["hapi_project_a_0", "hapi_project_a_1", "hapi_project_a_999"]:
            self.assertIsNotNone(re.fullmatch(pattern, group))
        for other in ["hapi_project_ab_0", "hapi_project_a_1_0", "hapi_other_0"]:
            self.assertIsNone(re.fullmatch(pattern, other))

    async def test_existing_nodes_relationships_or_unfinished_operations_prevent_empty_proof(self):
        for nodes, relationships in [(1, 0), (0, 1)]:
            self.graph_counts(nodes, relationships)
            self.assertEqual((await self.client.post("/configuration/binding", json=self.binding_request())).json(), {"empty": False})
        run = self.graph_counts()
        for state in ["running", "indeterminate"]:
            self.app.ledger.begin(state, state, 0, "synthetic", 100)
            self.app.ledger.db.execute("UPDATE operations SET status=? WHERE id=?", (state, state))
            self.assertEqual((await self.client.post("/configuration/binding", json=self.binding_request(state))).json(), {"empty": False})
        run.assert_not_called()

    async def test_binding_validation_auth_and_database_failures_are_closed(self):
        run = self.graph_counts()
        denied = await self.client.post("/configuration/binding", json=self.binding_request(), headers={"authorization": "Bearer wrong"})
        self.assertEqual(denied.status_code, 401)
        for body in [[], {}, {"projectId": ""}, {"projectId": "a_1"}, {"projectId": "a", "generation": 0},
                     self.binding_request(embeddingModel="invalid/model"), self.binding_request(embeddingDimensions=3072)]:
            self.assertEqual((await self.client.post("/configuration/binding", json=body)).status_code, 400)
        run.assert_not_called()
        for error in [RuntimeError("private database diagnostic"), TimeoutError()]:
            run.side_effect = error
            response = await self.client.post("/configuration/binding", json=self.binding_request())
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"error": "Memory graph binding could not be verified"})

    async def test_durable_binding_rejects_late_old_snapshot_but_preserves_existing_receipt(self):
        self.graph_counts()
        with patch.object(self.app, "graph_client", AsyncMock(side_effect=lambda operation, config: self.graph())) as create:
            original = await self.client.post("/search", json=self.operation())
            self.assertEqual(original.status_code, 200)
            claimed = await self.client.post("/configuration/binding", json=self.binding_request(embeddingModel="text-embedding-3-large"))
            self.assertEqual(claimed.json(), {"empty": True})
            # Reopen the durable ledger to prove the binding survives service restart.
            filename = str(Path(self.directory.name) / "operations.db")
            self.app.ledger.db.close()
            self.app.ledger = self.app.OperationLedger(filename)
            self.assertEqual(self.app.ledger.binding("project-a"), ("text-embedding-3-large", 1536))
            replay = await self.client.post("/search", json=self.operation())
            self.assertEqual(replay.json(), original.json())
            late = await self.client.post("/search", json=self.operation(operationId="late-old-snapshot"))
            self.assertEqual(late.status_code, 422)
            self.assertEqual(late.json(), {"error": "Embedding configuration does not match project binding", "spentMicros": 0})
            receipt = await self.client.post("/receipt", json={"operationId": "late-old-snapshot"})
            self.assertEqual(receipt.json(), {"projectId": "project-a", "final": True, "spentMicros": 0})
            create.assert_awaited_once()
            compatible = await self.client.post("/search", json=self.operation(operationId="compatible-snapshot", providerConfig=browser_config(embeddingModel="text-embedding-3-large")))
            self.assertEqual(compatible.status_code, 200)
            self.assertEqual(create.await_count, 2)

    async def test_retry_after_external_save_failure_can_rebind_only_a_still_empty_project(self):
        self.graph_counts()
        first = await self.client.post("/configuration/binding", json=self.binding_request())
        self.assertEqual(first.json(), {"empty": True})
        retry = await self.client.post("/configuration/binding", json=self.binding_request(embeddingModel="text-embedding-3-large"))
        self.assertEqual(retry.json(), {"empty": True})
        self.assertEqual(self.app.ledger.binding("project-a"), ("text-embedding-3-large", 1536))
        self.graph_counts(nodes=1)
        failed = await self.client.post("/configuration/binding", json=self.binding_request())
        self.assertEqual(failed.json(), {"empty": False})
        self.assertEqual(self.app.ledger.binding("project-a"), ("text-embedding-3-large", 1536))

    async def test_binding_detects_new_operation_waiting_behind_its_database_read(self):
        run = self.graph_counts()
        reading, finish_read = asyncio.Event(), asyncio.Event()
        async def blocked_read(*args, **kwargs):
            reading.set()
            await finish_read.wait()
            return SimpleNamespace(single=AsyncMock(return_value={"nodes": 0, "relationships": 0}))
        run.side_effect = blocked_read
        with patch.object(self.app, "graph_client", AsyncMock(side_effect=lambda operation, config: self.graph())) as create:
            binding = asyncio.create_task(self.client.post("/configuration/binding", json=self.binding_request()))
            await asyncio.wait_for(reading.wait(), 1)
            operation = asyncio.create_task(self.client.post("/search", json=self.operation()))
            try:
                for _ in range(100):
                    if "project-a" in self.app.operation_admissions.values(): break
                    await asyncio.sleep(.001)
                self.assertIn("project-a", self.app.operation_admissions.values())
                create.assert_not_called()
            finally:
                finish_read.set()
            self.assertEqual((await binding).json(), {"empty": False})
            self.assertEqual((await operation).status_code, 200)
            self.assertEqual(self.app.operation_admissions, {})

    async def test_binding_rejects_running_project_operation_without_waiting_for_it(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def create(operation, config):
            entered.set()
            await release.wait()
            return self.graph()
        with patch.object(self.app, "graph_client", create):
            operation = asyncio.create_task(self.client.post("/search", json=self.operation()))
            await asyncio.wait_for(entered.wait(), 1)
            try:
                result = await asyncio.wait_for(self.client.post("/configuration/binding", json=self.binding_request()), 1)
                self.assertEqual(result.json(), {"empty": False})
            finally:
                release.set()
            self.assertEqual((await operation).status_code, 200)
        self.assertEqual(self.app.operation_admissions, {})

    async def test_binding_rejects_unknown_scope_until_request_body_finishes_and_cleanup_always_runs(self):
        body_started, finish_body = asyncio.Event(), asyncio.Event()
        async def incomplete_body():
            body_started.set()
            yield b"{"
            await finish_body.wait()
            yield b"invalid-json}"
        request = asyncio.create_task(self.client.post("/search", content=incomplete_body()))
        await asyncio.wait_for(body_started.wait(), 1)
        try:
            response = await self.client.post("/configuration/binding", json=self.binding_request("unknown-project"))
            self.assertEqual(response.json(), {"empty": False})
        finally:
            finish_body.set()
        self.assertEqual((await request).status_code, 503)
        self.assertEqual(self.app.operation_admissions, {})
        async def oversized():
            yield b"x" * 60_000
            yield b"x" * 60_000
        self.assertEqual((await self.client.post("/search", content=oversized())).status_code, 413)
        self.assertEqual(self.app.operation_admissions, {})

    async def test_project_check_needs_only_local_validation_and_database_without_global_models(self):
        with patch.object(self.app, "graph_client", AsyncMock()) as graph, patch.object(self.app, "list_models", AsyncMock()) as catalog:
            response = await self.client.post("/configuration/check", json={"providerConfig": browser_config()})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ok": True, "backend": "graphiti-0.30.2/neo4j"})
            graph.assert_not_called()
            catalog.assert_not_called()
            self.driver.verify_connectivity.assert_awaited_once()
        self.assertEqual((await self.client.get("/health")).status_code, 503)
        self.assertEqual(self.app.ledger.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 0)

    async def test_invalid_configuration_cannot_touch_database_provider_or_operation_ledger(self):
        with patch.object(self.app, "graph_client", AsyncMock()) as graph:
            for supplied in [None, browser_config(apiKey="secret\r\nheader"), browser_config(embeddingDimensions=3072), browser_config(inputUsdPerMTok="NaN"), {**browser_config(), "base": "http://internal"}]:
                check = await self.client.post("/configuration/check", json={"providerConfig": supplied})
                search = await self.client.post("/search", json=self.operation(providerConfig=supplied))
                ingest = await self.client.post("/ingest", json={"projectId": "project-a", "generation": 0,
                    "operationId": "ingest", "budgetMicros": 100, "providerConfig": supplied})
                for response in (check, search, ingest):
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.json(), {"error": "Invalid provider configuration"})
            graph.assert_not_called()
            self.driver.verify_connectivity.assert_not_called()
        self.assertEqual(self.app.ledger.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 0)

    async def test_check_database_error_and_model_errors_do_not_disclose_details(self):
        key = browser_config()["apiKey"]
        self.driver.verify_connectivity.side_effect = RuntimeError(key)
        response = await self.client.post("/configuration/check", json={"providerConfig": browser_config()})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(key, response.text)
        for error, status in [(self.app.ProviderUnauthorized(), 401), (self.app.CatalogUnavailable(), 503)]:
            with patch.object(self.app, "list_models", AsyncMock(side_effect=error)):
                response = await self.client.post("/configuration/models", json={"apiKey": key})
                self.assertEqual(response.status_code, status)
                self.assertNotIn(key, response.text)

    async def test_configuration_routes_require_service_auth_and_exact_body(self):
        for path, body in [("/configuration/check", {"providerConfig": browser_config()}), ("/configuration/models", {"apiKey": browser_config()["apiKey"]})]:
            denied = await self.client.post(path, json=body, headers={"authorization": "Bearer wrong"})
            self.assertEqual(denied.status_code, 401)
            for invalid in [[], None, {}, {**body, "url": "https://private.invalid"}]:
                self.assertEqual((await self.client.post(path, json=invalid)).status_code, 400)
            self.assertEqual((await self.client.post(path, content=b"invalid-json")).status_code, 400)
        with patch.object(self.app, "list_models", AsyncMock(return_value=["model-a", "model-b"])) as catalog:
            response = await self.client.post("/configuration/models", json={"apiKey": browser_config()["apiKey"]})
            self.assertEqual(response.json(), {"models": ["model-a", "model-b"]})
            catalog.assert_awaited_once_with(browser_config()["apiKey"])

    async def test_concurrent_projects_keep_credentials_models_prices_and_budgets_isolated(self):
        environment = dict(os.environ)
        started = []
        ready = asyncio.Event()
        async def create(operation, config):
            started.append((operation, config))
            if len(started) == 2:
                ready.set()
            await ready.wait()
            self.app.ledger.charge(operation, 11 if config.model == "model-a" else 22)
            return self.graph()
        a = browser_config(apiKey="synthetic-private-key-a", model="model-a", inputUsdPerMTok="1")
        b = browser_config(apiKey="synthetic-private-key-b", model="model-b", inputUsdPerMTok="3")
        with patch.object(self.app, "graph_client", create):
            results = await asyncio.wait_for(asyncio.gather(
                self.client.post("/search", json=self.operation("a", providerConfig=a)),
                self.client.post("/search", json=self.operation("b", providerConfig=b))), 3)
        self.assertEqual([r.status_code for r in results], [200, 200])
        self.assertEqual([r.json()["spentMicros"] for r in results], [11, 22])
        received = {op: (config.api_key, config.model, config.input_rate) for op, config in started}
        self.assertEqual(received, {"op-a": (a["apiKey"], "model-a", "1"), "op-b": (b["apiKey"], "model-b", "3")})
        self.assertEqual(dict(os.environ), environment)
        dump = "\n".join(self.app.ledger.db.iterdump())
        for config in (a, b):
            self.assertNotIn(config["apiKey"], dump)
            self.assertNotIn(config["apiKey"], "".join(r.text for r in results))

    async def test_real_sdk_clients_send_their_own_snapshot_credentials_and_account_separately(self):
        configs = [provider_config(browser_config(apiKey="synthetic-sdk-key-a", embeddingUsdPerMTok="1")),
                   provider_config(browser_config(apiKey="synthetic-sdk-key-b", embeddingUsdPerMTok="3"))]
        requests = []
        clients = []
        async def handle(request):
            requests.append((request.headers["authorization"], json.loads(request.content)))
            return httpx.Response(200, json={"object": "list", "model": "text-embedding-3-small",
                "data": [{"object": "embedding", "index": 0, "embedding": [0.0] * 1536}],
                "usage": {"prompt_tokens": 2, "total_tokens": 2}})
        try:
            with patch("graphiti_core.driver.neo4j_driver.Neo4jDriver.build_indices_and_constraints", AsyncMock()):
                for i, config in enumerate(configs):
                    operation = "sdk-" + str(i)
                    self.app.ledger.begin(operation, "project-" + str(i), 0, "synthetic-fingerprint", 100000)
                    graph, http = await self.app.graph_client(operation, config)
                    clients.append((graph, http))
                    await http._transport.inner.aclose()
                    http._transport.inner = httpx.MockTransport(handle)
                    self.assertIs(graph.llm_client.client, graph.embedder.client)
                    self.assertIs(graph.llm_client.client, graph.cross_encoder.client)
                await asyncio.gather(*(graph.embedder.create("synthetic") for graph, _ in clients))
            self.assertEqual({request[0] for request in requests}, {"Bearer " + config.api_key for config in configs})
            self.assertTrue(all(request[1]["dimensions"] == 1536 for request in requests))
            self.assertEqual([self.app.ledger.spent("sdk-" + str(i)) for i in range(2)], [2, 6])
            self.assertNotIn("OPENAI_API_KEY", os.environ)
        finally:
            for graph, http in clients:
                await graph.close()
                await http.aclose()

    async def test_changed_configuration_reuses_receipt_without_reissuing_or_hashing_configuration(self):
        create = AsyncMock(side_effect=lambda operation, config: self.graph())
        hashed = []
        original_hash = self.app.hashlib.sha256
        def capture(data):
            hashed.append(data)
            return original_hash(data)
        first = browser_config()
        rotated = browser_config(apiKey="synthetic-rotated-key-never-sent")
        with patch.object(self.app, "graph_client", create), patch.object(self.app.hashlib, "sha256", capture):
            result = await self.client.post("/search", json=self.operation(providerConfig=first))
            retry = await self.client.post("/search", json=self.operation(providerConfig=rotated))
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json(), retry.json())
            for changed in [browser_config(model="changed-model"), browser_config(inputUsdPerMTok="2"), None]:
                self.assertEqual((await self.client.post("/search", json=self.operation(providerConfig=changed))).json(), result.json())
            self.assertEqual((await self.client.post("/search", json=self.operation(query="Different input"))).status_code, 409)
            create.assert_awaited_once()
        self.assertTrue(hashed)
        self.assertTrue(all(b"providerConfig" not in value for value in hashed))
        for key in [first["apiKey"], rotated["apiKey"]]:
            self.assertTrue(all(key.encode() not in value for value in hashed))
            for filename in Path(self.directory.name).glob("operations.db*"):
                self.assertNotIn(key.encode(), filename.read_bytes())
        receipt = await self.client.post("/receipt", json={"operationId": "op-project-a"})
        self.assertEqual(receipt.json(), {"projectId": "project-a", "final": True, "spentMicros": 0})

    async def test_operator_fallback_works_when_project_config_absent_but_not_when_null(self):
        payload = self.operation()
        del payload["providerConfig"]
        missing = await self.client.post("/search", json=payload)
        self.assertEqual(missing.status_code, 503)
        self.assertEqual(self.app.ledger.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 0)
        env = {"OPENAI_API_KEY": "synthetic-operator-key", "EVOLVED_MEMORY_MODEL": "operator-model",
            "EVOLVED_MEMORY_EMBEDDING_MODEL": "operator-embedding", "EVOLVED_MEMORY_INPUT_USD_PER_MTOK": "1",
            "EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK": "2", "EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK": "0.1"}
        with patch.dict(os.environ, env), patch.object(self.app, "graph_client", AsyncMock(side_effect=lambda operation, config: self.graph())) as graph:
            self.assertEqual((await self.client.post("/search", json=payload)).status_code, 200)
            self.assertEqual(graph.call_args.args[1].api_key, env["OPENAI_API_KEY"])
            self.assertEqual((await self.client.post("/search", json=self.operation("other", providerConfig=None))).status_code, 400)


if __name__ == "__main__": unittest.main()
