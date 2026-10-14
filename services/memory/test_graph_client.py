"""Construct the real pinned SDK without a provider call or production credentials."""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

class GraphClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_model_client_uses_the_same_budget_transport_with_file_credentials(self):
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
                graph, http = await module.graph_client("test-operation")
                try:
                    from transport import BudgetTransport
                    self.assertIsInstance(http._transport, BudgetTransport)
                    self.assertIs(graph.llm_client.client, graph.embedder.client)
                    self.assertIs(graph.llm_client.client, graph.cross_encoder.client)
                finally:
                    await graph.close()
                    await http.aclose()
                    await module.driver.close()
                    module.ledger.db.close()

if __name__ == "__main__": unittest.main()
