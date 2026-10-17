import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GithubCommitStatusSchema } from '@hapi/protocol/evolvedDevelopment'
import { EvolvedVault, type VaultRequest } from './vault'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const token = `github_pat_${'s'.repeat(40)}`
const sha = 'c'.repeat(40)
const manage = (action: string, extra: Record<string, unknown> = {}): VaultRequest => ({ userId: 'u', projectId: 'p', operation: 'github', payload: { action, ...extra } })
type Handler = (url: URL) => Response | undefined | Promise<Response | undefined>

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-status-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    let handler: Handler | undefined, identity = { id: 12, full_name: 'Owner/Repo', default_branch: 'main' }
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        calls.push({ url: url.toString(), method: init.method ?? 'GET', authorization: new Headers(init.headers).get('authorization') })
        const custom = await handler?.(url)
        if (custom) return custom
        if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' })
        if (url.pathname === '/repos/owner/repo') return Response.json(identity)
        if (url.pathname.includes('/status')) return Response.json({ state: 'success', sha, total_count: 1, statuses: [{ context: 'ci/odoo.sh', state: 'success', description: 'Build ok', target_url: 'https://www.odoo.sh/project/demo/build/1?token=secret#x', updated_at: '2026-10-17T10:00:00Z', creator: { login: 'bot' } }] })
        return new Response('not found', { status: 404 })
    }) as typeof fetch
    const vault = new EvolvedVault({ dbPath: join(dir, 'vault.db'), masterKeyFile: join(dir, 'master'), githubFetcher: fetcher })
    cleanup.push(() => vault.close())
    const connect = async () => { await vault.request(manage('connect', { token })); await vault.request(manage('grant', { repository: 'owner/repo', permission: 'read' })) }
    const status = async (extra: Record<string, unknown> = {}) => GithubCommitStatusSchema.parse(await vault.request(manage('commitStatus', { repositoryId: '12', ...extra })))
    return { vault, calls, connect, status, handle: (value?: Handler) => { handler = value }, identity: (value: typeof identity) => { identity = value } }
}

describe('GitHub combined commit status (fixed read)', () => {
    test('reads only the fixed status endpoint of the granted repository, returns canonical SHA and sanitized fields', async () => {
        const s = fixture(); await s.connect()
        const result = await s.status({ ref: 'feature/odoo-20' })
        expect(result).toMatchObject({ state: 'success', repositoryId: '12', fullName: 'owner/repo', ref: 'feature/odoo-20', sha, totalCount: 1, truncated: false })
        expect(result.statuses).toEqual([{ context: 'ci/odoo.sh', state: 'success', description: 'Build ok', targetUrl: 'https://www.odoo.sh/project/demo/build/1', updatedAt: '2026-10-17T10:00:00Z' }])
        const statusCall = s.calls.find(call => call.url.includes('/status'))!
        expect(statusCall.url).toBe('https://api.github.com/repos/owner/repo/commits/feature/odoo-20/status?per_page=100')
        expect(statusCall.method).toBe('GET')
        expect(JSON.stringify(result)).not.toContain(token)
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(JSON.stringify(result)).not.toContain('creator')
    })
    test('defaults to the repository default branch', async () => {
        const s = fixture(); await s.connect()
        expect((await s.status()).ref).toBe('main')
        expect(s.calls.some(call => call.url === 'https://api.github.com/repos/owner/repo/commits/main/status?per_page=100')).toBe(true)
    })
    test('a commit without statuses is no_status even though GitHub reports pending', async () => {
        const s = fixture(); await s.connect()
        s.handle(url => url.pathname.includes('/status') ? Response.json({ state: 'pending', sha, total_count: 0, statuses: [] }) : undefined)
        expect((await s.status()).state).toBe('no_status')
    })
    test('distinguishes permission_missing, credential_rejected, ref_not_found and unavailable', async () => {
        const s = fixture(); await s.connect()
        for (const [code, expected] of [[403, 'permission_missing'], [401, 'credential_rejected'], [404, 'ref_not_found'], [422, 'ref_not_found'], [500, 'unavailable']] as const) {
            s.handle(url => url.pathname.includes('/status') ? Response.json({ message: `raw provider body ${token}` }, { status: code }) : undefined)
            const result = await s.status({ ref: sha })
            expect(result.state).toBe(expected)
            expect(result.sha).toBeNull()
            expect(JSON.stringify(result)).not.toContain('raw provider body')
        }
        s.handle(url => url.pathname === '/repos/owner/repo' ? new Response('', { status: 403 }) : undefined)
        expect((await s.status()).state).toBe('permission_missing')
    })
    test('marks truncation when GitHub reports more contexts than returned', async () => {
        const s = fixture(); await s.connect()
        const statuses = Array.from({ length: 100 }, (_, index) => ({ context: `ctx-${index}`, state: 'failure', description: 'x'.repeat(500), target_url: 'javascript:alert(1)' }))
        s.handle(url => url.pathname.includes('/status') ? Response.json({ state: 'failure', sha, total_count: 130, statuses }) : undefined)
        const result = await s.status()
        expect(result).toMatchObject({ state: 'failure', totalCount: 130, truncated: true })
        expect(result.statuses).toHaveLength(100)
        expect(result.statuses[0]!.description!.length).toBe(140)
        expect(result.statuses[0]!.targetUrl).toBeNull()
    })
    test('unknown repositories, disconnected projects and renamed identities never reach the status endpoint', async () => {
        const s = fixture()
        expect((await s.status()).state).toBe('github_disconnected')
        await s.connect()
        expect((await s.status({ repositoryId: '99' })).state).toBe('not_granted')
        s.identity({ id: 13, full_name: 'owner/repo', default_branch: 'main' })
        await expect(s.status()).rejects.toMatchObject({ code: 'github_repository_changed' })
        expect(s.calls.some(call => call.url.includes('/status'))).toBe(false)
    })
    test('rejects invalid refs and repository ids before any provider request', async () => {
        const s = fixture(); await s.connect()
        const before = s.calls.length
        for (const ref of ['../x', '-x', 'a b', 'refs/heads/x?y', 'https://evil.test/x', 'a..b']) await expect(s.status({ ref })).rejects.toMatchObject({ code: 'invalid_repository' })
        await expect(s.vault.request(manage('commitStatus', { repositoryId: '../12' }))).rejects.toMatchObject({ code: 'invalid_repository' })
        expect(s.calls.length).toBe(before)
    })
    test('a grant revoked while the request is in flight is not reported', async () => {
        const s = fixture(); await s.connect()
        s.handle(async url => {
            if (url.pathname === '/repos/owner/repo') { await s.vault.request(manage('revoke', { repositoryId: '12' })); return Response.json({ id: 12, full_name: 'owner/repo', default_branch: 'main' }) }
            return undefined
        })
        await expect(s.status()).rejects.toMatchObject({ code: 'github_revoked' })
        expect(s.calls.some(call => call.url.includes('/status'))).toBe(false)
    })
    test('existing status callers still receive the unchanged grant catalog', async () => {
        const s = fixture(); await s.connect()
        expect(await s.vault.request(manage('status'))).toEqual({ connected: true, account: { id: 1, login: 'owner' }, repositories: [{ id: '12', owner: 'owner', name: 'repo', fullName: 'owner/repo', permission: 'read' }] })
    })
})
