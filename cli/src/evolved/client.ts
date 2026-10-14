import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

export class EvolvedClient {
    readonly base: URL
    constructor(readonly projectId: string, url: string, private readonly tokenFile: string, private readonly fetcher: typeof fetch = fetch) {
        this.base = new URL(url)
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error('EVOLVED_PROJECT_ID is required')
        const localProxy = process.env.HAPI_EVOLVED_PROXY === '1' && this.base.hostname === 'runner-proxy' && this.base.port === '3010'
        if (this.base.username || this.base.password || (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && (localProxy || ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname))))) throw new Error('HAPI_EVOLVED_URL requires HTTPS or the isolated runner proxy')
        if (!tokenFile && process.env.HAPI_EVOLVED_PROXY !== '1') throw new Error('HAPI_EVOLVED_CAPABILITY_FILE is required')
    }
    private token(): string {
        if (process.env.HAPI_EVOLVED_PROXY === '1') return 'evolved-local'
        const fd = openSync(this.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
            const st = fstatSync(fd)
            if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 256 || (process.getuid && st.uid !== process.getuid())) throw new Error('Capability file must be private (0600) and owned by this user')
            const token = readFileSync(fd, 'utf8').trim()
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid capability file')
            return token
        } finally { closeSync(fd) }
    }
    async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new Error('Invalid Evolved API path')
        const response = await this.fetcher(new URL(`/api/evolved${path}`, this.base), {
            method, headers: { ...headers, authorization: `Bearer ${this.token()}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(70_000)
        })
        const payload = await response.json() as { error?: string }
        if (!response.ok) throw new Error(payload.error ?? `Evolved request failed (${response.status})`)
        return payload
    }
    projectPath(path: string): string { return `/projects/${encodeURIComponent(this.projectId)}${path}` }
}
export function evolvedClientFromEnvironment(): EvolvedClient {
    return new EvolvedClient(process.env.EVOLVED_PROJECT_ID ?? '', process.env.HAPI_EVOLVED_URL ?? process.env.HAPI_API_URL ?? 'http://127.0.0.1:3006', process.env.HAPI_EVOLVED_CAPABILITY_FILE ?? '')
}
