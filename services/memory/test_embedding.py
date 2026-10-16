import json
import unittest
import httpx
from openai import AsyncOpenAI
from graphiti_core.embedder.openai import OpenAIEmbedderConfig
from embedding import ConfiguredOpenAIEmbedder


class EmbeddingTests(unittest.IsolatedAsyncioTestCase):
    async def embed(self, model, vectors, batch=False):
        requests = []
        def handle(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={"object": "list", "model": model,
                "data": [{"object": "embedding", "index": i, "embedding": vector} for i, vector in enumerate(vectors)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
            client = AsyncOpenAI(api_key="synthetic-key-never-sent", base_url="https://provider.invalid/v1", http_client=http, max_retries=0)
            embedder = ConfiguredOpenAIEmbedder(config=OpenAIEmbedderConfig(embedding_model=model, embedding_dim=1536), client=client)
            result = await embedder.create_batch(["a", "b"]) if batch else await embedder.create("a")
        return result, requests

    async def test_third_generation_models_request_exact_dimensions_instead_of_slicing(self):
        for model in ["text-embedding-3-small", "text-embedding-3-large"]:
            result, requests = await self.embed(model, [[1.0] + [0.0] * 1535])
            self.assertEqual(len(result), 1536)
            self.assertEqual(requests[0]["dimensions"], 1536)
            self.assertEqual(requests[0]["encoding_format"], "float")

    async def test_older_model_receives_no_unsupported_dimension_parameter(self):
        result, requests = await self.embed("text-embedding-ada-002", [[0.0] * 1536])
        self.assertEqual(len(result), 1536)
        self.assertNotIn("dimensions", requests[0])

    async def test_wrong_dimensions_are_rejected_not_truncated_or_padded(self):
        for dimensions in [0, 1024, 3072]:
            with self.assertRaisesRegex(ValueError, "Embedding dimensions"):
                await self.embed("text-embedding-3-large", [[0.0] * dimensions])
        with self.assertRaisesRegex(ValueError, "Embedding batch size"):
            await self.embed("text-embedding-3-small", [[0.0] * 1536], batch=True)

    async def test_batch_keeps_all_vectors(self):
        result, requests = await self.embed("text-embedding-3-small", [[0.0] * 1536, [1.0] * 1536], batch=True)
        self.assertEqual([len(vector) for vector in result], [1536, 1536])
        self.assertEqual(requests[0]["input"], ["a", "b"])


if __name__ == "__main__": unittest.main()
