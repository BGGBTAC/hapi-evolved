"""Graphiti adapters with explicit clients, no hidden provider selection or retries."""
import math
from graphiti_core.llm_client.client import LLMClient, get_extraction_language_instruction
from graphiti_core.llm_client.config import ModelSize
from graphiti_core.cross_encoder.client import CrossEncoderClient
from transport import SCHEMA_TOOL


class AnthropicSchemaClient(LLMClient):
    def __init__(self, config, client):
        super().__init__(config, cache=False)
        self.client = client

    async def _generate_response(self, messages, response_model=None, max_tokens=None, model_size=ModelSize.medium):
        schema = response_model.model_json_schema() if response_model else {"type": "object", "additionalProperties": True}
        response = await self.client.post("messages", json={"model": self.model,
            "system": messages[0].content, "messages": [{"role": message.role, "content": message.content} for message in messages[1:]],
            "max_tokens": max_tokens or self.max_tokens,
            "tools": [{"name": SCHEMA_TOOL, "description": "Return the extracted structured data", "input_schema": schema}],
            "tool_choice": {"type": "tool", "name": SCHEMA_TOOL}})
        if not response.is_success:
            raise ValueError("Model extraction failed")
        result = response.json()
        if result.get("stop_reason") != "tool_use":
            raise ValueError("Incomplete structured model response")
        content = result.get("content")
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict) or content[0].get("type") != "tool_use" or content[0].get("name") != SCHEMA_TOOL or not isinstance(content[0].get("input"), dict):
            raise ValueError("Invalid structured model response")
        value = content[0]["input"]
        return response_model.model_validate(value).model_dump() if response_model else value

    async def generate_response(self, messages, response_model=None, max_tokens=None, model_size=ModelSize.medium,
            group_id=None, prompt_name=None, *, attribute_extraction=False):
        # Bypass Graphiti's retry loop, error-to-prompt feedback, raw-output logs and
        # disk cache. Each call is a single operation-local budgeted request.
        copied = [message.model_copy(deep=True) for message in messages]
        self._apply_attribute_extraction_preamble(copied, attribute_extraction)
        copied[0].content += get_extraction_language_instruction(group_id)
        return await self._generate_response(copied, response_model, max_tokens, model_size)


class LocalRRFClient(CrossEncoderClient):
    async def rank(self, query, passages):
        # RRF is performed inside Graphiti's search algorithm, never by a model.
        raise ValueError("Cross-encoder call is not enabled for local RRF")


class VoyageReranker(CrossEncoderClient):
    def __init__(self, config, client):
        self.config, self.client = config, client

    async def rank(self, query, passages):
        if not passages:
            return []
        response = await self.client.post("rerank", json={"model": self.config.model, "query": query,
            "documents": passages, "truncation": False, "return_documents": False})
        if not response.is_success:
            raise ValueError("Reranking failed")
        entries = response.json().get("data")
        if not isinstance(entries, list) or len(entries) != len(passages):
            raise ValueError("Invalid reranking result")
        seen, ranked = set(), []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Invalid reranking result")
            index, score = entry.get("index"), entry.get("relevance_score")
            if type(index) is not int or not 0 <= index < len(passages) or index in seen or type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid reranking result")
            seen.add(index)
            ranked.append((passages[index], score))
        return sorted(ranked, key=lambda item: item[1], reverse=True)
