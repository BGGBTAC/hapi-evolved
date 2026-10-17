"""Construct the real pinned SDK without a provider call or production credentials."""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

class GraphClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_model_client_uses_an_independent_budget_transport_with_file_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "provider.key"
            key.write_text("synthetic-test-key-never-sent")
            config = {"EVOLVED_SERVICE_TOKEN": "test-token-" * 4,
                "EVOLVED_MEMORY_STATE": str(Path(directory) / "operations.db"),
                "OPENAI_API_KEY_FILE": str(key), "EVOLVED_MEMORY_MODEL": "synthetic-test-model",
                "EVOLVED_MEMORY_EMBEDDING_MODEL": "synthetic-test-embedding",
                "EVOLVED_MEMORY_INPUT_USD_PER_MTOK": "1", "EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK": "2",
                "EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK": "0.1", "NEO4J_PASSWORD": "synthetic-not-connected"}
            with patch.dict(os.environ, config):
                os.environ.pop("OPENAI_API_KEY", None)
                module = importlib.import_module("app")
                with patch("graphiti_core.driver.neo4j_driver.Neo4jDriver.build_indices_and_constraints", AsyncMock()):
                    graph, http = await module.graph_client("test-operation")
                try:
                    from transport import BudgetTransport
                    self.assertEqual(len(http.clients), 2)
                    self.assertTrue(all(isinstance(client._transport, BudgetTransport) for client in http.clients))
                    self.assertIsNot(graph.llm_client.client, graph.embedder.client)
                    self.assertEqual(http.clients[0].timeout.as_dict(), {"connect": 40, "read": 600, "write": 40, "pool": 40})
                    self.assertEqual(http.clients[1].timeout.as_dict(), {"connect": 40, "read": 40, "write": 40, "pool": 40})
                    self.assertEqual(graph.llm_client.client.max_retries, 0)
                    from providers import LocalRRFClient
                    self.assertIsInstance(graph.cross_encoder, LocalRRFClient)
                finally:
                    await http.aclose()
                    await module.driver.close()
                    module.ledger.db.close()

if __name__ == "__main__": unittest.main()
