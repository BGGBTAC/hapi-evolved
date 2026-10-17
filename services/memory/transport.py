"""Role-specific provider allowlists and conservative durable prepayment."""
import json
from types import MappingProxyType
import httpx
from budget import OperationLedger, micros, BudgetExceeded

MAX_RESPONSE_BYTES = 16 * 1024 * 1024
SCHEMA_TOOL = "graphiti_output"


def token_count(value):
    if type(value) is not int or not 0 <= value <= 1_000_000_000:
        raise BudgetExceeded("Model response did not include valid token usage")
    return value


def text_messages(value):
    return isinstance(value, list) and bool(value) and all(isinstance(message, dict)
        and set(message) == {"role", "content"} and message["role"] in ("system", "user", "assistant")
        and isinstance(message["content"], str) for message in value)


class BudgetTransport(httpx.AsyncBaseTransport):
    def __init__(self, ledger: OperationLedger, operation: str, config: dict):
        self.ledger = ledger
        self.operation = operation
        self.config = MappingProxyType(dict(config))
        self.base = httpx.URL(config["base"])
        self.inner = httpx.AsyncHTTPTransport(retries=0)

    def prepare(self, request):
        provider, role = self.config["provider"], self.config["role"]
        endpoint = request.url.path.removeprefix(self.base.path.rstrip("/"))
        allowed = ({"/embeddings"} if role == "embedding" else {"/messages"} if provider == "anthropic"
            else {"/rerank"} if provider == "voyage" else {"/chat/completions", "/responses"})
        if (request.method != "POST" or request.url.host != self.base.host or request.url.port != self.base.port
                or request.url.scheme != "https" or request.url.query or request.url.userinfo
                or endpoint not in allowed or request.url.path != self.base.path.rstrip("/") + endpoint):
            raise ValueError("Model endpoint not allowed")
        body = json.loads(request.content)
        if not isinstance(body, dict) or body.get("model") != self.config["model"] or body.get("stream") or body.get("n", 1) != 1:
            raise ValueError("Model configuration is not allowed")
        output = 0
        if role == "embedding":
            dimension_key = "output_dimension" if provider == "voyage" else "dimensions"
            fields = {"model", "input", dimension_key, "output_dtype", "truncation"} if provider == "voyage" else {"model", "input", dimension_key, "encoding_format"}
            inputs = body.get("input")
            if set(body) - fields or not (isinstance(inputs, str) or isinstance(inputs, list) and all(isinstance(item, str) for item in inputs)):
                raise ValueError("Only text embeddings are allowed")
            if dimension_key in body and (type(body[dimension_key]) is not int or body[dimension_key] != self.config["dimensions"]):
                raise ValueError("Embedding dimensions are not allowed")
            if provider == "voyage" and (body.get("output_dtype") != "float" or body.get("truncation") is not False):
                raise ValueError("Embedding output configuration is not allowed")
        elif provider == "voyage":
            if set(body) != {"model", "query", "documents", "truncation", "return_documents"} or not isinstance(body["query"], str) or not isinstance(body["documents"], list) or not 1 <= len(body["documents"]) <= 1000 or not all(isinstance(item, str) for item in body["documents"]) or body["truncation"] is not False or body["return_documents"] is not False:
                raise ValueError("Reranking configuration is not allowed")
        else:
            if provider == "anthropic":
                if set(body) != {"model", "messages", "system", "max_tokens", "tools", "tool_choice"} or not text_messages(body["messages"]) or not isinstance(body["system"], str):
                    raise ValueError("Only schema extraction is allowed")
                tools = body["tools"]
                if not isinstance(tools, list) or len(tools) != 1 or not isinstance(tools[0], dict) or set(tools[0]) != {"name", "description", "input_schema"} or tools[0]["name"] != SCHEMA_TOOL or not isinstance(tools[0]["input_schema"], dict) or tools[0]["input_schema"].get("type") != "object" or body["tool_choice"] != {"type": "auto", "disable_parallel_tool_use": True} or body["tool_choice"].get("disable_parallel_tool_use") is not True:
                    raise ValueError("Only the internal schema tool is allowed")
                output_key = "max_tokens"
            else:
                if body.get("tools") or any(key in body for key in ("audio", "modalities", "web_search_options", "background", "previous_response_id", "conversation")):
                    raise ValueError("External model tools and state are not allowed")
                if (endpoint == "/chat/completions" and not text_messages(body.get("messages")) or endpoint == "/responses" and not (isinstance(body.get("input"), str) or text_messages(body.get("input")))):
                    raise ValueError("Only text completions are allowed")
                body["store"] = False
                output_key = "max_output_tokens" if endpoint == "/responses" else "max_completion_tokens"
            requested = body.get("max_tokens", body.get("max_completion_tokens", body.get("max_output_tokens", self.config["max_output_tokens"])))
            if type(requested) is not int or requested < 1:
                raise ValueError("Invalid output limit")
            output = min(requested, self.config["max_output_tokens"])
            for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
                body.pop(key, None)
            body[output_key] = output
        serialized = json.dumps(body, ensure_ascii=False).encode()
        # Text UTF-8 bytes bound tokens; include serialized schemas/protocol framing.
        input_bound = len(serialized) + 4096
        if provider == "voyage" and role == "reranker":
            input_bound += len(body["query"].encode()) * (len(body["documents"]) - 1) + 4096 * len(body["documents"])
        reserved = micros(input_bound, self.config["input_rate"]) + micros(output, self.config["output_rate"])
        return serialized, reserved, endpoint

    async def handle_async_request(self, request):
        serialized, reserved, endpoint = self.prepare(request)
        self.ledger.charge(self.operation, reserved)
        headers = dict(request.headers)
        headers.pop("content-length", None)
        headers["accept-encoding"] = "identity"
        forwarded = httpx.Request(request.method, request.url, headers=headers, content=serialized, extensions=request.extensions)
        response = await self.inner.handle_async_request(forwarded)
        try:
            declared = response.headers.get("content-length")
            if response.headers.get("content-encoding", "identity") != "identity" or declared is not None and (not declared.isdecimal() or int(declared) > MAX_RESPONSE_BYTES):
                raise BudgetExceeded("Invalid model response size")
            data = bytearray()
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise BudgetExceeded("Model response too large")
                data.extend(chunk)
        finally:
            await response.aclose()
        buffered = httpx.Response(response.status_code, headers=response.headers, content=bytes(data), extensions=response.extensions)
        if buffered.is_success:
            try:
                usage = buffered.json().get("usage")
                if not isinstance(usage, dict):
                    raise BudgetExceeded("Model response did not include token usage")
                provider, role = self.config["provider"], self.config["role"]
                output_tokens = 0
                if provider == "voyage":
                    input_tokens = token_count(usage.get("total_tokens"))
                elif provider == "anthropic":
                    input_tokens = token_count(usage.get("input_tokens"))
                    output_tokens = token_count(usage.get("output_tokens"))
                    # Cache/server-tools are never requested. Unexpected billed extras
                    # retain the full reservation instead of silently undercharging.
                    if token_count(usage.get("cache_creation_input_tokens", 0)) or token_count(usage.get("cache_read_input_tokens", 0)) or any((usage.get("server_tool_use") or {}).values()):
                        raise BudgetExceeded("Unsupported provider usage")
                else:
                    responses = endpoint == "/responses"
                    input_tokens = token_count(usage.get("input_tokens" if responses else "prompt_tokens"))
                    if role != "embedding":
                        output_tokens = token_count(usage.get("output_tokens" if responses else "completion_tokens"))
                actual = micros(input_tokens, self.config["input_rate"]) + micros(output_tokens, self.config["output_rate"])
                self.ledger.reconcile(self.operation, reserved, actual)
            except (ValueError, TypeError, AttributeError):
                raise BudgetExceeded("Invalid model usage response") from None
        return buffered

    async def aclose(self):
        await self.inner.aclose()
