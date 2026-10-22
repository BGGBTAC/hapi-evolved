import { createHash, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { EvolvedError, type EvolvedStore } from './store'
import { createEvolvedRequestGuard, parseBody } from './security'
import { extensionAdministrationNow, extensionHuman, extensionSessionHash } from './extensionAccess'
import { agentDefinitionSchema, agentInstructionsFit, parsePluginManifest, PLUGIN_MANIFEST_FILE, PLUGIN_MAX_BYTES, type PluginManifest } from './pluginManifest'
import { developmentModuleUsage, pluginModuleSummaries, type DevelopmentModuleUsage } from './developmentModules'
import { loadBundledPlugins } from './bundledPlugins'

const repositorySchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/)
    .refine(value => !['.', '..'].includes(value.split('/')[1]!)).transform(value => value.toLowerCase())
const refSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/'))
const sourceSchema = z.object({ repository: repositorySchema, ref: refSchema.default('HEAD') }).strict()
const confirmationSchema = z.object({ previewId: z.string().uuid(), commitSha: z.string().regex(/^[a-f0-9]{40}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
type Source = { repository: string; repositoryId: string; commitSha: string; manifestSha256: string }
/** `bundled`: shipped with HAPI (immutable, in memory, never a table row); see ./bundledPlugins. */
export type InstalledPlugin = Source & { id: string; enabled: boolean; manifest: PluginManifest; installedAt: number; updatedAt: number; revision: number; invalid?: true; bundled?: true }
type PluginRow = { id: string; repository: string; repository_id: string; commit_sha: string; manifest_sha256: string; manifest: string; enabled: number; installed_at: number; updated_at: number; revision: number }
type PreviewRow = { id: string; user_id: string; session_hash: string; plugin_id: string | null; base_sha: string | null; repository: string; repository_id: string; commit_sha: string; manifest_sha256: string; manifest: string; expires_at: number }
export type PluginPreview = Source & { previewId: string; pluginId: string | null; expiresAt: number; manifest: PluginManifest }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const installed = (row: PluginRow): InstalledPlugin => {
    const metadata = { id: row.id, repository: row.repository, repositoryId: row.repository_id, commitSha: row.commit_sha, manifestSha256: row.manifest_sha256, installedAt: row.installed_at, updatedAt: row.updated_at, revision: row.revision }
    try { return { ...metadata, manifest: parsePluginManifest(row.manifest), enabled: !!row.enabled } }
    catch { return { ...metadata, invalid: true, enabled: false, manifest: { schemaVersion: 1, id: 'invalid-plugin', name: 'Ungültiges Plugin', description: 'Gespeicherte Definition ist ungültig. Deinstalliere das Plugin und prüfe die Quelle erneut.', version: '0.0.0', agents: [], skills: [], themes: [], developmentModules: [] } } }
}
// `revision` advances on every update and every enable/disable (lifecycle generation); a pending update preview is then stale.
const revisionHash = (plugin: InstalledPlugin) => digest(`${plugin.commitSha}:${plugin.manifestSha256}:${plugin.revision}`)

export class PluginService {
    private activeFetches = 0
    private readonly attempts = new Map<string, { count: number; until: number }>()
    constructor(readonly store: EvolvedStore, private readonly fetcher: typeof fetch = fetch, readonly bundled: readonly InstalledPlugin[] = loadBundledPlugins()) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_plugins (
            id TEXT PRIMARY KEY,repository TEXT NOT NULL,repository_id TEXT NOT NULL UNIQUE,commit_sha TEXT NOT NULL,
            manifest_sha256 TEXT NOT NULL,manifest TEXT NOT NULL,enabled INTEGER NOT NULL,installed_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1
        ); CREATE TABLE IF NOT EXISTS evolved_plugin_previews (
            id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,session_hash TEXT NOT NULL,
            plugin_id TEXT REFERENCES evolved_plugins(id) ON DELETE CASCADE,base_sha TEXT,repository TEXT NOT NULL,repository_id TEXT NOT NULL,
            commit_sha TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,manifest TEXT NOT NULL,expires_at INTEGER NOT NULL
        );`)
    }
    list(): InstalledPlugin[] { return [...this.bundled, ...(this.store.db.query('SELECT * FROM evolved_plugins ORDER BY installed_at,id').all() as PluginRow[]).map(installed)] }
    /** Cheap change detection for registries that cache parsed manifests. */
    versions(): Array<{ id: string; revision: number; manifestSha256: string; enabled: boolean }> {
        const rows = (this.store.db.query('SELECT id,revision,manifest_sha256,enabled FROM evolved_plugins ORDER BY installed_at,id').all() as Array<{ id: string; revision: number; manifest_sha256: string; enabled: number }>)
            .map(row => ({ id: row.id, revision: row.revision, manifestSha256: row.manifest_sha256, enabled: !!row.enabled }))
        return [...this.bundled.map(plugin => ({ id: plugin.id, revision: plugin.revision, manifestSha256: plugin.manifestSha256, enabled: plugin.enabled })), ...rows]
    }
    private bundledPlugin(id: string): InstalledPlugin | null { return this.bundled.find(plugin => plugin.id === id) ?? null }
    /** Plugin routes never change, replace or remove a bundled plugin. */
    private assertMutable(id: string): void {
        if (this.bundledPlugin(id)) throw new EvolvedError('plugin_bundled', 'Bundled plugins ship with HAPI and cannot be updated, disabled or uninstalled.', 409)
    }
    private assertNoBundledCollision(repository: string, repositoryId: string | null, manifestId: string | null): void {
        if (this.bundled.some(plugin => plugin.repository === repository || plugin.repositoryId === repositoryId || plugin.manifest.id === manifestId))
            throw new EvolvedError('plugin_bundled', 'This plugin ships with HAPI and cannot be installed or replaced from GitHub.', 409)
    }
    /**
     * Lifecycle change. Every effective enable/disable advances the monotonic `revision`, so in-flight development-module
     * snapshots detect a disable/re-enable (ABA) even when the module digest is unchanged. Call inside a write transaction.
     */
    setEnabled(id: string, enabled: boolean): void {
        this.assertMutable(id)
        const row = this.store.db.query('SELECT enabled FROM evolved_plugins WHERE id=?').get(id) as { enabled: number } | null
        if (!row) throw new EvolvedError('plugin_not_found', 'Plugin not found.', 404)
        if (!!row.enabled !== enabled) this.store.db.prepare('UPDATE evolved_plugins SET enabled=?,updated_at=?,revision=revision+1 WHERE id=?').run(enabled ? 1 : 0, this.store.now(), id)
    }
    find(id: string): InstalledPlugin | null {
        const bundled = this.bundledPlugin(id)
        if (bundled) return bundled
        const row = this.store.db.query('SELECT * FROM evolved_plugins WHERE id=?').get(id) as PluginRow | null
        return row ? installed(row) : null
    }
    get(id: string): InstalledPlugin {
        const bundled = this.bundledPlugin(id)
        if (bundled) return bundled
        const row = this.store.db.query('SELECT * FROM evolved_plugins WHERE id=?').get(id) as PluginRow | null
        if (!row) throw new EvolvedError('plugin_not_found', 'Plugin not found.', 404)
        return installed(row)
    }
    private async read(url: string, maximum: number, accept = 'application/json'): Promise<string> {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
        let cancel: (() => Promise<void>) | undefined
        try {
            const response = await this.fetcher(url, { headers: { accept, 'user-agent': 'HAPI-eVolved-PluginInstaller' }, redirect: 'error', signal: controller.signal })
            if (response.status !== 200 || !response.body) throw new Error('Provider rejected request')
            const reader = response.body.getReader()
            cancel = () => reader.cancel()
            const decoder = new TextDecoder('utf-8', { fatal: true }); let result = '', bytes = 0
            while (true) {
                const part = await reader.read()
                if (part.done) break
                bytes += part.value.byteLength
                if (bytes > maximum) throw new Error('Provider response too large')
                result += decoder.decode(part.value, { stream: true })
            }
            return result + decoder.decode()
        } catch { throw new EvolvedError('plugin_source_unavailable', 'Public GitHub plugin could not be read. Check repository, ref, manifest and GitHub limits.', 502) }
        finally { clearTimeout(timeout); controller.abort(); await cancel?.().catch(() => {}) }
    }
    async fetchPreview(userId: string, source: z.infer<typeof sourceSchema>, pluginId?: string) {
        const now = this.store.now()
        for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key)
        const rate = this.attempts.get(userId) ?? { count: 0, until: now + 60_000 }
        if (rate.count >= 6 || this.activeFetches >= 4) throw new EvolvedError('plugin_rate_limited', 'Plugin previews are busy. Try again shortly.', 429)
        rate.count++; this.attempts.set(userId, rate)
        if (pluginId) this.assertMutable(pluginId)
        else this.assertNoBundledCollision(source.repository, null, null)
        const previous = pluginId ? this.get(pluginId) : undefined
        if (previous?.invalid) throw new EvolvedError('plugin_invalid', 'Remove the invalid plugin before reviewing a fresh installation.', 409)
        if (previous && previous.repository !== source.repository) throw new EvolvedError('plugin_source_changed', 'An update must use the installed repository.', 409)
        this.activeFetches++
        try {
            const metadata = JSON.parse(await this.read(`https://api.github.com/repos/${source.repository}`, 128 * 1024)) as Record<string, unknown>
            if (!Number.isSafeInteger(metadata.id) || (metadata.id as number) <= 0 || metadata.private !== false
                || typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== source.repository) throw new EvolvedError('plugin_source_invalid', 'A matching public GitHub repository is required.', 400)
            const repositoryId = String(metadata.id)
            if (previous && previous.repositoryId !== repositoryId) throw new EvolvedError('plugin_source_changed', 'The repository identity changed. Review it as a new source.', 409)
            const commit = (await this.read(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`, 64, 'application/vnd.github.sha')).trim()
            if (!/^[a-fA-F0-9]{40}$/.test(commit)) throw new EvolvedError('plugin_source_invalid', 'GitHub did not return a complete commit SHA.', 502)
            const commitSha = commit.toLowerCase(), raw = await this.read(`https://raw.githubusercontent.com/${source.repository}/${commitSha}/${PLUGIN_MANIFEST_FILE}`, PLUGIN_MAX_BYTES)
            const manifest = parsePluginManifest(raw)
            if (previous && previous.manifest.id !== manifest.id) throw new EvolvedError('plugin_identity_changed', 'An update must retain the plugin identifier.', 409)
            if (!previous) this.assertNoBundledCollision(source.repository, repositoryId, manifest.id)
            if (previous) this.assertDependencies(previous.id, manifest)
            return { repository: source.repository, repositoryId, commitSha, manifestSha256: digest(raw), raw, manifest, previous }
        } catch (error) {
            if (error instanceof EvolvedError) throw error
            throw new EvolvedError('plugin_source_invalid', 'GitHub returned invalid plugin metadata.', 502)
        } finally { this.activeFetches-- }
    }
    savePreview(userId: string, sessionHash: string, fetched: Awaited<ReturnType<PluginService['fetchPreview']>>): PluginPreview {
        const now = this.store.now()
        this.store.db.prepare('DELETE FROM evolved_plugin_previews WHERE expires_at<=?').run(now)
        const counts = this.store.db.query('SELECT COUNT(*) AS total,COALESCE(SUM(user_id=?),0) AS own FROM evolved_plugin_previews').get(userId) as { total: number; own: number }
        if (counts.total >= 64 || counts.own >= 8) throw new EvolvedError('plugin_preview_limit', 'Too many pending plugin previews.', 429)
        const previewId = randomUUID(), expiresAt = now + 10 * 60_000
        this.store.db.prepare('INSERT INTO evolved_plugin_previews VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(previewId, userId, sessionHash, fetched.previous?.id ?? null,
            fetched.previous ? revisionHash(fetched.previous) : null, fetched.repository, fetched.repositoryId, fetched.commitSha, fetched.manifestSha256, fetched.raw, expiresAt)
        return { previewId, pluginId: fetched.previous?.id ?? null, repository: fetched.repository, repositoryId: fetched.repositoryId, commitSha: fetched.commitSha,
            manifestSha256: fetched.manifestSha256, expiresAt, manifest: fetched.manifest }
    }
    /** An update must not remove a development module that a project has active (its settings and tasks would silently lose their definition). */
    private assertModuleDependencies(pluginId: string, next: PluginManifest) {
        const prefix = `plugin:${pluginId}:`, kept = new Set(next.developmentModules.map(module => module.id))
        for (const row of this.store.db.query('SELECT settings FROM evolved_project_development').all() as Array<{ settings: string }>) {
            let value: unknown; try { value = JSON.parse(row.settings) } catch { continue }
            const active = value && typeof value === 'object' && 'schemaVersion' in value && typeof value.schemaVersion === 'number' && value.schemaVersion >= 2 && 'settings' in value && value.settings && typeof value.settings === 'object'
                && 'activeModuleId' in value.settings ? value.settings.activeModuleId : null
            if (typeof active === 'string' && active.startsWith(prefix) && !kept.has(active.slice(prefix.length))) throw new EvolvedError('plugin_dependency', 'A project still uses a development module this update removes. Select another module in that project before updating.', 409)
        }
    }
    private assertDependencies(pluginId: string, next: PluginManifest) {
        this.assertModuleDependencies(pluginId, next)
        if (!this.store.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='evolved_agent_catalog'").get()) return
        const available = new Set(next.skills.map(skill => `plugin:${pluginId}:${skill.id}`))
        // Include disabled definitions too: a later re-enable must not turn a
        // previously saved template into an assignment that can never fit.
        const resolvedSkills = new Map<string, PluginManifest['skills'][number]>(this.list().filter(plugin => plugin.id !== pluginId && !plugin.invalid)
            .flatMap(plugin => plugin.manifest.skills.map(skill => [`plugin:${plugin.id}:${skill.id}`, skill] as const)))
        for (const skill of next.skills) resolvedSkills.set(`plugin:${pluginId}:${skill.id}`, skill)
        const custom = this.store.db.query('SELECT definition FROM evolved_agent_catalog').all() as Array<{ definition: string }>
        for (const row of custom) {
            let value: unknown; try { value = JSON.parse(row.definition) } catch { continue }
            const refs = value && typeof value === 'object' && 'skills' in value ? value.skills : []
            if (Array.isArray(refs) && refs.some(id => typeof id === 'string' && id.startsWith(`plugin:${pluginId}:`) && !available.has(id))) throw new EvolvedError('plugin_dependency', 'A global agent still uses a removed skill. Edit that agent before updating.', 409)
            const definition = agentDefinitionSchema.safeParse(value)
            if (definition.success && definition.data.skills.some(id => id.startsWith(`plugin:${pluginId}:`))) {
                const skills = definition.data.skills.flatMap(id => { const skill = resolvedSkills.get(id); return skill ? [skill] : [] })
                if (!agentInstructionsFit(definition.data, skills)) throw new EvolvedError('plugin_dependency', 'Updated skills leave too little room for a global agent assignment. Edit that agent before updating.', 409)
            }
        }
    }
    install(userId: string, sessionHash: string, confirmation: z.infer<typeof confirmationSchema>, pluginId?: string): InstalledPlugin {
        if (pluginId) this.assertMutable(pluginId)
        const preview = this.store.db.query('SELECT * FROM evolved_plugin_previews WHERE id=?').get(confirmation.previewId) as PreviewRow | null
        if (!preview || preview.expires_at <= this.store.now() || preview.user_id !== userId || preview.session_hash !== sessionHash) throw new EvolvedError('plugin_preview_expired', 'Open a fresh preview in this session.', 409)
        if (preview.plugin_id !== (pluginId ?? null) || preview.commit_sha !== confirmation.commitSha || preview.manifest_sha256 !== confirmation.manifestSha256 || digest(preview.manifest) !== confirmation.manifestSha256) {
            throw new EvolvedError('plugin_preview_changed', 'Confirmation does not match the preview.', 409)
        }
        const manifest = parsePluginManifest(preview.manifest), now = this.store.now()
        const id = pluginId ?? randomUUID()
        if (!pluginId) this.assertNoBundledCollision(preview.repository, preview.repository_id, manifest.id)
        if (pluginId) {
            const current = this.get(pluginId)
            if (current.invalid || revisionHash(current) !== preview.base_sha || current.repositoryId !== preview.repository_id || current.manifest.id !== manifest.id) throw new EvolvedError('plugin_update_conflict', 'Installed plugin changed. Review a new update preview.', 409)
            this.assertDependencies(pluginId, manifest)
            this.store.db.prepare('UPDATE evolved_plugins SET commit_sha=?,manifest_sha256=?,manifest=?,updated_at=?,revision=revision+1 WHERE id=?').run(preview.commit_sha, preview.manifest_sha256, preview.manifest, now, id)
        } else {
            const existing = this.list()
            if (existing.length >= 50) throw new EvolvedError('plugin_limit', 'At most 50 plugins can be installed.', 409)
            if (existing.some(item => item.repositoryId === preview.repository_id || item.manifest.id === manifest.id)) throw new EvolvedError('plugin_exists', 'This plugin is already installed. Use an update preview.', 409)
            this.store.db.prepare('INSERT INTO evolved_plugins VALUES(?,?,?,?,?,?,1,?,?,1)').run(id, preview.repository, preview.repository_id, preview.commit_sha, preview.manifest_sha256, preview.manifest, now, now)
        }
        this.store.db.prepare('DELETE FROM evolved_plugin_previews WHERE id=?').run(preview.id)
        this.store.audit(userId, null, pluginId ? 'plugin.updated' : 'plugin.installed', `${id}@${preview.commit_sha}`)
        return this.get(id)
    }
}

/** Plugin responses list contributed development modules with digest and availability (bounded summaries). */
const withModules = (plugin: InstalledPlugin, usage?: DevelopmentModuleUsage) => ({ ...plugin, developmentModules: pluginModuleSummaries(plugin, usage) })
export function createPluginRoutes(service: PluginService, origin: string): Hono {
    const app = new Hono(), store = service.store
    // Update previews show, per module, how many projects have it active and would need adoption; the existing confirmation suffices.
    const previewWithModules = (preview: PluginPreview) => ({ ...preview, developmentModules: pluginModuleSummaries({ ...preview, id: preview.pluginId, enabled: preview.pluginId ? service.find(preview.pluginId)?.enabled ?? true : true },
        preview.pluginId ? developmentModuleUsage(store) : undefined) })
    for (const path of ['/plugins', '/plugins/*']) {
        app.use(path, createEvolvedRequestGuard(origin))
        app.use(path, bodyLimit({ maxSize: 16_384, onError: c => c.json({ code: 'body_too_large', error: 'Plugin request is too large.' }, 413) }))
    }
    app.get('/plugins', async c => {
        // Installation-wide project counts only for the installation administrator.
        const principal = await extensionHuman(c, store), usage = principal.user.isAdmin ? developmentModuleUsage(store) : undefined
        return c.json({ plugins: service.list().map(plugin => withModules(plugin, usage)) })
    })
    app.post('/plugins/preview', async c => {
        const principal = await extensionHuman(c, store, true), source = await parseBody(c, sourceSchema)
        const fetched = await service.fetchPreview(principal.user.id, source)
        await extensionHuman(c, store, true)
        const preview = store.db.transaction(() => { extensionAdministrationNow(c, store); return service.savePreview(principal.user.id, extensionSessionHash(c), fetched) }).immediate()
        return c.json({ preview: previewWithModules(preview) })
    })
    app.post('/plugins/:id/preview-update', async c => {
        const principal = await extensionHuman(c, store, true), body = await parseBody(c, z.object({ ref: refSchema.default('HEAD') }).strict()), current = service.get(c.req.param('id'))
        const fetched = await service.fetchPreview(principal.user.id, { repository: current.repository, ref: body.ref }, current.id)
        await extensionHuman(c, store, true)
        const preview = store.db.transaction(() => { extensionAdministrationNow(c, store); return service.savePreview(principal.user.id, extensionSessionHash(c), fetched) }).immediate()
        return c.json({ preview: previewWithModules(preview) })
    })
    for (const path of ['/plugins', '/plugins/:id/update']) app.post(path, async c => {
        await extensionHuman(c, store, true); const body = await parseBody(c, confirmationSchema)
        const plugin = store.db.transaction(() => { const principal = extensionAdministrationNow(c, store); return service.install(principal.user.id, extensionSessionHash(c), body, c.req.param('id')) }).immediate()
        return c.json({ plugin: withModules(plugin, developmentModuleUsage(store)) }, path === '/plugins' ? 201 : 200)
    })
    app.put('/plugins/:id', async c => {
        await extensionHuman(c, store, true); const body = await parseBody(c, z.object({ enabled: z.boolean() }).strict())
        const plugin = store.db.transaction(() => {
            const principal = extensionAdministrationNow(c, store), current = service.get(c.req.param('id'))
            if (current.invalid && body.enabled) throw new EvolvedError('plugin_invalid', 'Invalid plugins cannot be enabled. Remove the plugin and review its source again.', 409)
            service.setEnabled(current.id, body.enabled)
            store.audit(principal.user.id, null, body.enabled ? 'plugin.enabled' : 'plugin.disabled', current.id)
            return service.get(current.id)
        }).immediate()
        return c.json({ plugin: withModules(plugin, developmentModuleUsage(store)) })
    })
    app.delete('/plugins/:id', async c => {
        await extensionHuman(c, store, true)
        store.db.transaction(() => { const principal = extensionAdministrationNow(c, store), current = service.get(c.req.param('id')); if (current.bundled) throw new EvolvedError('plugin_bundled', 'Bundled plugins ship with HAPI and cannot be uninstalled.', 409); store.db.prepare('DELETE FROM evolved_plugins WHERE id=?').run(current.id); store.audit(principal.user.id, null, 'plugin.uninstalled', current.id) }).immediate()
        return c.json({ ok: true })
    })
    return app
}
