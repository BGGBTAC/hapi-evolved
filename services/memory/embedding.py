"""Request exact supported dimensions; never truncate, pad or reorder vectors silently."""
import math
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.embedder.openai import OpenAIEmbedder


def validate_vectors(entries, count, dimensions):
    if not isinstance(entries, list) or len(entries) != count:
        raise ValueError("Embedding batch size does not match input")
    ordered = [None] * count
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("Invalid embedding response")
        index, vector = item.get("index"), item.get("embedding")
        if type(index) is not int or not 0 <= index < count or ordered[index] is not None:
            raise ValueError("Embedding index does not match input")
        if not isinstance(vector, list) or len(vector) != dimensions or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
            raise ValueError("Embedding dimensions or values do not match configuration")
        ordered[index] = vector
    return ordered


class ConfiguredOpenAIEmbedder(OpenAIEmbedder):
    async def _embed(self, input_data):
        options = {"input": input_data, "model": self.config.embedding_model, "encoding_format": "float"}
        if self.config.embedding_model.startswith("text-embedding-3-"):
            options["dimensions"] = self.config.embedding_dim
        result = await self.client.embeddings.create(**options)
        count = 1 if isinstance(input_data, str) else len(input_data)
        return validate_vectors([{"index": item.index, "embedding": item.embedding} for item in result.data], count, self.config.embedding_dim)

    async def create(self, input_data):
        return (await self._embed(input_data))[0]

    async def create_batch(self, input_data_list):
        return await self._embed(input_data_list)


class ConfiguredVoyageEmbedder(EmbedderClient):
    def __init__(self, config, client):
        self.config, self.client = config, client

    async def _embed(self, inputs):
        if not isinstance(inputs, list) or not inputs or not all(isinstance(item, str) for item in inputs):
            raise ValueError("Only text embeddings are supported")
        response = await self.client.post("embeddings", json={"model": self.config.model, "input": inputs,
            "output_dimension": self.config.dimensions, "output_dtype": "float", "truncation": False})
        if not response.is_success:
            raise ValueError("Embedding request failed")
        return validate_vectors(response.json().get("data"), len(inputs), self.config.dimensions)

    async def create(self, input_data):
        inputs = [input_data] if isinstance(input_data, str) else input_data
        if not isinstance(inputs, list) or len(inputs) != 1:
            raise ValueError("Only a single text embedding is supported")
        return (await self._embed(inputs))[0]

    async def create_batch(self, input_data_list):
        return await self._embed(input_data_list)
