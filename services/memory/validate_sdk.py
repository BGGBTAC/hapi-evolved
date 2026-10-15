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
        async def mock_provider(request):
            data = json.loads(request.content)
            provider_calls.append(request.url.path)
            assert request.url.host == 'provider.invalid'
            if request.url.path.endswith('/embeddings'):
                inputs = data['input'] if isinstance(data['input'], list) else [data['input']]
                return httpx.Response(200, json={'object': 'list', 'model': data['model'],
                    'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * 1535} for i in range(len(inputs))],
                    'usage': {'prompt_tokens': 10, 'total_tokens': 10}})
            assert request.url.path.endswith('/responses'), request.url.path
            assert data['store'] is False and data['max_output_tokens'] <= 2048
            schema = data['text']['format']['schema']
            output = json.dumps(minimal(schema, schema))
            return httpx.Response(200, json={'id': 'resp_test', 'object': 'response', 'created_at': 1,
                'status': 'completed', 'model': data['model'], 'output': [{'id': 'msg_test', 'type': 'message',
                    'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': output, 'annotations': []}]}],
                'usage': {'input_tokens': 100, 'output_tokens': 10, 'total_tokens': 110}})
        async def test_graph_client(operation):
            graph, http = await original(operation)
            await http._transport.inner.aclose()
            http._transport.inner = httpx.MockTransport(mock_provider)
            assert graph.llm_client.client is graph.cross_encoder.client is graph.embedder.client
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
                searched = await client.post('/search', json={'projects': [{'projectId': project, 'generation': 0}],
                    'query': 'Synthetic', 'operationId': str(uuid4()), 'budgetMicros': 1_000_000, 'limit': 5})
                assert searched.status_code == 200, searched.text
                assert searched.json()['results'] == []
                receipt = await client.post('/receipt', json={'operationId': payload['operationId']})
                assert receipt.status_code == 200 and receipt.json()['final'] is True
                assert receipt.json()['spentMicros'] == response.json()['spentMicros']
                purged = await client.post('/reset', json={'projectId': project, 'generation': 1})
                assert purged.status_code == 200
                async with adapter.driver.session() as session:
                    result = await session.run('MATCH (n {group_id:$scope}) RETURN count(n) AS total', scope=scope)
                    assert (await result.single())['total'] == 0
                assert '/v1/responses' in provider_calls and '/v1/embeddings' in provider_calls
                print(json.dumps({'realSDK': 'graphiti-0.30.2', 'neo4j': 'passed', 'ingest': True, 'search': True,
                    'receipt': True, 'purge': True, 'paidCalls': 0, 'mockProviderRequests': len(provider_calls)}))
        finally:
            async with adapter.driver.session() as session:
                result = await session.run('MATCH (n {group_id:$scope}) DETACH DELETE n', scope=scope)
                await result.consume()
            await adapter.driver.close()
            adapter.ledger.db.close()

asyncio.run(main())
