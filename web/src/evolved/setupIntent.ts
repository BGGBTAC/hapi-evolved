import { DevelopmentModuleDigestSchema, DevelopmentModuleIdSchema, DevelopmentModuleValuesSchema, type DevelopmentModuleValues } from '@hapi/protocol/developmentModules'
import { RepositoryIdSchema } from '@hapi/protocol/evolvedDevelopment'
import type { DevelopmentModuleSettingsInput } from '@hapi/protocol/developmentModules'

/**
 * Setup choices that are not saved yet ("vorgemerkt"): an intended module of exactly the revision the
 * user reviewed, the values typed for it and a repository to bind. Kept in this browser only, scoped
 * by hub, account and project, so a reload or a detour through GitHub does not lose them. It is a
 * draft: it never counts as configured, never reaches the hub without the regular CAS save and
 * holds no credentials (module fields are plain project data; tokens never pass through here).
 */
export type SetupIntent = {
    moduleId: string | null
    /** Digest of the module revision the user reviewed; a different installed digest requires explicit adoption. */
    moduleDigest: string | null
    values: DevelopmentModuleValues | null
    repositoryId: string | null
    createdAt: number
    /**
     * The unsaved module form as last edited in the setup wizard (including an explicit adoption of a newer module revision
     * and values typed for new required fields) and the revision it was based on. It may be invalid while being edited; it is
     * only ever sent through the regular CAS save, and a newer saved revision turns it into the existing visible conflict.
     */
    draft?: { baseRevision: number; settings: DevelopmentModuleSettingsInput } | null
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Typed shape of the builtin form sections. Stored drafts are untrusted input: every value the form renders must have the
 * type the form expects (a text, a number, a list of texts, a known choice), with exactly these keys. Values are NOT checked
 * for validity, so partial or temporarily invalid drafts (an SSH reference before its build, equal branches, an empty
 * required value, an unfinished branch name) survive and are shown with the regular field errors.
 */
type Kind = 'text' | 'text?' | 'number?' | 'boolean' | 'texts' | readonly (string | number | null)[] | Shape
type Shape = { readonly [key: string]: Kind }
const environmentShape: Shape = { branch: 'text?', buildId: 'text?', buildHost: 'text?', sshResourceId: 'text?', applicationResourceId: 'text?' }
const odooShape: Shape = {
    major: [19, 20], edition: ['community', 'enterprise'], hosting: ['odoo_sh', 'self_hosted', 'local'], addonsPaths: 'texts', modules: 'texts',
    developmentBranch: 'text?', enterpriseRepositoryId: 'text?', testDatabaseSlug: 'text', applicationResourceId: 'text?',
    odooSh: { dashboardUrl: 'text?', staging: environmentShape, production: environmentShape, unassigned: 'legacy' as never },
}
/** Legacy values without a stage (read-only until assigned): the old stage was "development" or not declared. */
const unassignedShape: Shape = { declaredStage: [null, 'development'], ...environmentShape }
const iosShape: Shape = { projectDirectory: 'text', projectFile: 'text?', scheme: 'text?', bundleId: 'text?', deploymentTarget: 'text?', buildStrategy: ['undecided', 'local_mac', 'xcode_cloud', 'github_actions'], xcodeCloudResourceId: 'text?' }
const androidShape: Shape = { projectDirectory: 'text', module: 'text', variant: 'text', applicationId: 'text?', minSdk: 'number?', targetSdk: 'number?', compileSdk: 'number?', jdkMajor: 'number?', sdkLicensesAcknowledged: 'boolean' }
const isText = (value: unknown) => typeof value === 'string' && value.length <= 4096
function matches(value: unknown, kind: Kind | 'legacy'): boolean {
    if (kind === 'legacy') return value === null || matches(value, unassignedShape)
    if (kind === 'text') return isText(value)
    if (kind === 'text?') return value === null || isText(value)
    if (kind === 'number?') return value === null || (typeof value === 'number' && Number.isFinite(value))
    if (kind === 'boolean') return typeof value === 'boolean'
    if (kind === 'texts') return Array.isArray(value) && value.length <= 64 && value.every(isText)
    if (Array.isArray(kind)) return (kind as readonly unknown[]).includes(value)
    if (!isRecord(value)) return false
    const keys = Object.keys(kind)
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && matches(value[key], (kind as Shape)[key]!))
}
/** Structural, typed check of a stored draft: the types the form relies on, not the validity of values being edited. */
function parseDraft(value: unknown): SetupIntent['draft'] | undefined {
    if (value === undefined || value === null) return null
    if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.baseRevision !== 'number' || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 || !isRecord(value.settings)) return undefined
    const settings = value.settings
    const keys = ['activeModuleId', 'repositoryId', 'odoo', 'ios', 'android', 'modules']
    if (Object.keys(settings).length !== keys.length || keys.some(key => !Object.hasOwn(settings, key))) return undefined
    if (settings.activeModuleId !== null && !DevelopmentModuleIdSchema.safeParse(settings.activeModuleId).success) return undefined
    if (settings.repositoryId !== null && !RepositoryIdSchema.safeParse(settings.repositoryId).success) return undefined
    if (settings.odoo !== null && !matches(settings.odoo, odooShape)) return undefined
    if (settings.ios !== null && !matches(settings.ios, iosShape)) return undefined
    if (settings.android !== null && !matches(settings.android, androidShape)) return undefined
    // Plugin values: the field value types of the module contract (text, whole number, boolean, list of texts, empty).
    if (!isRecord(settings.modules) || Object.entries(settings.modules).some(([id, entry]) => !DevelopmentModuleIdSchema.safeParse(id).success || !isRecord(entry)
        || Object.keys(entry).length !== 2 || !DevelopmentModuleDigestSchema.safeParse(entry.moduleDigest).success || !DevelopmentModuleValuesSchema.safeParse(entry.values).success)) return undefined
    return { baseRevision: value.baseRevision, settings: settings as DevelopmentModuleSettingsInput }
}
const nullable = <T>(value: unknown, parse: (value: unknown) => { success: boolean; data?: T }): T | null | undefined => {
    if (value === null) return null
    const result = parse(value)
    return result.success ? result.data as T : undefined
}
export function parseSetupIntent(value: unknown): SetupIntent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !['moduleId', 'moduleDigest', 'values', 'repositoryId', 'createdAt', 'draft'].includes(key))) return null
    const draft = parseDraft(item.draft)
    if (draft === undefined) return null
    const moduleId = nullable<string>(item.moduleId, v => DevelopmentModuleIdSchema.safeParse(v))
    const moduleDigest = nullable<string>(item.moduleDigest, v => DevelopmentModuleDigestSchema.safeParse(v))
    const values = nullable<DevelopmentModuleValues>(item.values, v => DevelopmentModuleValuesSchema.safeParse(v))
    const repositoryId = nullable<string>(item.repositoryId, v => RepositoryIdSchema.safeParse(v))
    const createdAt = typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0 ? item.createdAt : undefined
    if (moduleId === undefined || moduleDigest === undefined || values === undefined || repositoryId === undefined || createdAt === undefined) return null
    // A module draft names exactly one reviewed revision; values without a module mean nothing.
    if (!!moduleId !== !!moduleDigest || (values && !moduleId)) return null
    return { moduleId, moduleDigest, values, repositoryId, createdAt, draft }
}
/** Module and repository the draft is about: the edited form wins over the original note. */
export function intendedSettings(intent: SetupIntent | null): { moduleId: string | null; repositoryId: string | null } {
    if (!intent) return { moduleId: null, repositoryId: null }
    return intent.draft ? { moduleId: intent.draft.settings.activeModuleId, repositoryId: intent.draft.settings.repositoryId } : { moduleId: intent.moduleId, repositoryId: intent.repositoryId }
}

// The full settings budget of a project plus the original note.
const MAX_BYTES = 64 * 1024
export const setupIntentKey = (baseUrl: string, userId: string, projectId: string) => `hapi.evolved.setup-intent:${JSON.stringify([baseUrl, userId, projectId])}`

export function readSetupIntent(baseUrl: string, userId: string, projectId: string): SetupIntent | null {
    try {
        const raw = localStorage.getItem(setupIntentKey(baseUrl, userId, projectId))
        if (!raw || raw.length > MAX_BYTES) return null
        const parsed = parseSetupIntent(JSON.parse(raw))
        return parsed && (parsed.moduleId || parsed.repositoryId || parsed.draft) ? parsed : null
    } catch { return null }
}
/** Returns false when the browser cannot keep the draft; callers then say so instead of pretending. */
export function writeSetupIntent(baseUrl: string, userId: string, projectId: string, intent: SetupIntent | null): boolean {
    try {
        const key = setupIntentKey(baseUrl, userId, projectId)
        if (!intent || (!intent.moduleId && !intent.repositoryId && !intent.draft)) { localStorage.removeItem(key); return true }
        const raw = JSON.stringify(intent)
        if (raw.length > MAX_BYTES || !parseSetupIntent(JSON.parse(raw))) return false
        localStorage.setItem(key, raw)
        return true
    } catch { return false }
}
