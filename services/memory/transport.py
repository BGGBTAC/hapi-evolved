import json
import httpx
from budget import OperationLedger, micros, BudgetExceeded


class BudgetTransport(httpx.AsyncBaseTransport):
    """Only text completions/embeddings to the configured provider; charge before outbound I/O."""
    def __init__(self, ledger: OperationLedger, operation: str, config: dict):
        self.ledger = ledger
        self.operation = operation
        self.config = config
        self.base = httpx.URL(config["base"])
        self.inner = httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        path = self.base.path.rstrip("/")
        if (request.method != "POST" or request.url.host != self.base.host
                or request.url.port != self.base.port or request.url.scheme != "https"
                or request.url.query or request.url.userinfo
                or request.url.path not in (path + "/embeddings", path + "/chat/completions", path + "/responses")):
            raise ValueError("Model endpoint not allowed")
        body = json.loads(request.content)
        embedding = request.url.path == path + "/embeddings"
        expected = self.config["embedding_model"] if embedding else self.config["model"]
        if body.get("model") != expected or body.get("stream") or body.get("n", 1) != 1:
            raise ValueError("Model/streaming configuration is not allowed")
        responses = request.url.path == path + "/responses"
        output_limit = 0
        if not embedding:
            requested = body.pop("max_tokens", body.pop("max_completion_tokens", body.get("max_output_tokens", 2048)))
            output_limit = min(int(requested), self.config["max_output_tokens"])
            if output_limit < 1 or body.get("tools"):
                raise ValueError("Model tools and nonpositive output limits are not allowed")
            body["max_output_tokens" if responses else "max_completion_tokens"] = output_limit
            body["store"] = False
        serialized = json.dumps(body, ensure_ascii=False).encode()
        # UTF-8 bytes upper-bound ordinary text BPE tokens; reserve additional protocol/schema framing.
        input_bound = len(serialized) + 4096
        input_rate = self.config["embedding_rate"] if embedding else self.config["input_rate"]
        reserved = micros(input_bound, input_rate) + micros(output_limit, self.config["output_rate"])
        self.ledger.charge(self.operation, reserved)
        headers = dict(request.headers)
        headers.pop("content-length", None)
        forwarded = httpx.Request(request.method, request.url, headers=headers, content=serialized, extensions=request.extensions)
        response = await self.inner.handle_async_request(forwarded)
        await response.aread()
        if response.is_success:
            data = response.json()
            usage = data.get("usage")
            input_key = "input_tokens" if responses else "prompt_tokens"
            output_key = "output_tokens" if responses else "completion_tokens"
            if not usage or input_key not in usage:
                raise BudgetExceeded("Model response did not include token usage")
            actual = micros(int(usage[input_key]), input_rate) + micros(int(usage.get(output_key, 0)), self.config["output_rate"])
            self.ledger.reconcile(self.operation, reserved, actual)
        # Failed/ambiguous responses keep their upper-bound charge, avoiding free retries.
        return response

    async def aclose(self):
        await self.inner.aclose()
