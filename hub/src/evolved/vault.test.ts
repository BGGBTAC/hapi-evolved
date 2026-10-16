import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedVault, RemoteVaultClient, createVaultSigningKey, verifyVaultEnvelope, type VaultRequest } from './vault'
import { createVaultServer } from './vaultServer'

const directories: string[] = [], vaults: EvolvedVault[] = [], servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = []
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const v of vaults.splice(0)) v.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
function directory(): string { const d = mkdtempSync(join(tmpdir(), 'evolved-vault-')); directories.push(d); return d }
function vault(dir: string, actions: ConstructorParameters<typeof EvolvedVault>[0]['actions'] = []): EvolvedVault {
    const result = new EvolvedVault({ dbPath: join(dir, 'vault.sqlite'), masterKeyFile: join(dir, 'master.key'), actions }); vaults.push(result); return result
}
const request = (operation: VaultRequest['operation'], payload: Record<string, unknown> = {}, projectId = 'project-a'): VaultRequest => ({ userId: 'user-a', projectId, operation, payload })
const memoryConfig = { provider: 'openai', apiKey: 'SYNTHETIC-memory-credential', model: 'chat-model', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, inputUsdPerMTok: '0.4', outputUsdPerMTok: '1.6', embeddingUsdPerMTok: '0.02', maxOutputTokens: 1024 }

describe('Evolved isolated vault and bounded broker', () => {
    test('memory credentials use separate encrypted records and survive restart without entering the secret catalog', async () => {
        const dir = directory(), v = vault(dir)
        const saved = await v.request(request('memoryProvider', { action: 'set', version: 0, config: memoryConfig }))
        expect(JSON.stringify(saved)).not.toContain(memoryConfig.apiKey)
        expect(await v.request(request('list'))).toEqual({ secrets: [] })
        expect(await v.request(request('resources'))).toEqual({ resources: [] })
        const row = v.db.query('SELECT ciphertext FROM memory_providers').get() as { ciphertext: Uint8Array }
        expect(Buffer.from(row.ciphertext).toString()).not.toContain(memoryConfig.apiKey)
        expect(JSON.stringify(v.db.query('SELECT * FROM audit').all())).not.toContain(memoryConfig.apiKey)
        v.close(); vaults.splice(vaults.indexOf(v), 1)
        expect(readFileSync(join(dir, 'vault.sqlite')).includes(Buffer.from(memoryConfig.apiKey))).toBe(false)
        const restarted = vault(dir)
        expect(await restarted.request(request('memoryProvider', { action: 'resolve' }))).toMatchObject({ state: 'configured', version: 1, config: memoryConfig })
        expect(await restarted.request(request('memoryProvider', { action: 'resolve' }, 'project-b'))).toMatchObject({ state: 'unset', config: null })
        await expect(restarted.request(request('memoryProvider', { action: 'set', version: 0, config: memoryConfig }))).rejects.toThrow('changed')
        await expect(restarted.request(request('memoryProvider', { action: 'delete', version: 0 }))).rejects.toThrow('changed')
        expect(await restarted.request(request('memoryProvider', { action: 'delete', version: 1 }))).toMatchObject({ state: 'disabled', version: 2, config: null, embeddingModel: memoryConfig.embeddingModel })
        expect(await restarted.request(request('memoryProvider', { action: 'resolve' }))).toMatchObject({ state: 'disabled', config: null })
        expect(await restarted.request(request('memoryProvider', { action: 'set', version: 2, config: memoryConfig }))).toMatchObject({ version: 3 })
        await restarted.request(request('purgeProject'))
        expect(restarted.db.query('SELECT * FROM memory_providers').all()).toEqual([])
        await expect(restarted.request(request('memoryProvider', { action: 'resolve' }))).rejects.toThrow('deleted')
    })
    test('memory provider AAD prevents version and project substitution', async () => {
        const v = vault(directory())
        await v.request(request('memoryProvider', { action: 'set', version: 0, config: memoryConfig }))
        v.db.query('UPDATE memory_providers SET version=2').run()
        await expect(v.request(request('memoryProvider', { action: 'resolve' }))).rejects.toThrow('invalid')
        v.db.query("UPDATE memory_providers SET version=1,project_id='project-b'").run()
        await expect(v.request(request('memoryProvider', { action: 'resolve' }, 'project-b'))).rejects.toThrow('invalid')
    })
    test('credential-carrying HTTP actions require TLS outside literal loopback addresses', () => {
        for (const url of ['http://api.example.test/action', 'http://10.0.0.3/action', 'http://localhost/action']) {
            expect(() => vault(directory(), [{ id: 'unsafe', projectId: 'project-a', name: 'Unsafe', profiles: ['extended'], type: 'http', url, method: 'POST', secretId: 'synthetic-secret', header: 'authorization' }])).toThrow('require HTTPS')
        }
    })
    test('only ciphertext persists, records survive restart, no plaintext GET exists', async () => {
        const dir = directory(), v = vault(dir), value = 'SYNTHETIC-secret-canary-123'
        const created = await v.request(request('set', { name: 'service', value })) as { secret: { id: string } }
        expect(JSON.stringify(created)).not.toContain(value)
        expect(JSON.stringify(await v.request(request('list')))).not.toContain(value)
        const stored = v.db.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: Uint8Array }
        expect(Buffer.from(stored.ciphertext).toString()).not.toContain(value)
        expect(JSON.stringify(v.db.prepare('SELECT * FROM audit').all())).not.toContain(value)
        expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600)
        await expect(v.request({ ...request('list'), operation: 'read' as VaultRequest['operation'] })).rejects.toThrow('Unsupported')
        v.close(); vaults.splice(vaults.indexOf(v), 1)
        const restarted = vault(dir)
        expect(await restarted.request(request('list'))).toMatchObject({ secrets: [{ id: created.secret.id, version: 1 }] })
        expect(await restarted.request(request('list', {}, 'project-b'))).toEqual({ secrets: [] })
    })
    test('key files reject symlinks and broad permissions', () => {
        const dir = directory(), target = join(dir, 'actual.key')
        writeFileSync(target, Buffer.alloc(32), { mode: 0o600 }); symlinkSync(target, join(dir, 'master.key'))
        expect(() => vault(dir)).toThrow()
        const other = directory(); writeFileSync(join(other, 'master.key'), Buffer.alloc(32), { mode: 0o644 }); chmodSync(join(other, 'master.key'), 0o644)
        expect(() => vault(other)).toThrow('0600')
    })
    test('broker injects only configured synthetic credentials, ignores response bodies and never repeats a request key', async () => {
        const dir = directory(), first = vault(dir), value = 'synthetic-broker-only'
        const created = await first.request(request('set', { name: 'api', value })) as { secret: { id: string } }
        first.close(); vaults.splice(vaults.indexOf(first), 1)
        let calls = 0, credential: string | null = null
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => { calls++; credential = req.headers.get('authorization'); return new Response(value) } }); servers.push(upstream)
        const v = vault(dir, [{ id: 'health', projectId: 'project-a', name: 'Health', profiles: ['restricted'], type: 'http', url: `http://127.0.0.1:${upstream.port}`, method: 'GET', secretId: created.secret.id, header: 'authorization', prefix: 'Bearer ' }])
        const input = request('invoke', { actionId: 'health', profile: 'restricted', idempotencyKey: 'operation-once' })
        const result = await v.request(input)
        expect(result).toEqual({ status: 'succeeded', httpStatus: 200 })
        expect(String(credential)).toBe(`Bearer ${value}`)
        expect(JSON.stringify(result)).not.toContain(value)
        expect(await v.request(input)).toEqual(result)
        expect(calls).toBe(1)
        await expect(v.request(request('invoke', { ...input.payload, actionId: 'arbitrary-target' }))).rejects.toThrow('authorized')
        await expect(v.request(request('invoke', input.payload, 'project-b'))).rejects.toThrow('authorized')
    })
    test('AAD rejects version, secret identity and project swaps before any external request', async () => {
        const dir = directory(), first = vault(dir)
        const created = await first.request(request('set', { name: 'api', value: 'synthetic' })) as { secret: { id: string } }
        first.close(); vaults.splice(vaults.indexOf(first), 1)
        let calls = 0
        const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { calls++; return new Response('ok') } }); servers.push(upstream)
        const action = { name: 'Health', profiles: ['restricted' as const], type: 'http' as const, url: `http://127.0.0.1:${upstream.port}`, method: 'GET' as const, header: 'authorization' }
        const v = vault(dir, [{ ...action, id: 'a', projectId: 'project-a', secretId: created.secret.id }, { ...action, id: 'b', projectId: 'project-b', secretId: created.secret.id }, { ...action, id: 'c', projectId: 'project-a', secretId: 'altered-id' }])
        v.db.prepare('UPDATE secrets SET version=2 WHERE id=?').run(created.secret.id)
        expect(await v.request(request('invoke', { actionId: 'a', profile: 'restricted', idempotencyKey: 'version-test' }))).toEqual({ status: 'indeterminate' })
        v.db.prepare("UPDATE secrets SET version=1,project_id='project-b' WHERE id=?").run(created.secret.id)
        expect(await v.request(request('invoke', { actionId: 'b', profile: 'restricted', idempotencyKey: 'project-test' }, 'project-b'))).toEqual({ status: 'indeterminate' })
        v.db.prepare("UPDATE secrets SET project_id='project-a',id='altered-id' WHERE id=?").run(created.secret.id)
        expect(await v.request(request('invoke', { actionId: 'c', profile: 'restricted', idempotencyKey: 'identity-test' }))).toEqual({ status: 'indeterminate' })
        expect(calls).toBe(0)
    })
    test('signed vault capabilities bind body, project, expiry and one-use nonce', async () => {
        const dir = directory(), v = vault(dir), keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
        const body = JSON.stringify({ ...request('list'), nonce: randomUUID(), expiresAt: Date.now() + 10_000 })
        const signature = sign(null, Buffer.from(body), keys.privateKey).toString('base64url')
        expect(verifyVaultEnvelope(body, signature, publicKey, v).projectId).toBe('project-a')
        expect(() => verifyVaultEnvelope(body, signature, publicKey, v)).toThrow('already been used')
        expect(() => verifyVaultEnvelope(body.replace('project-a', 'project-b'), signature, publicKey, v)).toThrow('Invalid vault')
        const expired = JSON.stringify({ ...request('list'), nonce: randomUUID(), expiresAt: Date.now() - 1 })
        expect(() => verifyVaultEnvelope(expired, sign(null, Buffer.from(expired), keys.privateKey).toString('base64url'), publicKey, v)).toThrow('expired')
    })
    test('remote client and isolated server perform authenticated round trips without returning values', async () => {
        const dir = directory(), v = vault(dir), signingKeyFile = join(dir, 'hub-signing.key'), { publicKey } = createVaultSigningKey(signingKeyFile)
        const app = createVaultServer({ vault: v, hubPublicKey: publicKey })
        const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch }); servers.push(service)
        const client = new RemoteVaultClient({ url: `http://127.0.0.1:${service.port}`, signingKeyFile })
        const created = await client.request(request('set', { name: 'remote', value: 'synthetic-remote' })) as { secret: { id: string } }
        expect(created.secret.id).toBeDefined()
        expect(JSON.stringify(await client.request(request('list')))).not.toContain('synthetic-remote')
        expect((await fetch(`http://127.0.0.1:${service.port}/v1/request`, { method: 'POST', body: '{}' })).status).toBe(401)
        expect(readFileSync(signingKeyFile, 'utf8')).toContain('PRIVATE KEY')
    })
})
