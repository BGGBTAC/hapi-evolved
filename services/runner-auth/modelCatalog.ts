import type { Provider, ProviderSummary } from './controller'

export type CatalogModel = { id: string; label: string; description?: string; contextWindow?: number; resolvedModel?: string; isDefault?: boolean; reasoningEfforts?: string[] }
export type ModelCatalog = {
    provider: Provider
    status: 'ready' | 'unavailable' | 'disconnected'
    method: ProviderSummary['method']
    source: 'native-cli'
    catalogOrigin: 'native-reported'
    entitlementVerified: false
    upstreamRefresh: 'unknown'
    checkedAt: number | null
    expiresAt: number | null
    models: CatalogModel[]
    message?: string
}
export type CatalogProcess = { done: Promise<unknown>; stop: () => Promise<void>; write: (text: string) => void }
export type CatalogRun = (provider: Provider, args: string[], onStdout: (stdout: string) => void) => CatalogProcess

const MAX_MODELS = 100
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,99}$/
const badText = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native catalog')
    return value as Record<string, unknown>
}
function modelId(value: unknown): string {
    if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid model identifier')
    return value
}

/** Only model selector metadata crosses the runner boundary; no native account or diagnostics. */
export function normalizeModels(provider: Provider, input: unknown): CatalogModel[] {
    if (!Array.isArray(input) || input.length > MAX_MODELS) throw new Error('Invalid model catalog size')
    const ids = new Set<string>()
    return input.map(value => {
        const item = record(value), id = modelId(provider === 'claude' ? item.value : item.model ?? item.id)
        if (ids.has(id)) throw new Error('Duplicate native model')
        ids.add(id)
        const label = item.displayName === undefined ? id : item.displayName
        if (typeof label !== 'string' || !label.trim() || label.length > 80 || badText.test(label)) throw new Error('Invalid model label')
        const model: CatalogModel = { id, label, isDefault: provider === 'claude' ? id === 'default' : item.isDefault === true }
        if (typeof item.description === 'string' && item.description.trim() && item.description.length <= 500 && !badText.test(item.description)) {
            model.description = item.description.trim()
        }
        // Optional native metadata, never inferred from a model name or marketing
        // description. A catalog limit does not establish a running thread's budget.
        const contextWindow = item.contextWindow ?? item.context_window
        if (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow
        if (provider === 'claude' && item.resolvedModel !== undefined) model.resolvedModel = modelId(item.resolvedModel)
        const efforts = provider === 'claude' ? item.supportedEffortLevels : item.supportedReasoningEfforts
        if (efforts !== undefined) {
            if (!Array.isArray(efforts) || efforts.length > 8) throw new Error('Invalid model capabilities')
            model.reasoningEfforts = [...new Set(efforts.map(effort => {
                const name = provider === 'claude' ? effort : record(effort).reasoningEffort
                if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Invalid reasoning effort')
                return name
            }))]
        }
        return model
    })
}

/** Native discovery sends only control messages. It never starts a thread or submits a prompt. */
export async function discoverModels(provider: Provider, run: CatalogRun): Promise<CatalogModel[]> {
    let process: CatalogProcess | undefined
    let offset = 0, nextId = 2, expectedId = 1, pages = 0, settled = false
    const models: CatalogModel[] = [], cursors = new Set<string>()
    let resolve!: (models: CatalogModel[]) => void, reject!: (error: Error) => void
    const response = new Promise<CatalogModel[]>((yes, no) => { resolve = yes; reject = no })
    const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error); else resolve(models)
    }
    const send = (value: unknown) => process!.write(`${JSON.stringify(value)}\n`)
    const onStdout = (stdout: string) => {
        try {
            for (;;) {
                const newline = stdout.indexOf('\n', offset)
                if (newline < 0) break
                const line = stdout.slice(offset, newline); offset = newline + 1
                if (!line.trim() || settled) continue
                if (Buffer.byteLength(line) > 131_072) throw new Error('Native catalog line too large')
                const message = record(JSON.parse(line))
                if (provider === 'claude') {
                    if (message.type !== 'control_response') continue
                    const envelope = record(message.response)
                    if (envelope.request_id !== 'hapi-model-catalog') continue
                    if (envelope.subtype !== 'success') throw new Error('Native catalog rejected')
                    models.push(...normalizeModels(provider, record(envelope.response).models))
                    finish()
                } else {
                    // App-server may send its own JSON-RPC requests whose IDs
                    // overlap ours. Only responses belong to this request flow.
                    if ('method' in message) continue
                    if (message.id !== expectedId) continue
                    if (message.error) throw new Error('Native catalog rejected')
                    const result = record(message.result)
                    if (expectedId === 1) {
                        send({ method: 'initialized' })
                        expectedId = nextId++
                        send({ id: expectedId, method: 'model/list', params: { limit: 50, includeHidden: false } })
                    } else {
                        models.push(...normalizeModels(provider, result.data))
                        if (models.length > MAX_MODELS || new Set(models.map(model => model.id)).size !== models.length) throw new Error('Invalid model pages')
                        const cursor = result.nextCursor
                        if (cursor === null || cursor === undefined) finish()
                        else {
                            if (typeof cursor !== 'string' || cursor.length > 512 || badText.test(cursor) || cursors.has(cursor) || ++pages >= 8) throw new Error('Invalid model cursor')
                            cursors.add(cursor); expectedId = nextId++
                            send({ id: expectedId, method: 'model/list', params: { limit: 50, includeHidden: false, cursor } })
                        }
                    }
                }
            }
        } catch { finish(new Error('Native model catalog could not be verified')) }
    }
    try {
        process = run(provider, provider === 'codex'
            ? ['-c', 'cli_auth_credentials_store="file"', '-c', 'mcp_servers={}', 'app-server']
            : ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--tools', ''], onStdout)
        void process.done.then(() => finish(new Error('Native catalog process ended')), () => finish(new Error('Native catalog process failed')))
        send(provider === 'codex'
            ? { id: 1, method: 'initialize', params: { clientInfo: { name: 'hapi-evolved-model-catalog', version: '1.0.0' }, capabilities: { experimentalApi: true } } }
            : { type: 'control_request', request_id: 'hapi-model-catalog', request: { subtype: 'initialize' } })
        return await response
    } finally { await process?.stop() }
}
