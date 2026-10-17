"""Run inside the isolated memory validation container: real Graphiti + Neo4j, mocked provider I/O only."""
import asyncio
import importlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import httpx


def minimal(schema, root):
    if '$ref' in schema:
        return minimal(root['$defs'][schema['$ref'].split('/')[-1]], root)
    if 'anyOf' in schema:
        return minimal(schema['anyOf'][0], root)
    kind = schema.get('type')
    if kind == 'array': return []
    if kind == 'object': return {key: minimal(schema['properties'][key], root) for key in schema.get('required', [])}
    if kind in ('integer', 'number'): return 0
    if kind == 'boolean': return False
    if kind == 'null': return None
    return ''

async def main():
    if os.environ.get('EVOLVED_MEMORY_MODEL'):
        raise RuntimeError('Use an isolated stack with provider processing disabled')
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / 'synthetic.key'; key.write_text('synthetic-never-sent')
        os.environ.update({'OPENAI_API_KEY_FILE': str(key), 'EVOLVED_MEMORY_STATE': str(Path(directory) / 'ops.db'),
            'EVOLVED_MEMORY_MODEL': 'synthetic-model', 'EVOLVED_MEMORY_EMBEDDING_MODEL': 'synthetic-embedding',
            'EVOLVED_MEMORY_INPUT_USD_PER_MTOK': '1', 'EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK': '2',
            'EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK': '0.1', 'EVOLVED_MEMORY_API_BASE': 'https://provider.invalid/v1'})
        adapter = importlib.import_module('app')
        original = adapter.graph_client
        provider_calls = []
        browser = {'schemaVersion': 2,
            'llm': {'provider': 'openai', 'apiKey': 'synthetic-browser-key-never-sent', 'model': 'synthetic-model',
                'inputUsdPerMTok': '1', 'outputUsdPerMTok': '2', 'maxOutputTokens': 2048},
            'embedding': {'provider': 'openai', 'apiKey': 'synthetic-browser-key-never-sent',
                'model': 'text-embedding-3-small', 'dimensions': 1536, 'inputUsdPerMTok': '0.1'},
            'reranker': {'provider': 'rrf'}}
        mixed = {**browser, 'llm': {**browser['llm'], 'provider': 'anthropic', 'model': 'claude-synthetic', 'apiKey': 'synthetic-anthropic-never-sent'},
            'embedding': {**browser['embedding'], 'provider': 'voyage', 'model': 'voyage-4', 'dimensions': 1024, 'apiKey': 'synthetic-voyage-never-sent'}}
        async def mock_provider(request):
            data = json.loads(request.content)
            provider_calls.append(request.url.path)
            assert request.url.host in ('provider.invalid', 'api.openai.com', 'api.anthropic.com', 'api.voyageai.com')
            if request.url.host == 'api.openai.com':
                assert request.headers['authorization'] == 'Bearer ' + browser['llm']['apiKey']
            if request.url.host == 'api.anthropic.com':
                assert request.headers['x-api-key'] == mixed['llm']['apiKey']
                assert request.url.path == '/v1/messages' and data['max_tokens'] <= 2048
                schema = data['tools'][0]['input_schema']
                return httpx.Response(200, json={'id': 'msg_test', 'type': 'message', 'role': 'assistant',
                    'model': data['model'], 'stop_reason': 'tool_use', 'stop_sequence': None,
                    'content': [{'type': 'tool_use', 'id': 'toolu_test', 'name': 'graphiti_output', 'input': minimal(schema, schema)}],
                    'usage': {'input_tokens': 100, 'output_tokens': 10}})
            if request.url.host == 'api.voyageai.com':
                assert request.headers['authorization'] == 'Bearer ' + mixed['embedding']['apiKey']
                if request.url.path == '/v1/rerank':
                    assert data['model'] == 'rerank-synthetic' and data['return_documents'] is False
                    return httpx.Response(200, json={'data': [{'index': i, 'relevance_score': 0.9} for i in range(len(data['documents']))],
                        'usage': {'total_tokens': 10}})
                assert request.url.path == '/v1/embeddings' and data['output_dimension'] == 1024
                assert data['truncation'] is False and 'input_type' not in data
                inputs = data['input']
                return httpx.Response(200, json={'data': [{'index': i, 'embedding': [1.0] + [0.0] * 1023} for i in range(len(inputs))],
                    'usage': {'total_tokens': 10}})
            if request.url.path.endswith('/embeddings'):
                if request.url.host == 'api.openai.com': assert data['dimensions'] == 1536
                inputs = data['input'] if isinstance(data['input'], list) else [data['input']]
                return httpx.Response(200, json={'object': 'list', 'model': data['model'],
                    'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * 1535} for i in range(len(inputs))],
                    'usage': {'prompt_tokens': 10, 'total_tokens': 10}})
            if request.url.path == '/v1/chat/completions':
                assert data['model'] == 'rerank-synthetic' and data['max_completion_tokens'] == 1 and data['store'] is False
                return httpx.Response(200, json={'id': 'chatcmpl_test', 'object': 'chat.completion', 'created': 1,
                    'model': data['model'], 'choices': [{'index': 0, 'finish_reason': 'stop',
                        'message': {'role': 'assistant', 'content': 'True'},
                        'logprobs': {'content': [{'token': 'True', 'logprob': -0.1, 'bytes': [84,114,117,101],
                            'top_logprobs': [{'token': 'True', 'logprob': -0.1, 'bytes': [84,114,117,101]}]}]}}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 1, 'total_tokens': 11}})
            assert request.url.path.endswith('/responses'), request.url.path
            assert data['store'] is False and data['max_output_tokens'] <= 2048
            schema = data['text']['format']['schema']
            output = json.dumps(minimal(schema, schema))
            return httpx.Response(200, json={'id': 'resp_test', 'object': 'response', 'created_at': 1,
                'status': 'completed', 'model': data['model'], 'output': [{'id': 'msg_test', 'type': 'message',
                    'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': output, 'annotations': []}]}],
                'usage': {'input_tokens': 100, 'output_tokens': 10, 'total_tokens': 110}})
        async def test_graph_client(operation, config=None):
            graph, http = await original(operation, config)
            for client in http.clients:
                await client._transport.inner.aclose()
                client._transport.inner = httpx.MockTransport(mock_provider)
            assert graph.llm_client.client is not graph.embedder.client
            return graph, http
        adapter.graph_client = test_graph_client
        project, memory_id = str(uuid4()), str(uuid4())
        scope = adapter.group_id(project, 0)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=adapter.app), base_url='http://test',
                    headers={'authorization': 'Bearer ' + adapter.service_token}, timeout=30) as client:
                payload = {'projectId': project, 'generation': 0, 'operationId': str(uuid4()), 'budgetMicros': 1_000_000,
                    'memoryId': memory_id, 'title': 'SDK verification', 'body': 'Synthetic verification episode.',
                    'sources': [{'kind': 'manual', 'projectId': project, 'hash': 'synthetic'}],
                    'referenceTime': datetime.now(timezone.utc).isoformat()}
                response = await client.post('/ingest', json=payload)
                assert response.status_code == 200, response.text
                assert response.json()['indexed'] is True
                call_count = len(provider_calls)
                retry = await client.post('/ingest', json=payload)
                assert retry.status_code == 200 and len(provider_calls) == call_count
                async with adapter.driver.session() as session:
                    result = await session.run('MATCH (n:Episodic {uuid:$id,group_id:$scope}) RETURN n.uuid AS id', id=memory_id, scope=scope)
                    assert (await result.single())['id'] == memory_id
                search_payload = {'projects': [{'projectId': project, 'generation': 0}], 'providerConfig': browser,
                    'query': 'Synthetic', 'operationId': str(uuid4()), 'budgetMicros': 1_000_000, 'limit': 5}
                searched = await client.post('/search', json=search_payload)
                assert searched.status_code == 200, searched.text
                assert searched.json()['results'] == []
                call_count = len(provider_calls)
                rotated = await client.post('/search', json={**search_payload, 'providerConfig': {
                    **browser, 'llm': {**browser['llm'], 'apiKey': 'rotated-key-never-sent', 'model': 'changed-model', 'inputUsdPerMTok': '3'}}})
                assert rotated.json() == searched.json() and len(provider_calls) == call_count
                dump = '\n'.join(adapter.ledger.db.iterdump())
                assert browser['llm']['apiKey'] not in dump and 'rotated-key-never-sent' not in dump
                receipt = await client.post('/receipt', json={'operationId': payload['operationId']})
                assert receipt.status_code == 200 and receipt.json()['final'] is True
                assert receipt.json()['spentMicros'] == response.json()['spentMicros']
                purged = await client.post('/reset', json={'projectId': project, 'generation': 1})
                assert purged.status_code == 200
                async with adapter.driver.session() as session:
                    result = await session.run('MATCH (n {group_id:$scope}) RETURN count(n) AS total', scope=scope)
                    assert (await result.single())['total'] == 0
                assert '/v1/responses' in provider_calls and '/v1/embeddings' in provider_calls
                mixed_project = project + '-mixed'
                mixed_scope = adapter.group_id(mixed_project, 0)
                try:
                    mixed_payload = {**payload, 'projectId': mixed_project, 'operationId': str(uuid4()),
                        'memoryId': str(uuid4()), 'providerConfig': mixed}
                    ingested = await client.post('/ingest', json=mixed_payload)
                    assert ingested.status_code == 200 and ingested.json()['indexed'], ingested.text
                    mixed_search = {**search_payload, 'projects': [{'projectId': mixed_project, 'generation': 0}],
                        'operationId': str(uuid4()), 'providerConfig': mixed}
                    searched_mixed = await client.post('/search', json=mixed_search)
                    assert searched_mixed.status_code == 200, searched_mixed.text
                    assert searched_mixed.json()['results'] == []
                    assert '/v1/messages' in provider_calls
                    # Populate only this synthetic scope with actual Graphiti nodes
                    # and an edge, so both selected cross-encoders must run in search.
                    from graphiti_core.nodes import EntityNode
                    from graphiti_core.edges import EntityEdge
                    fixture_graph, resources = await test_graph_client('synthetic-fixture', adapter.provider_config(mixed))
                    try:
                        vector = [1.0] + [0.0] * 1023
                        left = EntityNode(name='Synthetic left', group_id=mixed_scope, name_embedding=vector)
                        right = EntityNode(name='Synthetic right', group_id=mixed_scope, name_embedding=vector)
                        await left.save(fixture_graph.driver)
                        await right.save(fixture_graph.driver)
                        edge = EntityEdge(name='LINKS', fact='Synthetic verification fact', group_id=mixed_scope, created_at=datetime.now(timezone.utc),
                            source_node_uuid=left.uuid, target_node_uuid=right.uuid, fact_embedding=vector,
                            episodes=[mixed_payload['memoryId']])
                        await edge.save(fixture_graph.driver)
                    finally:
                        await resources.aclose()
                    for provider in ('voyage', 'openai'):
                        reranker = ({'provider': 'voyage', 'apiKey': mixed['embedding']['apiKey'],
                            'model': 'rerank-synthetic', 'inputUsdPerMTok': '0.1'} if provider == 'voyage' else
                            {**browser['llm'], 'model': 'rerank-synthetic'})
                        ranked = await client.post('/search', json={**mixed_search, 'operationId': str(uuid4()),
                            'providerConfig': {**mixed, 'reranker': reranker}})
                        assert ranked.status_code == 200, ranked.text
                        assert [result['id'] for result in ranked.json()['results']] == [edge.uuid], ranked.text
                    assert '/v1/rerank' in provider_calls and '/v1/chat/completions' in provider_calls
                    assert (await client.post('/reset', json={'projectId': mixed_project, 'generation': 1})).status_code == 200
                finally:
                    async with adapter.driver.session() as session:
                        result = await session.run('MATCH (n {group_id:$scope}) DETACH DELETE n', scope=mixed_scope)
                        await result.consume()
                print(json.dumps({'realSDK': 'graphiti-0.30.2', 'neo4j': 'passed', 'ingest': True, 'search': True,
                    'operatorFallbackIngest': True, 'claudeVoyageIngestAndSearch': True, 'voyageAndOpenAIReranking': True, 'projectConfiguredSearch': True, 'rotationReceiptReplay': True,
                    'receipt': True, 'purge': True, 'paidCalls': 0, 'mockProviderRequests': len(provider_calls)}))
        finally:
            async with adapter.driver.session() as session:
                result = await session.run('MATCH (n {group_id:$scope}) DETACH DELETE n', scope=scope)
                await result.consume()
            await adapter.driver.close()
            adapter.ledger.db.close()

asyncio.run(main())
