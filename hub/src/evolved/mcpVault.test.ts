import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { EvolvedVault } from './vault'
import { canonicalMcpJson, normalizeMcpTools, type McpConnection } from './mcpVault'
const dirs: string[] = [], vaults: EvolvedVault[] = []
afterEach(() => { for (const vault of vaults.splice(0)) vault.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-vault-test-')); dirs.push(dir)
    const vault = new EvolvedVault({ dbPath: join(dir, 'vault.db'), masterKeyFile: join(dir, 'master.key') }); vaults.push(vault)
    const request = (payload: Record<string, unknown>, projectId = 'project-a') => vault.request({ operation: 'mcp', userId: 'synthetic-admin', projectId, payload }) as Promise<{ connection: McpConnection }>
    const input = { action: 'create', id: randomUUID(), kind: 'custom', name: 'Documentation', endpoint: 'https://docs.example.test/mcp', auth: { mode: 'bearer', token: 'SYNTHETIC-mcp-project-key' } }
    return { dir, vault, request, input }
}
const rawTool = { name: 'lookup', description: 'Read documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }
const discovered = (c: McpConnection, tools: unknown[] = [rawTool]) => ({ action: 'discovered', id: c.id, version: c.version, tools, status: { state: 'ready', checkedAt: Date.now() } })
const update = (c: McpConnection, changes: Record<string, unknown> = {}) => ({ action: 'update', id: c.id, version: c.version, catalogRevision: c.catalogRevision, enabled: true, enabledTools: ['lookup'], readOnlyTools: [], ...changes })

test('MCP keys are encrypted, project scoped, metadata-only, and durable; create retry is idempotent', async () => {
    const t = setup(), created = await t.request(t.input)
    expect(created.connection.enabled).toBe(false)
    expect(created.connection.auth).toEqual({ mode: 'bearer', configured: true })
    expect(JSON.stringify(created)).not.toContain(t.input.auth.token)
    expect(await t.request(t.input)).toEqual(created)
    await expect(t.request({ ...t.input, name: 'Other' })).rejects.toThrow('already used')
    expect(await t.request({ action: 'list' }, 'project-b') as unknown).toEqual({ connections: [] })
    await expect(t.request({ action: 'resolve', id: t.input.id, version: 1 }, 'project-b')).rejects.toThrow('not found')
    const row = t.vault.db.query('SELECT ciphertext,metadata FROM mcp_connections').get() as { ciphertext: Uint8Array; metadata: string }
    expect(Buffer.from(row.ciphertext).toString()).not.toContain(t.input.auth.token)
    expect(row.metadata).not.toContain(t.input.auth.token)
    expect(JSON.stringify(t.vault.db.query('SELECT * FROM audit').all())).not.toContain(t.input.auth.token)
    expect(await t.vault.request({ operation: 'list', userId: 'synthetic', projectId: 'project-a', payload: {} })).toEqual({ secrets: [] })
    t.vault.close(); vaults.splice(vaults.indexOf(t.vault), 1)
    expect(readFileSync(join(t.dir, 'vault.db')).includes(Buffer.from(t.input.auth.token))).toBe(false)
    const restarted = new EvolvedVault({ dbPath: join(t.dir, 'vault.db'), masterKeyFile: join(t.dir, 'master.key') }); vaults.push(restarted)
    expect(await restarted.request({ operation: 'mcp', userId: 'synthetic', projectId: 'project-a', payload: { action: 'resolve', id: t.input.id, version: 1 } })).toMatchObject({ credential: t.input.auth })
})

test('catalog fingerprints are canonical, annotations cannot grant custom read access, and drift removes grants', async () => {
    const t = setup(); let c = (await t.request(t.input)).connection
    c = (await t.request(discovered(c))).connection
    expect(c.tools[0].readOnly).toBe(false)
    expect(c.tools[0].fingerprint).toHaveLength(64)
    expect(c.enabledTools).toEqual([])
    c = (await t.request(update(c, { readOnlyTools: ['lookup'] }))).connection
    expect(c.enabled).toBe(true); expect(c.tools[0].readOnly).toBe(true)
    const enabledVersion = c.version, fingerprint = c.tools[0].fingerprint
    c = (await t.request(discovered(c, [{ ...rawTool, inputSchema: { properties: { query: { type: 'string' } }, type: 'object' } }]))).connection
    expect(c.enabledTools).toEqual(['lookup']); expect(c.tools[0].fingerprint).toBe(fingerprint); expect(c.tools[0].readOnly).toBe(true)
    await expect(t.request(update(c, { version: enabledVersion }))).rejects.toThrow('changed')
    c = (await t.request(discovered(c, [{ ...rawTool, description: 'New capability description' }]))).connection
    expect(c.enabledTools).toEqual([]); expect(c.tools[0].readOnly).toBe(false)
    await expect(t.request(update(c, { enabledTools: ['unknown'] }))).rejects.toThrow('discovered')
    await expect(t.request(update(c, { endpoint: 'https://changed.example.test/mcp' }))).rejects.toThrow('Invalid')
})

test('key rotation clears grants and CAS prevents late discovery from undoing disable or deletion', async () => {
    const t = setup(); let c = (await t.request(t.input)).connection; c = (await t.request(discovered(c))).connection; c = (await t.request(update(c))).connection
    const late = discovered(c)
    c = (await t.request(update(c, { enabled: false }))).connection
    await expect(t.request(late)).rejects.toThrow('changed')
    const originalKey = t.input.auth.token
    c = (await t.request(update(c, { auth: { mode: 'bearer', token: 'SYNTHETIC-rotated-key' } }))).connection
    expect(c.enabled).toBe(false); expect(c.enabledTools).toEqual([]); expect(c.tools).toEqual([]); expect(c.catalogRevision).toBeNull()
    expect(JSON.stringify(await t.request({ action: 'list' }))).not.toContain(originalKey)
    expect(await t.request({ action: 'resolve', id: c.id, version: c.version })).toMatchObject({ credential: { token: 'SYNTHETIC-rotated-key' } })
    await t.request({ action: 'delete', id: c.id, version: c.version })
    await expect(t.request(discovered(c))).rejects.toThrow('not found')
    await expect(t.request(t.input)).rejects.toThrow('cannot be reused')
    await t.vault.request({ operation: 'purgeProject', userId: 'synthetic', projectId: 'project-a', payload: {} })
    expect(t.vault.db.query('SELECT COUNT(*) AS n FROM mcp_connections').get()).toEqual({ n: 0 })
    await expect(t.request({ action: 'list' })).rejects.toThrow('deleted')
})

test('credential AAD rejects project, connector and credential-version substitutions', async () => {
    for (const column of ['project_id', 'id', 'credential_version']) {
        const t = setup(); await t.request(t.input)
        const value = column === 'credential_version' ? 2 : column === 'id' ? randomUUID() : 'project-b'
        t.vault.db.query(`UPDATE mcp_connections SET ${column}=?`).run(value)
        await expect(t.request({ action: 'resolve', id: column === 'id' ? value : t.input.id, version: 1 }, column === 'project_id' ? 'project-b' : 'project-a')).rejects.toThrow('integrity')
    }
})

test('endpoint and header validation reject redirection, credential smuggling and unexpected configuration', async () => {
    const t = setup()
    for (const endpoint of ['http://public.example.test', 'https://user:password@public.example.test', 'https://public.example.test:8443', 'https://public.example.test/mcp?token=secret', 'https://public.example.test/#fragment']) await expect(t.request({ ...t.input, id: randomUUID(), endpoint })).rejects.toThrow('HTTPS')
    for (const headerName of ['Host', 'Cookie', 'Proxy-Authorization', 'X-Forwarded-For', 'X-Http-Method-Override']) await expect(t.request({ ...t.input, id: randomUUID(), auth: { mode: 'header', token: 'synthetic', headerName } })).rejects.toThrow('permitted')
    await expect(t.request({ ...t.input, id: randomUUID(), kind: 'context7' })).rejects.toThrow('fixed')
    const c = (await t.request({ ...t.input, id: randomUUID(), endpoint: undefined, kind: 'context7' })).connection
    expect(c.endpoint).toBe('https://mcp.context7.com/mcp')
    const next = (await t.request(discovered(c, [{ ...rawTool, name: 'resolve-library-id' }, { ...rawTool, name: 'query-docs' }]))).connection
    expect(next.tools.every(tool => tool.readOnly)).toBe(true); expect(next.enabledTools).toEqual([])
})

test('tool and JSON bounds reject duplicate names, huge schemas/catalogs, recursion and non-JSON', () => {
    expect(() => normalizeMcpTools([rawTool, rawTool])).toThrow('names')
    expect(() => normalizeMcpTools(Array.from({ length: 101 }, (_, i) => ({ ...rawTool, name: `tool${i}` })))).toThrow('too many')
    expect(() => normalizeMcpTools([{ ...rawTool, inputSchema: { type: 'object', description: 'x'.repeat(17000) } }])).toThrow('size')
    expect(() => normalizeMcpTools(Array.from({ length: 30 }, (_, i) => ({ ...rawTool, name: `tool${i}`, description: 'x'.repeat(3000) })))).toThrow('size')
    let nested: unknown = {}; for (let i = 0; i < 35; i++) nested = { child: nested }
    expect(() => canonicalMcpJson(nested)).toThrow('deeply')
    expect(() => canonicalMcpJson({ value: NaN })).toThrow('finite')
})

test('creation idempotency uses a project-key HMAC and metadata get reveals no credential', async () => {
    const t = setup(), first = await t.request(t.input)
    await t.request(t.input, 'project-b')
    const records = t.vault.db.query('SELECT project_id,creation_fingerprint FROM mcp_connections ORDER BY project_id').all() as Array<{ project_id: string; creation_fingerprint: string }>
    const guess = createHash('sha256').update(canonicalMcpJson(t.input)).digest('hex')
    expect(records).toHaveLength(2)
    expect(records[0].creation_fingerprint).not.toBe(guess)
    expect(records[0].creation_fingerprint).not.toBe(records[1].creation_fingerprint)
    expect(await t.request(t.input)).toEqual(first)
    const metadata = await t.request({ action: 'get', id: t.input.id })
    expect(metadata).toEqual(first)
    expect(JSON.stringify(metadata)).not.toContain(t.input.auth.token)
    await expect(t.request({ action: 'get', id: t.input.id }, 'project-c')).rejects.toThrow('not found')
})
