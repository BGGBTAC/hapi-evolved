# Graph Memory provider selection — verification

The project configuration now separates extraction (Anthropic/Claude or OpenAI),
embeddings (Voyage AI or OpenAI), and ranking (local RRF, Voyage AI or OpenAI).
Claude with Voyage and local RRF has no OpenAI credential dependency.

## Evidence

- All seven TypeScript package checks passed; production web build passed.
- Repository suite: 10,035 passed, 17 skipped, zero failures.
- Python Memory suite: 69 passed, including budget admission, provider separation,
  malformed usage/vectors, lifecycle cleanup and provider-aware vector binding.
- Existing full Evolved browser check passed. Memory browser check passed eight
  flows against a real isolated Hub, Vault and WebAuthn with a synthetic internal
  Memory service: save/check, independent credentials, provider binding, project
  navigation, reconnect and reranker selection. No horizontal overflow at 1440,
  390 or 320 pixels; no unexpected browser errors.
- `services/memory/validate_stack.py` passed against isolated Neo4j, including
  exact project isolation, generation cleanup and provider-aware binding.
- `services/memory/validate_sdk.py` passed using Graphiti 0.30.2, real isolated
  Neo4j and mocked provider HTTP: OpenAI and Claude/Voyage ingestion/search,
  both external rerankers, idempotent receipts and scoped cleanup. Ten simulated
  provider requests; zero live inference calls.

The adversarial Astra architecture and implementation reviews covered nested
credential redaction, legacy ciphertext normalization, hidden Graphiti defaults,
Anthropic retries/tools, budget accounting, vector identity and rollout recovery.
The stale agent capability description found during review was corrected. Claude
Opus 5.5 provided an additional architecture consultation.

The separate private deployment runbook was reviewed for migration rollback.
A WAL-related replay-cache preservation defect in the prepared helper was fixed
before deployment and tested across a normal subprocess exit. Deployment evidence
and infrastructure identifiers belong in the private infrastructure repository.

## Limits and migration

These checks do not prove live provider billing, credentials or model entitlement.
Model catalogs are fetched from OpenAI/Anthropic without paid inference. Voyage
has no catalog in this integration; its key/model remain explicitly unverified
by the connection check. Model prices are supplied by the administrator.

Old encrypted OpenAI configurations are normalized on read without changing their
ciphertext or version. Existing graph vectors keep their provider/model/dimension
binding. No automatic graph deletion, reindexing or cloud-budget authorization is
part of the upgrade. The deployment requires a consistent backup; reverting the
application schema also requires compatible Vault/Memory state and must preserve
any subsequent user changes.

Official API references: [Anthropic model listing](https://platform.claude.com/docs/en/api/models/list),
[Voyage embeddings](https://docs.voyageai.com/reference/embeddings-api),
[Voyage reranking](https://docs.voyageai.com/reference/reranker-api).
