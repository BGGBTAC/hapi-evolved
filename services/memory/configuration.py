"""Validated, operation-local provider configuration; credentials never enter public identity."""
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from urllib.parse import urlparse

OPENAI_BASE = "https://api.openai.com/v1"
EMBEDDING_DIMENSIONS = 1536
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")
FIELDS = frozenset({"provider", "apiKey", "model", "embeddingModel", "embeddingDimensions",
                    "inputUsdPerMTok", "outputUsdPerMTok", "embeddingUsdPerMTok", "maxOutputTokens"})


class InvalidConfiguration(ValueError):
    def __init__(self):
        # Never include a supplied value (in particular credentials) in diagnostics.
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


@dataclass(frozen=True, slots=True)
class ModelConfiguration:
    base: str
    api_key: str = field(repr=False)
    model: str
    embedding_model: str
    embedding_dimensions: int
    input_rate: str
    output_rate: str
    embedding_rate: str
    max_output_tokens: int

    def transport_config(self):
        return MappingProxyType({"base": self.base, "host": urlparse(self.base).hostname,
            "model": self.model, "embedding_model": self.embedding_model,
            "embedding_dimensions": self.embedding_dimensions, "input_rate": self.input_rate,
            "output_rate": self.output_rate, "embedding_rate": self.embedding_rate,
            "max_output_tokens": self.max_output_tokens})


def provider_config(value):
    if not isinstance(value, dict) or set(value) != FIELDS or value.get("provider") != "openai":
        raise InvalidConfiguration()
    key = validate_api_key(value["apiKey"])
    for name in ("model", "embeddingModel"):
        if not isinstance(value[name], str) or not MODEL_ID.fullmatch(value[name]):
            raise InvalidConfiguration()
    if type(value["embeddingDimensions"]) is not int or value["embeddingDimensions"] != EMBEDDING_DIMENSIONS:
        raise InvalidConfiguration()
    if type(value["maxOutputTokens"]) is not int or not 256 <= value["maxOutputTokens"] <= 4096:
        raise InvalidConfiguration()
    return ModelConfiguration(OPENAI_BASE, key, value["model"], value["embeddingModel"], EMBEDDING_DIMENSIONS,
        validate_price(value["inputUsdPerMTok"]), validate_price(value["outputUsdPerMTok"]),
        validate_price(value["embeddingUsdPerMTok"]), value["maxOutputTokens"])


def operator_config(environ, read_secret):
    """Preserve operator endpoint/dimension overrides without changing the process environment."""
    base = environ.get("EVOLVED_MEMORY_API_BASE", OPENAI_BASE)
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InvalidConfiguration()
    try:
        parsed.port  # Reject malformed ports before constructing an HTTP client.
        dimensions = int(environ.get("EVOLVED_MEMORY_EMBEDDING_DIM", str(EMBEDDING_DIMENSIONS)))
        output = min(4096, max(256, int(environ.get("EVOLVED_MEMORY_MAX_OUTPUT_TOKENS", "2048"))))
    except ValueError:
        raise InvalidConfiguration() from None
    if not 1 <= dimensions <= 65536:
        raise InvalidConfiguration()
    models = [environ.get(name, "") for name in ("EVOLVED_MEMORY_MODEL", "EVOLVED_MEMORY_EMBEDDING_MODEL")]
    if any(not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model) for model in models):
        raise InvalidConfiguration()
    return ModelConfiguration(base, validate_api_key(read_secret("OPENAI_API_KEY")), *models, dimensions,
        validate_price(environ.get("EVOLVED_MEMORY_INPUT_USD_PER_MTOK"), allow_zero=True),
        validate_price(environ.get("EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK"), allow_zero=True),
        validate_price(environ.get("EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK"), allow_zero=True), output)
