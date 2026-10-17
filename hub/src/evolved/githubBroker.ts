import type { Database } from 'bun:sqlite'
import { EvolvedError } from './store'
import { boundedGitResponse, GIT_TIMEOUT_MS, gitBodyHash, gitPath, githubRepository, type GitCredentialRequest } from './githubProtocol'
import { GitBranchSchema, GitRefSchema, GitShaSchema, RepositoryIdSchema, type GithubCommitStatus } from '@hapi/protocol/evolvedDevelopment'

type Cipher = { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }
type Connection = { project_id: string; generation: number; revision: number; account_id: number | null; login: string | null; nonce: Uint8Array | null; ciphertext: Uint8Array | null; tag: Uint8Array | null }
type Grant = { project_id: string; repository_id: string; owner: string; name: string; permission: 'read' | 'write'; generation: number }
type Crypto = { encrypt(projectId: string, generation: number, token: Buffer): Cipher; decrypt(projectId: string, generation: number, value: Cipher): Buffer }
export type GithubStatus = { connected: boolean; account?: { id: number; login: string }; repositories: Array<{ id: string; owner: string; name: string; fullName: string; permission: 'read' | 'write' }> }
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : null
/** Status links are shown to people and agents: https only, no credentials, query or fragment. */
function statusLink(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2000) return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
        url.search = ''; url.hash = ''
        return url.href.length <= 500 ? url.href : null
    } catch { return null }
}

/** Vault-local credential consumer. Only fixed GitHub account/repository/Git endpoints exist. */
export class GithubBroker {
    private readonly active = new Map<AbortController, { projectId: string; repositoryId: string }>()
    constructor(private readonly db: Database, private readonly crypto: Crypto, private readonly fetcher: typeof fetch = fetch) {
        db.exec(`CREATE TABLE IF NOT EXISTS github_connections(project_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,account_id INTEGER,login TEXT,nonce BLOB,ciphertext BLOB,tag BLOB);
            CREATE TABLE IF NOT EXISTS github_repositories(project_id TEXT NOT NULL,repository_id TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,permission TEXT NOT NULL CHECK(permission IN ('read','write')),generation INTEGER NOT NULL,PRIMARY KEY(project_id,repository_id),UNIQUE(project_id,owner,name));`)
    }
    close(): void { for (const controller of this.active.keys()) controller.abort() }
    private state(projectId: string): Connection {
        this.db.prepare('INSERT OR IGNORE INTO github_connections(project_id) VALUES(?)').run(projectId)
        return this.db.prepare('SELECT * FROM github_connections WHERE project_id=?').get(projectId) as Connection
    }
    private current(projectId: string, generation: number): Connection {
        const state = this.state(projectId)
        if (state.generation !== generation || !state.ciphertext || this.db.prepare('SELECT 1 FROM revoked_projects WHERE project_id=?').get(projectId)) {
            throw new EvolvedError('github_revoked', 'GitHub authorization changed; reconnect or retry explicitly.', 403)
        }
        return state
    }
    private token(state: Connection): Buffer {
        if (!state.nonce || !state.ciphertext || !state.tag) throw new EvolvedError('github_disconnected', 'Connect a GitHub account first.', 409)
        return this.crypto.decrypt(state.project_id, state.generation, { nonce: state.nonce, ciphertext: state.ciphertext, tag: state.tag })
    }
    private audit(userId: string, projectId: string, operation: string, target?: string): void {
        this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, `github.${operation}`, target ?? null, Date.now())
    }
    private abort(projectId: string, repositoryId?: string): void {
        for (const [controller, scope] of this.active) if (scope.projectId === projectId && (!repositoryId || scope.repositoryId === repositoryId)) controller.abort()
    }
    purge(projectId: string): void {
        this.abort(projectId)
        this.db.prepare('DELETE FROM github_repositories WHERE project_id=?').run(projectId)
        this.db.prepare('DELETE FROM github_connections WHERE project_id=?').run(projectId)
    }
    status(projectId: string): GithubStatus {
        const state = this.state(projectId)
        const connected = state.account_id !== null && state.login !== null && state.ciphertext !== null
        const repositories = (this.db.prepare('SELECT * FROM github_repositories WHERE project_id=? ORDER BY owner,name').all(projectId) as Grant[])
            .map(row => ({ id: row.repository_id, owner: row.owner, name: row.name, fullName: `${row.owner}/${row.name}`, permission: row.permission }))
        return { connected, ...(connected ? { account: { id: state.account_id!, login: state.login! } } : {}), repositories }
    }
    private async api(path: string, token: Buffer, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const response = await this.read(path, token, signal)
        if (response.status !== 200) throw new EvolvedError('github_access_denied', 'GitHub rejected the credential or repository access.', 403)
        return response.value!
    }
    /** Fixed GET endpoints only: account, repository metadata and combined commit status. Bodies stay inside the Vault. */
    private async read(path: string, token: Buffer, signal?: AbortSignal, limit = 256 * 1024): Promise<{ status: number; value?: Record<string, unknown> }> {
        if (path !== '/user' && !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/commits\/[A-Za-z0-9._/%-]{1,600}\/status\?per_page=100)?$/.test(path)) throw new EvolvedError('github_path_denied', 'GitHub endpoint denied.', 403)
        const response = await this.fetcher(`https://api.github.com${path}`, { headers: {
            authorization: `Bearer ${token.toString('utf8')}`, accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28', 'user-agent': 'HAPI-eVolved/0.1.0',
        }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
        if (response.status !== 200) { await response.body?.cancel(); return { status: response.status } }
        const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = []
        try {
            if (!reader) throw new Error('empty')
            while (true) {
                const next = await reader.read(); if (next.done) break
                size += next.value.byteLength
                if (size > limit) throw new Error('size')
                chunks.push(next.value)
            }
            const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
            return { status: 200, value: value as Record<string, unknown> }
        } catch { await reader?.cancel().catch(() => {}); throw new EvolvedError('github_response_invalid', 'GitHub metadata response is invalid.', 502) }
        finally { reader?.releaseLock() }
    }
    /**
     * Read-only combined commit status of one granted repository (numeric grant id).
     * Missing status, missing permission and provider failures are distinct states; never success by default.
     */
    async commitStatus(_userId: string, projectId: string, payload: Record<string, unknown>): Promise<GithubCommitStatus> {
        const repositoryId = RepositoryIdSchema.safeParse(payload.repositoryId), ref = payload.ref === undefined ? undefined : GitRefSchema.safeParse(payload.ref)
        if (!repositoryId.success || ref && !ref.success) throw new EvolvedError('invalid_repository', 'Repository identifier and a branch or full commit SHA are required.')
        const observedAt = Date.now(), requested = ref?.data ?? ''
        const empty = (state: GithubCommitStatus['state'], fullName = '', at = requested): GithubCommitStatus => ({ state, repositoryId: repositoryId.data, fullName, ref: at, sha: null, observedAt, totalCount: 0, truncated: false, statuses: [] })
        const state = this.state(projectId)
        if (state.account_id === null || !state.ciphertext) return empty('github_disconnected')
        this.current(projectId, state.generation)
        const grant = this.db.prepare('SELECT * FROM github_repositories WHERE project_id=? AND repository_id=?').get(projectId, repositoryId.data) as Grant | null
        if (!grant) return empty('not_granted')
        const fullName = `${grant.owner}/${grant.name}`
        const stillGranted = () => {
            this.current(projectId, state.generation)
            const live = this.db.prepare('SELECT generation,owner,name FROM github_repositories WHERE project_id=? AND repository_id=?').get(projectId, grant.repository_id) as Pick<Grant, 'generation' | 'owner' | 'name'> | null
            if (!live || live.generation !== grant.generation || live.owner !== grant.owner || live.name !== grant.name) throw new EvolvedError('github_revoked', 'Repository grant changed.', 403)
        }
        const controller = new AbortController(), token = this.token(state)
        this.active.set(controller, { projectId, repositoryId: grant.repository_id })
        try {
            const meta = await this.read(`/repos/${grant.owner}/${grant.name}`, token, controller.signal)
            if (meta.status === 401) return empty('credential_rejected', fullName)
            if (meta.status === 403 || meta.status === 404) return empty('permission_missing', fullName)
            if (meta.status !== 200) return empty('unavailable', fullName)
            const parsed = githubRepository(meta.value!.full_name)
            if (String(meta.value!.id) !== grant.repository_id || parsed.owner.toLowerCase() !== grant.owner || parsed.name.toLowerCase() !== grant.name) throw new EvolvedError('github_repository_changed', 'Repository identity changed; grant it again explicitly.', 409)
            stillGranted()
            const branch = GitBranchSchema.safeParse(meta.value!.default_branch)
            const target = ref?.data ?? (branch.success ? branch.data : '')
            if (!target) return empty('unavailable', fullName, '')
            const encoded = target.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
            const response = await this.read(`/repos/${grant.owner}/${grant.name}/commits/${encoded}/status?per_page=100`, token, controller.signal, 1024 * 1024)
            stillGranted()
            if (response.status === 401) return empty('credential_rejected', fullName, target)
            if (response.status === 403) return empty('permission_missing', fullName, target)
            if (response.status === 404 || response.status === 422) return empty('ref_not_found', fullName, target)
            if (response.status !== 200) return empty('unavailable', fullName, target)
            const value = response.value!, sha = GitShaSchema.safeParse(value.sha), total = Number(value.total_count)
            if (!sha.success || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(value.statuses) || !['success', 'failure', 'pending'].includes(String(value.state))) {
                throw new EvolvedError('github_response_invalid', 'GitHub status response is invalid.', 502)
            }
            const statuses = (value.statuses as unknown[]).slice(0, 100).flatMap(item => {
                if (!item || typeof item !== 'object') return []
                const entry = item as Record<string, unknown>, entryState = String(entry.state)
                if (!['error', 'failure', 'pending', 'success'].includes(entryState)) return []
                const updated = typeof entry.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(entry.updated_at) && entry.updated_at.length <= 40 ? entry.updated_at : null
                return [{ context: text(entry.context, 100) || 'default', state: entryState as 'error' | 'failure' | 'pending' | 'success', description: text(entry.description, 140) || null, targetUrl: statusLink(entry.target_url), updatedAt: updated }]
            })
            // GitHub reports "pending" for a commit without any status; that is "no status", not progress.
            const combined = total === 0 ? 'no_status' : value.state as 'success' | 'failure' | 'pending'
            return { state: combined, repositoryId: grant.repository_id, fullName, ref: target, sha: sha.data, observedAt, totalCount: total, truncated: statuses.length < total, statuses }
        } catch (error) {
            if (error instanceof EvolvedError) throw error
            return empty('unavailable', fullName)
        } finally { this.active.delete(controller); token.fill(0) }
    }
    private async repository(owner: string, name: string, token: Buffer, signal?: AbortSignal) {
        const value = await this.api(`/repos/${owner}/${name}`, token, signal)
        const parsed = githubRepository(value.full_name)
        if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0 || parsed.owner.toLowerCase() !== owner.toLowerCase()
            || parsed.name.toLowerCase() !== name.toLowerCase()) throw new EvolvedError('github_repository_changed', 'Repository identity changed; grant the current repository explicitly.', 409)
        return { id: String(value.id), ...parsed }
    }
    async request(userId: string, projectId: string, payload: Record<string, unknown>): Promise<GithubStatus | GithubCommitStatus> {
        const state = this.state(projectId)
        if (payload.action === 'status') return this.status(projectId)
        if (payload.action === 'commitStatus') return this.commitStatus(userId, projectId, payload)
        if (payload.action === 'disconnect') {
            this.abort(projectId)
            this.db.transaction(() => {
                this.db.prepare('UPDATE github_connections SET generation=generation+1,revision=revision+1,account_id=NULL,login=NULL,nonce=NULL,ciphertext=NULL,tag=NULL WHERE project_id=?').run(projectId)
                this.db.prepare('DELETE FROM github_repositories WHERE project_id=?').run(projectId)
                this.audit(userId, projectId, 'disconnected')
            })()
            return this.status(projectId)
        }
        if (payload.action === 'connect') {
            if (typeof payload.token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,250}$/.test(payload.token)) throw new EvolvedError('github_token_invalid', 'Use a GitHub fine-grained personal access token.')
            const token = Buffer.from(payload.token)
            try {
                const account = await this.api('/user', token)
                if (!Number.isSafeInteger(account.id) || Number(account.id) <= 0 || typeof account.login !== 'string'
                    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account.login)) throw new EvolvedError('github_response_invalid', 'GitHub account response is invalid.', 502)
                this.db.transaction(() => {
                    if (this.state(projectId).revision !== state.revision || this.db.prepare('SELECT 1 FROM revoked_projects WHERE project_id=?').get(projectId)) throw new EvolvedError('github_revoked', 'Connection changed during validation; retry explicitly.', 409)
                    const generation = state.generation + 1, cipher = this.crypto.encrypt(projectId, generation, token)
                    this.db.prepare('UPDATE github_connections SET generation=?,revision=revision+1,account_id=?,login=?,nonce=?,ciphertext=?,tag=? WHERE project_id=?')
                        .run(generation, Number(account.id), account.login as string, cipher.nonce, cipher.ciphertext, cipher.tag, projectId)
                    this.db.prepare('DELETE FROM github_repositories WHERE project_id=?').run(projectId)
                    this.audit(userId, projectId, 'connected', String(account.id))
                })()
                this.abort(projectId)
            } finally { token.fill(0) }
            return this.status(projectId)
        }
        if (payload.action === 'revoke') {
            if (typeof payload.repositoryId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(payload.repositoryId)) throw new EvolvedError('invalid_repository', 'Repository identifier required.')
            this.db.prepare('DELETE FROM github_repositories WHERE project_id=? AND repository_id=?').run(projectId, payload.repositoryId)
            this.db.prepare('UPDATE github_connections SET revision=revision+1 WHERE project_id=?').run(projectId)
            this.abort(projectId, payload.repositoryId); this.audit(userId, projectId, 'grant.revoked', payload.repositoryId)
            return this.status(projectId)
        }
        if (payload.action === 'grant') {
            const { owner, name } = githubRepository(payload.repository)
            if (!['read', 'write'].includes(String(payload.permission))) throw new EvolvedError('invalid_permission', 'Choose read or write access.')
            const token = this.token(state)
            try {
                const repository = await this.repository(owner, name, token)
                this.current(projectId, state.generation)
                if (this.state(projectId).revision !== state.revision) throw new EvolvedError('github_revoked', 'Grant changed during validation; retry explicitly.', 409)
                this.db.prepare('INSERT INTO github_repositories VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,repository_id) DO UPDATE SET owner=excluded.owner,name=excluded.name,permission=excluded.permission,generation=excluded.generation')
                    .run(projectId, repository.id, repository.owner.toLowerCase(), repository.name.toLowerCase(), payload.permission as string, state.revision + 1)
                this.db.prepare('UPDATE github_connections SET revision=revision+1 WHERE project_id=?').run(projectId)
                this.abort(projectId, repository.id); this.audit(userId, projectId, 'grant.changed', repository.id)
            } finally { token.fill(0) }
            return this.status(projectId)
        }
        throw new EvolvedError('github_operation_denied', 'Unsupported GitHub operation.', 403)
    }
    async git(input: GitCredentialRequest, body: Uint8Array, signal?: AbortSignal): Promise<Response> {
        const { projectId, userId, payload } = input
        const git = payload.git; gitPath(git)
        if (body.length > 64 * 1024 * 1024 || gitBodyHash(body) !== payload.bodyHash || (git.advertisement && body.length !== 0)) throw new EvolvedError('git_body_invalid', 'Git body does not match its authorization.', 400)
        const state = this.state(projectId); this.current(projectId, state.generation)
        const grant = this.db.prepare('SELECT * FROM github_repositories WHERE project_id=? AND owner=? AND name=?').get(projectId, git.owner.toLowerCase(), git.name.toLowerCase()) as Grant | null
        if (!grant || !['restricted', 'workspace', 'extended'].includes(payload.profile)
            || (git.service === 'git-receive-pack' && (grant.permission !== 'write' || payload.profile === 'restricted'))) throw new EvolvedError('github_grant_denied', 'Repository operation is not granted for this project and profile.', 403)
        if (this.active.size >= 8 || [...this.active.values()].filter(value => value.projectId === projectId).length >= 2) throw new EvolvedError('github_busy', 'Git transfer concurrency limit reached.', 429)
        const controller = new AbortController(), token = this.token(state)
        const cancelled = () => controller.abort()
        signal?.addEventListener('abort', cancelled, { once: true }); if (signal?.aborted) cancelled()
        this.active.set(controller, { projectId, repositoryId: grant.repository_id })
        const timeout = setTimeout(cancelled, GIT_TIMEOUT_MS)
        const finish = () => { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled); this.active.delete(controller) }
        const stillGranted = () => {
            this.current(projectId, state.generation)
            const current = this.db.prepare('SELECT generation FROM github_repositories WHERE project_id=? AND repository_id=?').get(projectId, grant.repository_id) as { generation: number } | null
            if (!current || current.generation !== grant.generation) throw new EvolvedError('github_revoked', 'Repository grant changed.', 403)
        }
        try {
            const repository = await this.repository(grant.owner, grant.name, token, controller.signal)
            if (repository.id !== grant.repository_id) throw new EvolvedError('github_repository_changed', 'Repository identity changed; grant it again explicitly.', 409)
            stillGranted()
            const headers = new Headers({ authorization: `Basic ${Buffer.from(`x-access-token:${token.toString('utf8')}`).toString('base64')}`, 'user-agent': 'HAPI-eVolved/0.1.0', 'accept-encoding': 'identity' })
            if (!git.advertisement) headers.set('content-type', `application/x-${git.service}-request`)
            if (git.protocol) headers.set('git-protocol', git.protocol)
            const response = await this.fetcher(`https://github.com/${gitPath({ ...git, owner: repository.owner, name: repository.name })}`, {
                method: git.advertisement ? 'GET' : 'POST', headers, body: git.advertisement ? undefined : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
                redirect: 'error', signal: controller.signal,
            })
            stillGranted()
            const type = `application/x-${git.service}-${git.advertisement ? 'advertisement' : 'result'}`
            if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== type || response.headers.has('content-encoding')) {
                await response.body?.cancel(); throw new EvolvedError('github_git_failed', 'GitHub Git transport failed. A push may already have taken effect; inspect refs before retrying.', 502)
            }
            this.audit(userId, projectId, `${git.service}.started`, grant.repository_id)
            const clean = new Response(response.body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
            return boundedGitResponse(clean, controller, finish)
        } catch (error) {
            controller.abort(); finish()
            if (error instanceof EvolvedError) throw error
            throw new EvolvedError('github_unavailable', 'GitHub transfer interrupted. Inspect remote refs before retrying a push.', 502)
        } finally { token.fill(0) }
    }
}
