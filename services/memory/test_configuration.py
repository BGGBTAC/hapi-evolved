import dataclasses
import unittest
from configuration import InvalidConfiguration, provider_config, operator_config


def browser_config(**changes):
    llm = {"provider": "openai", "apiKey": "synthetic-project-key-never-sent", "model": "synthetic-model",
        "inputUsdPerMTok": "1", "outputUsdPerMTok": "2", "maxOutputTokens": 2048}
    embedding = {"provider": "openai", "apiKey": "synthetic-project-key-never-sent", "model": "text-embedding-3-small",
        "dimensions": 1536, "inputUsdPerMTok": "0.02"}
    config = {"schemaVersion": 2, "llm": llm, "embedding": embedding, "reranker": {"provider": "rrf"}}
    for key, value in changes.items():
        if key in config:
            config[key] = value
        elif key in ("embeddingModel", "embeddingDimensions", "embeddingUsdPerMTok"):
            embedding[{"embeddingModel": "model", "embeddingDimensions": "dimensions", "embeddingUsdPerMTok": "inputUsdPerMTok"}[key]] = value
        elif key == "apiKey":
            llm[key] = value
            embedding[key] = value
        else:
            llm[key] = value
    return config


class ConfigurationTests(unittest.TestCase):
    def test_snapshot_is_immutable_and_never_discloses_the_key_in_identity_or_repr(self):
        supplied = browser_config()
        config = provider_config(supplied)
        supplied["llm"]["apiKey"] = "replacement-synthetic-key"
        supplied["llm"]["model"] = "replacement-model"
        self.assertEqual(config.llm.api_key, browser_config()["llm"]["apiKey"])
        self.assertEqual(config.llm.model, "synthetic-model")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            config.llm.api_key = "changed"
        with self.assertRaises(TypeError):
            config.llm.transport_config()["model"] = "changed"
        for output in [repr(config), str(config.llm.transport_config())]:
            self.assertNotIn(config.llm.api_key, output)
            self.assertNotIn("apiKey", output)

    def test_invalid_configuration_fails_closed_without_reflecting_values(self):
        invalid = [None, [], {}, {**browser_config(), "base": "https://private.invalid"}]
        for field, values in {
            "provider": ["other", None], "apiKey": [None, "short", "test-key\r\ninjected", "ü" * 20, "x" * 4097],
            "model": [None, "", "unsafe/model", "m" * 201, "m\n"],
            "embeddingModel": [123, "invalid model"], "embeddingDimensions": [True, "1536", 0, 3073],
            "maxOutputTokens": [True, 255, 65537, 2048.0, "2048"],
            "inputUsdPerMTok": ["0", "0.00", "-1", "NaN", "Infinity", "1e2", "1_0", "1,2", ".2", "1000001", "1" * 33, 1],
            "outputUsdPerMTok": [None, "0", "-1"], "embeddingUsdPerMTok": ["0", "inf", ""]
        }.items():
            invalid.extend(browser_config(**{field: value}) for value in values)
        for supplied in invalid:
            with self.subTest(supplied_type=type(supplied).__name__):
                with self.assertRaises(InvalidConfiguration) as error:
                    provider_config(supplied)
                self.assertEqual(str(error.exception), "Invalid provider configuration")
        missing = browser_config()
        del missing["llm"]["model"]
        with self.assertRaises(InvalidConfiguration):
            provider_config(missing)

    def test_roles_are_independent_and_provider_dimension_sets_are_enforced(self):
        from test_providers import mixed_config
        supplied = mixed_config()
        config = provider_config(supplied)
        self.assertEqual(config.binding, ("voyage", "voyage-4", 256))
        self.assertEqual(len({config.llm.api_key, config.embedding.api_key, config.reranker.api_key}), 3)
        for role in (config.llm, config.embedding, config.reranker):
            self.assertNotIn(role.api_key, repr(config))
            self.assertNotIn(role.api_key, str(role.transport_config()))
        for slot, provider in (("llm", "voyage"), ("embedding", "anthropic"), ("reranker", "anthropic")):
            invalid = mixed_config()
            invalid[slot]["provider"] = provider
            with self.assertRaises(InvalidConfiguration):
                provider_config(invalid)
        for dimensions in (1536, 0, 4096, True):
            invalid = mixed_config()
            invalid["embedding"]["dimensions"] = dimensions
            with self.assertRaises(InvalidConfiguration):
                provider_config(invalid)
        for dimensions in (256, 512, 1024, 2048):
            valid = mixed_config()
            valid["embedding"]["dimensions"] = dimensions
            self.assertEqual(provider_config(valid).embedding.dimensions, dimensions)

    def test_explicit_output_limits_round_trip_for_llm_and_openai_reranker(self):
        for provider in ("openai", "anthropic"):
            for limit in (256, 2048, 4096, 16384, 65536):
                supplied = browser_config(provider=provider, maxOutputTokens=limit)
                supplied["reranker"] = {**supplied["llm"], "provider": "openai"}
                config = provider_config(supplied)
                self.assertEqual(config.llm.max_output_tokens, limit)
                self.assertEqual(config.reranker.max_output_tokens, limit)
                self.assertEqual(config.llm.transport_config()["max_output_tokens"], limit)
                self.assertEqual(config.llm.input_rate, "1")
                self.assertEqual(config.llm.output_rate, "2")
        for limit in (255, 65537, True, "16384", 16384.5):
            supplied = browser_config()
            supplied["reranker"] = {**supplied["llm"], "maxOutputTokens": limit}
            with self.assertRaises(InvalidConfiguration):
                provider_config(supplied)

    def test_operator_fallback_keeps_custom_https_endpoint_and_dimensions(self):
        env = {"EVOLVED_MEMORY_API_BASE": "https://operator.invalid:8443/v1",
            "EVOLVED_MEMORY_MODEL": "operator/model", "EVOLVED_MEMORY_EMBEDDING_MODEL": "operator/embedding",
            "EVOLVED_MEMORY_INPUT_USD_PER_MTOK": "1", "EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK": "2",
            "EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK": "0", "EVOLVED_MEMORY_EMBEDDING_DIM": "1024",
            "EVOLVED_MEMORY_MAX_OUTPUT_TOKENS": "9000"}
        config = operator_config(env, lambda name: "synthetic-operator-key")
        self.assertEqual(config.llm.base, env["EVOLVED_MEMORY_API_BASE"])
        self.assertEqual(config.embedding.dimensions, 1024)
        self.assertEqual(config.llm.max_output_tokens, 9000)
        for requested, expected in [("16384", 16384), ("65536", 65536), ("65537", 65536), ("255", 256)]:
            updated = operator_config({**env, "EVOLVED_MEMORY_MAX_OUTPUT_TOKENS": requested}, lambda name: "synthetic-operator-key")
            self.assertEqual(updated.llm.max_output_tokens, expected)
        without_limit = {name: value for name, value in env.items() if name != "EVOLVED_MEMORY_MAX_OUTPUT_TOKENS"}
        self.assertEqual(operator_config(without_limit, lambda name: "synthetic-operator-key").llm.max_output_tokens, 2048)
        for endpoint in ["http://operator.invalid", "https://user:password@operator.invalid", "https://operator.invalid?x=1", "https://operator.invalid:bad"]:
            with self.assertRaises(InvalidConfiguration):
                operator_config({**env, "EVOLVED_MEMORY_API_BASE": endpoint}, lambda name: "synthetic-operator-key")


if __name__ == "__main__": unittest.main()
