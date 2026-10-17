"""Graphiti adapters with explicit clients, no hidden provider selection or retries."""
import math
from pydantic import ValidationError
from graphiti_core.llm_client.client import LLMClient, get_extraction_language_instruction
from graphiti_core.llm_client.config import ModelSize
from graphiti_core.cross_encoder.client import CrossEncoderClient
from transport import SCHEMA_TOOL


class ProviderExtractionError(ValueError):
    """Only fixed diagnostic codes and an HTTP status may leave the provider adapter."""
    def __init__(self, code, status_code=None):
        if not isinstance(code, str) or code not in {"anthropic_http_error", "anthropic_output_truncated", "anthropic_invalid_response"}:
            raise ValueError("Invalid extraction diagnostic")
        if status_code is not None and (code != "anthropic_http_error" or type(status_code) is not int or not 300 <= status_code <= 599):
            raise ValueError("Invalid extraction diagnostic")
        self.code, self.status_code = code, status_code
        super().__init__(code)


class AnthropicSchemaClient(LLMClient):
    def __init__(self, config, client):
        super().__init__(config, cache=False)
        self.client = client

    async def _generate_response(self, messages, response_model=None, max_tokens=None, model_size=ModelSize.medium):
        schema = response_model.model_json_schema() if response_model else {"type": "object", "additionalProperties": True}
        response = await self.client.post("messages", json={"model": self.model,
            "system": messages[0].content + f"\n\nReturn the complete structured extraction by calling {SCHEMA_TOOL} exactly once. Use its schema for all output. Do not add explanatory text before or after the tool call, or answer with prose instead of calling the tool.",
            "messages": [{"role": message.role, "content": message.content} for message in messages[1:]],
            "max_tokens": max_tokens or self.max_tokens,
            "tools": [{"name": SCHEMA_TOOL, "description": "Return the extracted structured data", "input_schema": schema}],
            # Forced tool selection is unsupported by some current Claude models.
            # Auto plus one internal tool works without a model-name allowlist.
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": True}})
        if not response.is_success:
            raise ProviderExtractionError("anthropic_http_error", response.status_code)
        try:
            result = response.json()
        except ValueError:
            raise ProviderExtractionError("anthropic_invalid_response") from None
        if not isinstance(result, dict):
            raise ProviderExtractionError("anthropic_invalid_response")
        if result.get("stop_reason") == "max_tokens":
            raise ProviderExtractionError("anthropic_output_truncated")
        if result.get("stop_reason") != "tool_use":
            raise ProviderExtractionError("anthropic_invalid_response")
        content = result.get("content")
        if not isinstance(content, list) or any(not isinstance(block, dict) or not isinstance(block.get("type"), str) or block["type"] not in
                {"text", "thinking", "redacted_thinking", "tool_use"} for block in content):
            raise ProviderExtractionError("anthropic_invalid_response")
        tools = [block for block in content if block["type"] == "tool_use"]
        if len(tools) != 1 or tools[0].get("name") != SCHEMA_TOOL or not isinstance(tools[0].get("input"), dict):
            raise ProviderExtractionError("anthropic_invalid_response")
        value = tools[0]["input"]
        try:
            return response_model.model_validate(value).model_dump() if response_model else value
        except ValidationError:
            raise ProviderExtractionError("anthropic_invalid_response") from None

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
