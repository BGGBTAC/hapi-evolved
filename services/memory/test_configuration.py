import dataclasses
import unittest
from configuration import InvalidConfiguration, provider_config, operator_config


def browser_config(**changes):
    return {"provider": "openai", "apiKey": "synthetic-project-key-never-sent", "model": "synthetic-model",
            "embeddingModel": "text-embedding-3-small", "embeddingDimensions": 1536,
            "inputUsdPerMTok": "1", "outputUsdPerMTok": "2", "embeddingUsdPerMTok": "0.02",
            "maxOutputTokens": 2048, **changes}


class ConfigurationTests(unittest.TestCase):
    def test_snapshot_is_immutable_and_never_discloses_the_key_in_identity_or_repr(self):
        supplied = browser_config()
        config = provider_config(supplied)
        supplied["apiKey"] = "replacement-synthetic-key"
        supplied["model"] = "replacement-model"
        self.assertEqual(config.api_key, browser_config()["apiKey"])
        self.assertEqual(config.model, "synthetic-model")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            config.api_key = "changed"
        with self.assertRaises(TypeError):
            config.transport_config()["model"] = "changed"
        for output in [repr(config), str(config.transport_config())]:
            self.assertNotIn(config.api_key, output)
            self.assertNotIn("apiKey", output)

    def test_invalid_configuration_fails_closed_without_reflecting_values(self):
        invalid = [None, [], {}, {**browser_config(), "base": "https://private.invalid"}]
        for field, values in {
            "provider": ["other", None], "apiKey": [None, "short", "test-key\r\ninjected", "ü" * 20, "x" * 4097],
            "model": [None, "", "unsafe/model", "m" * 201, "m\n"],
            "embeddingModel": [123, "invalid model"], "embeddingDimensions": [True, "1536", 1024, 3072],
            "maxOutputTokens": [True, 255, 4097, 2048.0, "2048"],
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
        del missing["model"]
        with self.assertRaises(InvalidConfiguration):
            provider_config(missing)

    def test_operator_fallback_keeps_custom_https_endpoint_and_dimensions(self):
        env = {"EVOLVED_MEMORY_API_BASE": "https://operator.invalid:8443/v1",
            "EVOLVED_MEMORY_MODEL": "operator/model", "EVOLVED_MEMORY_EMBEDDING_MODEL": "operator/embedding",
            "EVOLVED_MEMORY_INPUT_USD_PER_MTOK": "1", "EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK": "2",
            "EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK": "0", "EVOLVED_MEMORY_EMBEDDING_DIM": "1024",
            "EVOLVED_MEMORY_MAX_OUTPUT_TOKENS": "9000"}
        config = operator_config(env, lambda name: "synthetic-operator-key")
        self.assertEqual(config.base, env["EVOLVED_MEMORY_API_BASE"])
        self.assertEqual(config.embedding_dimensions, 1024)
        self.assertEqual(config.max_output_tokens, 4096)
        for endpoint in ["http://operator.invalid", "https://user:password@operator.invalid", "https://operator.invalid?x=1", "https://operator.invalid:bad"]:
            with self.assertRaises(InvalidConfiguration):
                operator_config({**env, "EVOLVED_MEMORY_API_BASE": endpoint}, lambda name: "synthetic-operator-key")


if __name__ == "__main__": unittest.main()
