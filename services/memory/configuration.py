"""Immutable per-operation role configurations; credentials never enter public identity."""
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from urllib.parse import urlparse

OPENAI_BASE = "https://api.openai.com/v1"
ANTHROPIC_BASE = "https://api.anthropic.com/v1"
VOYAGE_BASE = "https://api.voyageai.com/v1"
BASES = {"openai": OPENAI_BASE, "anthropic": ANTHROPIC_BASE, "voyage": VOYAGE_BASE}
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")
LLM_FIELDS = {"provider", "apiKey", "model", "inputUsdPerMTok", "outputUsdPerMTok", "maxOutputTokens"}
EMBEDDING_FIELDS = {"provider", "apiKey", "model", "dimensions", "inputUsdPerMTok"}


class InvalidConfiguration(ValueError):
    def __init__(self):
        super().__init__("Invalid provider configuration")


def validate_api_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[!-~]{8,4096}", value):
        raise InvalidConfiguration()
    return value


def validate_price(value, allow_zero=False):
    if not isinstance(value, str) or len(value) > 32 or not re.fullmatch(r"\d+(?:\.\d+)?", value, flags=re.ASCII):
        raise InvalidConfiguration()
    try:
        rate = Decimal(value)
        if not rate.is_finite() or rate < 0 or rate > 1_000_000 or (rate == 0 and not allow_zero):
            raise InvalidConfiguration()
    except InvalidOperation:
        raise InvalidConfiguration() from None
    return value


def validate_dimensions(provider, dimensions):
    if type(dimensions) is not int or not (
            provider == "openai" and 1 <= dimensions <= 3072
            or provider == "voyage" and dimensions in (256, 512, 1024, 2048)):
        raise InvalidConfiguration()
    return dimensions


@dataclass(frozen=True, slots=True)
class RoleConfiguration:
    provider: str
    role: str
    base: str
    api_key: str = field(repr=False)
    model: str
    input_rate: str
    output_rate: str = "0"
    max_output_tokens: int = 0
    dimensions: int = 0

    def transport_config(self):
        return MappingProxyType({name: getattr(self, name) for name in (
            "provider", "role", "base", "model", "input_rate", "output_rate", "max_output_tokens", "dimensions")})


@dataclass(frozen=True, slots=True)
class ModelConfiguration:
    llm: RoleConfiguration
    embedding: RoleConfiguration
    reranker: RoleConfiguration | None

    @property
    def binding(self):
        return (self.embedding.provider, self.embedding.model, self.embedding.dimensions)


def role_config(value, role):
    if not isinstance(value, dict):
        raise InvalidConfiguration()
    provider = value.get("provider")
    if role == "reranker" and value == {"provider": "rrf"}:
        return None
    choices = {"llm": ("openai", "anthropic"), "embedding": ("openai", "voyage"), "reranker": ("openai", "voyage")}
    if provider not in choices[role]:
        raise InvalidConfiguration()
    fields = EMBEDDING_FIELDS if role == "embedding" else (LLM_FIELDS - {"outputUsdPerMTok", "maxOutputTokens"} if provider == "voyage" else LLM_FIELDS)
    if set(value) != fields or not isinstance(value["model"], str) or not MODEL_ID.fullmatch(value["model"]):
        raise InvalidConfiguration()
    output = value.get("maxOutputTokens", 0)
    if "maxOutputTokens" in fields and (type(output) is not int or not 256 <= output <= 4096):
        raise InvalidConfiguration()
    dimensions = validate_dimensions(provider, value["dimensions"]) if role == "embedding" else 0
    return RoleConfiguration(provider, role, BASES[provider], validate_api_key(value["apiKey"]), value["model"],
        validate_price(value["inputUsdPerMTok"]), validate_price(value["outputUsdPerMTok"]) if "outputUsdPerMTok" in fields else "0", output, dimensions)


def provider_config(value):
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "llm", "embedding", "reranker"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 2:
        raise InvalidConfiguration()
    return ModelConfiguration(*(role_config(value[role], role) for role in ("llm", "embedding", "reranker")))


def operator_config(environ, read_secret):
    """Keep the documented OpenAI operator fallback, without mutating process environment."""
    base = environ.get("EVOLVED_MEMORY_API_BASE", OPENAI_BASE)
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InvalidConfiguration()
    try:
        parsed.port
        dimensions = int(environ.get("EVOLVED_MEMORY_EMBEDDING_DIM", "1536"))
        output = min(4096, max(256, int(environ.get("EVOLVED_MEMORY_MAX_OUTPUT_TOKENS", "2048"))))
    except ValueError:
        raise InvalidConfiguration() from None
    if not 1 <= dimensions <= 65536:
        raise InvalidConfiguration()
    models = [environ.get(name, "") for name in ("EVOLVED_MEMORY_MODEL", "EVOLVED_MEMORY_EMBEDDING_MODEL")]
    if any(not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model) for model in models):
        raise InvalidConfiguration()
    key = validate_api_key(read_secret("OPENAI_API_KEY"))
    llm = RoleConfiguration("openai", "llm", base, key, models[0],
        validate_price(environ.get("EVOLVED_MEMORY_INPUT_USD_PER_MTOK"), allow_zero=True),
        validate_price(environ.get("EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK"), allow_zero=True), output)
    embedding = RoleConfiguration("openai", "embedding", base, key, models[1],
        validate_price(environ.get("EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK"), allow_zero=True), dimensions=dimensions)
    return ModelConfiguration(llm, embedding, None)
