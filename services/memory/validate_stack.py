"""Explicitly run INSIDE the isolated validation container, never production.

Uses only synthetic Neo4j fixtures and disabled-provider failures. No model calls.
"""
import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4
import httpx
from neo4j import AsyncGraphDatabase

async def main():
    if os.environ.get('EVOLVED_MEMORY_MODEL'):
        raise RuntimeError('Validation requires model processing to be unconfigured')
    token = Path(os.environ['EVOLVED_SERVICE_TOKEN_FILE']).read_text().strip()
    password = Path(os.environ['NEO4J_PASSWORD_FILE']).read_text().strip()
    project = 'stacktest-' + uuid4().hex
    prefix = 'hapi_' + project.replace('-', '_')
    own, neighbor = prefix + '_0', prefix + '_1_0'
    binding = {'projectId': project, 'embeddingModel': 'text-embedding-3-small', 'embeddingDimensions': 1536}
    driver = AsyncGraphDatabase.driver(os.environ['NEO4J_URI'], auth=(os.environ.get('NEO4J_USER', 'neo4j'), password))
    async def count(group):
        async with driver.session() as session:
            result = await session.run('MATCH (n:EvolvedValidation {group_id:$group}) RETURN count(n) AS total', group=group)
            return (await result.single())['total']
    async def seed(group):
        async with driver.session() as session:
            result = await session.run('CREATE (a:EvolvedValidation {group_id:$group})-[:DERIVED]->(b:EvolvedValidation {group_id:$group})', group=group)
            await result.consume()
    try:
        await driver.verify_connectivity()
        await seed(own); await seed(neighbor)
        async with httpx.AsyncClient(base_url='http://127.0.0.1:8012', headers={'authorization': f'Bearer {token}'}, timeout=15) as client:
            assert (await client.get('/health', headers={'authorization': 'invalid'})).status_code == 401
            assert (await client.get('/health')).status_code == 503
            config = {'provider': 'openai', 'apiKey': 'synthetic-validation-never-sent',
                'model': 'synthetic-model', 'embeddingModel': 'text-embedding-3-small', 'embeddingDimensions': 1536,
                'inputUsdPerMTok': '1', 'outputUsdPerMTok': '2', 'embeddingUsdPerMTok': '0.1', 'maxOutputTokens': 2048}
            checked = await client.post('/configuration/check', json={'providerConfig': config})
            assert checked.status_code == 200 and checked.json()['ok'] is True
            assert (await client.post('/configuration/check', json={'providerConfig': {**config, 'embeddingDimensions': 3072}})).status_code == 400
            assert (await client.get('/health')).status_code == 503, 'Project check must not change operator configuration'
            assert (await client.post('/configuration/binding', json=binding)).json() == {'bound': False}
            response = await client.post('/reset', json={'projectId': project, 'generation': 1})
            assert response.status_code == 200, response.text
            assert await count(own) == 0
            assert await count(neighbor) == 2, 'Purge crossed into another project prefix'
            assert (await client.post('/configuration/binding', json=binding)).json() == {'bound': True}, 'Neighbor prefix must not prevent an exact empty-project proof'
            async with driver.session() as session:
                result = await session.run('MATCH (a:EvolvedValidation {group_id:$neighbor})-[:DERIVED]->(b:EvolvedValidation {group_id:$neighbor}) CREATE (a)-[:OWNED {group_id:$own}]->(b)', neighbor=neighbor, own=own)
                await result.consume()
            assert (await client.post('/configuration/binding', json=binding)).json() == {'bound': True}, 'Existing binding must remain valid with graph data'
            alternate_binding = {**binding, 'embeddingModel': 'text-embedding-3-large'}
            assert (await client.post('/configuration/binding', json=alternate_binding)).json() == {'bound': False}, 'Relationship-only project data must prevent a different binding'
            async with driver.session() as session:
                result = await session.run('MATCH ()-[r:OWNED {group_id:$own}]->() DELETE r', own=own)
                await result.consume()
            await seed(prefix + '_1')
            assert (await client.post('/reset', json={'projectId': project, 'generation': 1})).status_code == 200
            assert await count(prefix + '_1') == 2, 'Retried purge removed new generation'
            stale = await client.post('/ingest', json={'projectId': project, 'generation': 0, 'operationId': str(uuid4()), 'budgetMicros': 100})
            assert stale.status_code == 409 and stale.json()['spentMicros'] == 0
            operation = {'projectId': project, 'generation': 1, 'operationId': str(uuid4()), 'budgetMicros': 100}
            failed = await client.post('/ingest', json=operation)
            assert failed.status_code == 503
            retry = await client.post('/ingest', json=operation)
            assert retry.status_code == 503
            assert (await client.post('/receipt', json={'operationId': operation['operationId']})).status_code == 404
            assert (await client.post('/search', json={'projects': []})).status_code == 400
            assert (await client.post('/search', content=b'x' * 100001)).status_code == 413
            await client.post('/reset', json={'projectId': project, 'generation': 2})
            assert (await client.post('/configuration/binding', json=binding)).json() == {'bound': True}
        print(json.dumps({'memory': 'passed', 'neo4jCascade': True, 'projectIsolation': True,
            'idempotentReset': True, 'staleGenerationRejected': True, 'projectConfigurationCheck': True,
            'operatorRemainsUnconfigured': True, 'allGenerationBindingProof': True, 'relationshipOnlyBindingBlocked': True, 'identicalBindingWithGraph': True,
            'providerDisabled': True, 'spentMicros': 0}))
    finally:
        async with driver.session() as session:
            result = await session.run('MATCH (n:EvolvedValidation) WHERE n.group_id IN $groups DETACH DELETE n', groups=[own, neighbor, prefix + '_1'])
            await result.consume()
        await driver.close()

asyncio.run(main())
