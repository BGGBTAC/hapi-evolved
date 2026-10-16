"""Graphiti 0.30.2 truncates vectors locally; request supported dimensions explicitly."""
import math
from graphiti_core.embedder.openai import OpenAIEmbedder


class ConfiguredOpenAIEmbedder(OpenAIEmbedder):
    async def _embed(self, input_data):
        options = {"input": input_data, "model": self.config.embedding_model, "encoding_format": "float"}
        # OpenAI's third-generation models support server-side dimension reduction.
        # Older/operator models must return the configured size without truncation.
        if self.config.embedding_model.startswith("text-embedding-3-"):
            options["dimensions"] = self.config.embedding_dim
        result = await self.client.embeddings.create(**options)
        vectors = [item.embedding for item in result.data]
        if not vectors or any(len(vector) != self.config.embedding_dim
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector)
                for vector in vectors):
            raise ValueError("Embedding dimensions or values do not match configuration")
        return vectors

    async def create(self, input_data):
        return (await self._embed(input_data))[0]

    async def create_batch(self, input_data_list):
        vectors = await self._embed(input_data_list)
        if len(vectors) != len(input_data_list):
            raise ValueError("Embedding batch size does not match input")
        return vectors
