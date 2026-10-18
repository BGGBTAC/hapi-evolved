import { useQuery, type QueryClient } from '@tanstack/react-query'
import {
    DevelopmentSettingsSchema,
    type DevelopmentEffect, type DevelopmentMode, type DevelopmentSettings, type DoctorState, type CommitStatusState,
} from '@hapi/protocol/evolvedDevelopment'
import {
    DevelopmentModuleCatalogResponseSchema, DevelopmentModuleConflictResponseSchema, DevelopmentModuleContextSchema, DevelopmentModuleDetailResponseSchema, DevelopmentModuleSettingsErrorSchema,
    DevelopmentModulesResponseSchema, DevelopmentModuleUnavailableResponseSchema, DEVELOPMENT_MODULE_LIMITS, modeForBuiltinModuleId, parseDevelopmentModuleId,
    type DevelopmentModuleCatalogEntry, type DevelopmentModuleSettings, type DevelopmentModuleSettingsInput, type DevelopmentModuleState, type ProjectDevelopmentModuleConfig,
} from '@hapi/protocol/developmentModules'
import type { EvolvedSession } from './auth'
import { EvolvedApiError, projectPath } from './api'

// Labels are keyed by the shared enums, so a new mode or state fails typechecking here.
export const modeLabels: Record<DevelopmentMode, string> = { none: 'Allgemein', odoo: 'Odoo', ios: 'iOS', android: 'Android' }
export const modeHints: Record<DevelopmentMode, string> = {
    none: 'Keine Spezialisierung. Sitzungen arbeiten wie bisher.',
    odoo: 'Odoo 19 oder 20: Handbuch, Modulprüfung, lokale Testumgebung und optional Odoo.sh-Status über GitHub.',
    ios: 'Swift/iOS: Handbuch und Abläufe. Native Builds laufen nur auf einem Mac oder in einem Cloud-Dienst.',
    android: 'Android: Gradle/JDK/SDK-Prüfung, Tests, Lint und Debug-APK im Projektordner.',
}
export const effectLabels: Record<DevelopmentEffect, string> = {
    reads_repository: 'Liest das Repository',
    writes_repository: 'Ändert das Repository',
    network_download: 'Lädt aus dem Internet',
    installs_in_project: 'Installiert im Projektordner',
    creates_local_database: 'Legt lokale Testdatenbank an',
    runs_project_code: 'Führt Projektcode aus',
    requires_license_acknowledgement: 'Lizenzbestätigung nötig',
    git_push_may_deploy: 'Push kann deployen',
    remote_cost: 'Kann Kosten verursachen',
    manual_handoff: 'Manueller Schritt',
}
/** Effects highlighted on task cards; shown before the explicit start, no extra approval step. */
export const consequentialEffects: readonly DevelopmentEffect[] = ['network_download', 'installs_in_project', 'creates_local_database', 'runs_project_code', 'requires_license_acknowledgement', 'git_push_may_deploy', 'remote_cost']
export const kindLabels = { setup: 'Einrichten', develop: 'Entwickeln', test: 'Testen', upgrade: 'Upgrade', review: 'Review', diagnose: 'Diagnose', release: 'Release' } as const
export const doctorStateLabels: Record<DoctorState, string> = { ready: 'Gefunden', missing: 'Fehlt', unsupported: 'Nicht unterstützt', unknown: 'Unbekannt', warning: 'Prüfen' }
export const commitStateLabels: Record<CommitStatusState, string> = {
    unbound: 'Kein Repository gebunden', github_disconnected: 'GitHub nicht verbunden', not_granted: 'Repository nicht freigegeben',
    permission_missing: 'Berechtigung fehlt', credential_rejected: 'Token abgelehnt', ref_not_found: 'Branch oder Commit nicht gefunden',
    no_status: 'Keine Statusmeldung', pending: 'Ausstehend', success: 'Erfolgreich', failure: 'Fehlgeschlagen', unavailable: 'Nicht verfügbar',
}
export const runnerStatusLabels = {
    ready: 'Runner bereit',
    offline: 'Kein Runner für dieses Projekt online. Starte den Projektdienst und prüfe erneut.',
    ambiguous: 'Mehrere passende Runner sind online. Die Prüfung wird nur mit genau einem Projektrunner ausgeführt.',
    upgrade_required: 'Der verbundene Runner kennt diese Prüfung noch nicht. Aktualisiere den Runner auf die aktuelle Version.',
    unsupported: 'Diese Prüfung wird von diesem HAPI nicht unterstützt. Es wurde nichts ausgeführt.',
} as const
export const ANDROID_SDK_TERMS_URL = 'https://developer.android.com/studio/terms'

export const developmentPath = (projectId: string, suffix = '') => `${projectPath(projectId)}/development${suffix}`
export function developmentScope(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'>) {
    const project = evolved.project!
    return [evolved.api.baseUrl, evolved.me.user.id, project.id, project.role, project.profile] as const
}

/** Hub/account/project/role/profile scope: every development query key starts with it. */
export function useDevelopmentModules(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'> | null, enabled = true) {
    const project = evolved?.project
    const query = useQuery({
        queryKey: ['evolved', 'development-modules', ...(evolved && project ? developmentScope(evolved) : [])],
        enabled: enabled && !!project,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentModulesResponseSchema.parse(await evolved!.api.request(developmentPath(project!.id, '/modules'), { signal })),
    })
    // Query keys bind data to hub/account/project/role/profile. A transient refresh
    // failure keeps the last validated data for that scope; lost access drops it.
    const current = query.data?.config.projectId === project?.id && keepsData(query.error) ? query.data : undefined
    return { ...query, current, refreshError: current && query.error ? query.error : null }
}
/** Authorization or existence failures invalidate cached data; other failures are transient. */
function keepsData(error: unknown): boolean {
    return !error || !(error instanceof EvolvedApiError && [401, 403, 404].includes(error.status))
}
/**
 * Full form, tasks and handbook summaries of one installed module. Only fetched for the module the
 * user selected or adopts; `digest` is the catalog digest the user saw, a different installed
 * digest is reported as `changed` instead of being shown.
 */
export function useDevelopmentModuleDetail(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'>, moduleId: string | null, digest: string | null) {
    const project = evolved.project!
    const query = useQuery({
        queryKey: ['evolved', 'development-module', ...developmentScope(evolved), moduleId, digest],
        enabled: !!moduleId && !!digest,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentModuleDetailResponseSchema.parse(await evolved.api.request(developmentPath(project.id, `/modules/${encodeURIComponent(moduleId!)}`), { signal })).module,
    })
    const data = query.data?.id === moduleId ? query.data : undefined
    const current = data && data.digest === digest && keepsData(query.error) ? data : undefined
    return { ...query, current, changed: !!data && data.digest !== digest }
}
export function useDevelopmentModuleContext(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'>, revision: number | undefined) {
    const project = evolved.project!
    const query = useQuery({
        queryKey: ['evolved', 'development-modules-context', ...developmentScope(evolved), revision],
        enabled: revision !== undefined,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentModuleContextSchema.parse(await evolved.api.request(developmentPath(project.id, '/modules-context'), { signal })),
    })
    const current = query.data?.projectId === project.id && keepsData(query.error) ? query.data : undefined
    return { ...query, current, refreshError: current && query.error ? query.error : null }
}
/** Project-independent catalog (choosing a module while creating a project). Same bounded entries as the project catalog. */
export function useGlobalDevelopmentCatalog(evolved: Pick<EvolvedSession, 'api' | 'me'>, enabled = true) {
    const query = useQuery({
        queryKey: ['evolved', 'development-catalog', evolved.api.baseUrl, evolved.me.user.id],
        enabled, retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentModuleCatalogResponseSchema.parse(await evolved.api.request('/development-modules', { signal })),
    })
    return { ...query, current: keepsData(query.error) ? query.data : undefined }
}
export function useGlobalDevelopmentModuleDetail(evolved: Pick<EvolvedSession, 'api' | 'me'>, moduleId: string | null, digest: string | null) {
    const query = useQuery({
        queryKey: ['evolved', 'development-catalog-module', evolved.api.baseUrl, evolved.me.user.id, moduleId, digest],
        enabled: !!moduleId && !!digest, retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentModuleDetailResponseSchema.parse(await evolved.api.request(`/development-modules/${encodeURIComponent(moduleId!)}`, { signal })).module,
    })
    const data = query.data?.id === moduleId ? query.data : undefined
    return { ...query, current: data && data.digest === digest ? data : undefined, changed: !!data && data.digest !== digest }
}
/** After plugin or configuration mutations every development read (config, catalog, details, context, knowledge) is stale. */
export function invalidateDevelopmentQueries(client: QueryClient) {
    return client.invalidateQueries({ predicate: query => query.queryKey[0] === 'evolved' && typeof query.queryKey[1] === 'string' && query.queryKey[1].startsWith('development') })
}

/** Current config from a stale-tab 409, validated with the shared schema; otherwise null. */
export function conflictConfig(error: unknown): ProjectDevelopmentModuleConfig | null {
    if (!(error instanceof EvolvedApiError) || error.status !== 409 || error.code !== 'development_revision_conflict') return null
    const parsed = DevelopmentModuleConflictResponseSchema.safeParse(error.payload)
    return parsed.success ? parsed.data.config : null
}
/** Authoritative field issues of a rejected save (`development_module_settings_invalid`). */
export function settingsIssues(error: unknown): Array<{ path: string[]; message: string }> | null {
    if (!(error instanceof EvolvedApiError) || error.code !== 'development_module_settings_invalid') return null
    const parsed = DevelopmentModuleSettingsErrorSchema.safeParse(error.payload)
    return parsed.success ? parsed.data.issues : null
}

/** Editable form of the canonical settings: plugin entries carry only the digest the user saw and the values. */
export function settingsInput(settings: DevelopmentModuleSettings): DevelopmentModuleSettingsInput {
    return {
        activeModuleId: settings.activeModuleId, repositoryId: settings.repositoryId, odoo: settings.odoo, ios: settings.ios, android: settings.android,
        modules: Object.fromEntries(Object.entries(settings.modules).map(([id, entry]) => [id, { moduleDigest: entry.moduleDigest, values: entry.values }])),
    }
}
/** The builtin sections (and shared repository) in v1 form for the reviewed builtin validators. */
export function builtinSections(settings: Pick<DevelopmentModuleSettingsInput, 'activeModuleId' | 'repositoryId' | 'odoo' | 'ios' | 'android'>): DevelopmentSettings {
    return { mode: modeForBuiltinModuleId(settings.activeModuleId) ?? 'none', repositoryId: settings.repositoryId, odoo: settings.odoo, ios: settings.ios, android: settings.android }
}
export const moduleStateLabels: Record<DevelopmentModuleState, string> = {
    none: 'Allgemein', ready: 'Bereit', adoption_required: 'Neue Fassung muss übernommen werden', disabled: 'Plugin deaktiviert',
    missing: 'Nicht mehr installiert', unsupported: 'Von diesem HAPI nicht unterstützt', invalid: 'Ungültige Definition',
}
const unavailableText: Record<DevelopmentModuleState, string> = {
    none: 'Für dieses Projekt ist kein Entwicklungsmodul aktiv.',
    ready: 'Das Modul ist verfügbar.',
    adoption_required: 'Eine neue Fassung des Moduls ist installiert. Ein Projektadministrator muss sie unter „Entwicklung“ übernehmen; bis dahin sind Aufgaben, Prüfungen und Handbuch gesperrt.',
    disabled: 'Das Plugin dieses Moduls ist deaktiviert. Die Einstellungen bleiben erhalten; Aufgaben, Prüfungen und Handbuch sind gesperrt.',
    missing: 'Das Modul ist nicht mehr installiert. Die Einstellungen bleiben erhalten; Aufgaben, Prüfungen und Handbuch sind gesperrt.',
    unsupported: 'Das Modul braucht eine Prüfung, die dieses HAPI nicht kennt. Es kann nicht verwendet werden.',
    invalid: 'Die Moduldefinition ist ungültig und kann nicht verwendet werden.',
}
export function describeModuleState(state: DevelopmentModuleState): string { return unavailableText[state] }
/** Saved active module in one line, from the catalog; an unknown id stays visible instead of turning into "Allgemein". */
export function describeActiveModule(settings: Pick<DevelopmentModuleSettings, 'activeModuleId' | 'odoo'>, catalog: readonly DevelopmentModuleCatalogEntry[]): string {
    const id = settings.activeModuleId
    if (!id) return modeLabels.none
    const entry = catalog.find(item => item.id === id)
    if (id === 'builtin:odoo' && settings.odoo) return describeMode({ mode: 'odoo', repositoryId: null, odoo: settings.odoo, ios: null, android: null })
    if (entry) return entry.title
    const parsed = parseDevelopmentModuleId(id)
    return parsed?.origin === 'plugin' ? `Plugin-Modul „${parsed.localId}“` : id
}
export const shortDigest = (digest: string | null | undefined) => digest ? digest.replace(/^sha256:/, '').slice(0, 12) : '—'

const codeMessages: Record<string, string> = {
    development_repository_not_granted: 'Das gewählte Repository ist für dieses Projekt nicht (mehr) freigegeben. Prüfe die Freigabe im Bereich GitHub.',
    development_repository_unverified: 'Die Repository-Freigaben konnten gerade nicht geprüft werden. Es wurde nichts gespeichert; versuche es später erneut.',
    development_mode_none: 'Im Modus „Allgemein“ gibt es keine Prüfung. Wähle und speichere zuerst einen Modus.',
    development_repository_unavailable: 'Für die Modulprüfung fehlt ein freigegebenes, gebundenes Repository.',
    development_repository_required: 'Diese Aufgabe braucht ein gebundenes und geklontes Repository.',
    development_busy: 'Für dieses Projekt läuft bereits eine Prüfung. Warte, bis sie abgeschlossen ist.',
    development_changed: 'Die Konfiguration hat sich während der Prüfung geändert. Das Ergebnis wurde verworfen; prüfe erneut.',
    development_runner_failed: 'Der Runner konnte die Prüfung nicht ausführen.',
    runner_timeout: 'Der Runner hat nicht rechtzeitig geantwortet. Es wurde nichts verändert; prüfe später erneut.',
    invalid_runner_response: 'Der Runner hat eine ungültige Antwort geliefert. Aktualisiere den Runner.',
    development_task_not_found: 'Diese Aufgabe gehört nicht (mehr) zur gespeicherten Konfiguration. Lade die Seite neu.',
    development_task_specialist_mismatch: 'Die Aufgabe passt nicht zum gewählten Spezialisten. Lade die Seite neu.',
    development_revision_conflict: 'Die Konfiguration wurde inzwischen geändert. Lade die aktuelle Fassung, bevor du startest.',
    development_license_acknowledgement_required: 'Ein Projektadministrator muss zuerst die Android-SDK-Lizenzprüfung bestätigen.',
    development_debug_variant_required: 'Diese Aufgabe braucht eine Debug-Variante. Passe die Variante in den Android-Einstellungen an.',
    repository_checkout_unavailable: 'Das Repository ist im Projekt noch nicht geklont oder nicht bereit.',
    repository_unavailable: 'Das Repository kann gerade nicht als Arbeitsort verwendet werden.',
    development_topic_not_found: 'Dieses Handbuchthema gehört nicht zur gespeicherten Version.',
    agent_operation_conflict: 'Dieser Vorgang wurde bereits mit anderen Angaben gestartet. Es wurde keine zweite Sitzung erzeugt.',
    agent_start_changed: 'Projekt, Freigaben, Konfiguration oder Modulfassung haben sich während des Starts geändert. Die Aufgabe wurde nicht übergeben.',
    development_module_changed: 'Das Entwicklungsmodul wurde inzwischen geändert (neue Fassung oder anderes aktives Modul). Es wurde nichts gespeichert oder gestartet; prüfe die aktuelle Fassung.',
    development_module_settings_invalid: 'Die Moduleinstellungen wurden vom Server abgelehnt. Prüfe die markierten Felder.',
    development_module_not_found: 'Dieses Entwicklungsmodul ist nicht (mehr) installiert.',
    development_module_limit: `Ein Projekt kann höchstens ${DEVELOPMENT_MODULE_LIMITS.projectModuleEntries} Modulkonfigurationen aufbewahren.`,
    development_doctor_unavailable: 'Dieses Modul bietet keine Werkzeugprüfung.',
    development_inspect_unavailable: 'Dieses Modul bietet keine Projektprüfung.',
    development_config_invalid: 'Die gespeicherten Entwicklungseinstellungen sind nicht lesbar. Ein Projektadministrator muss sie neu speichern.',
    development_settings_too_large: `Die Einstellungen aller Module dürfen zusammen höchstens ${DEVELOPMENT_MODULE_LIMITS.settingsBytes / 1024} KiB groß sein. Es wurde nichts gespeichert; entferne nicht mehr benötigte Modulkonfigurationen oder kürze Werte.`,
    development_config_version_unsupported: 'Die Entwicklungseinstellungen dieses Projekts stammen von einer neueren HAPI-Fassung. Sie werden hier weder angezeigt noch überschrieben.',
    development_client_upgrade_required: 'Diese Ansicht ist für die gespeicherte Konfiguration zu alt. Lade die Seite neu, um die aktuelle Fassung von HAPI zu verwenden.',
}
/** Plain German text for any thrown value; never renders objects or raw provider bodies. */
export function describeDevelopmentError(error: unknown): string {
    if (error instanceof Error && error.name === 'ZodError') return 'Die Antwort des Servers hat ein unerwartetes Format. Hub und Web-App haben vermutlich unterschiedliche Versionen.'
    if (error instanceof EvolvedApiError) {
        if (error.code === 'development_module_unavailable') {
            const parsed = DevelopmentModuleUnavailableResponseSchema.safeParse(error.payload)
            return parsed.success ? describeModuleState(parsed.data.state) : 'Das Entwicklungsmodul ist derzeit nicht verfügbar.'
        }
        if (error.code && codeMessages[error.code]) return codeMessages[error.code]!
        if (error.status === 404) return 'Nicht gefunden: Projekt oder Entwicklungsfunktion sind auf diesem Hub nicht verfügbar.'
        if (error.status === 503) return 'Der Dienst ist vorübergehend nicht verfügbar. Es wurde nichts geändert; versuche es später erneut.'
        if (error.status === 403) return 'Dafür fehlt dir in diesem Projekt die Berechtigung.'
        return error.message
    }
    if (error instanceof Error) return error.name === 'AbortError' ? 'Anfrage abgebrochen.' : error.message
    return 'Unbekannter Fehler.'
}

// ---------------------------------------------------------------- settings validation

const fieldLabels: Record<string, string> = {
    repositoryId: 'Standard-Repository',
    'odoo.addonsPaths': 'Addon-Pfade', 'odoo.modules': 'Module', 'odoo.developmentBranch': 'Entwicklungs-Branch', 'odoo.stage': 'Stufe',
    'odoo.enterpriseRepositoryId': 'Enterprise-Repository', 'odoo.testDatabaseSlug': 'Testdatenbank-Kürzel', 'odoo.odooSh': 'Odoo.sh-Angaben',
    'odoo.odooSh.dashboardUrl': 'Odoo.sh-Projektlink', 'odoo.odooSh.buildId': 'Build-ID', 'odoo.odooSh.buildHost': 'Build-Host',
    'odoo.odooSh.sshResourceId': 'SSH-Ressource im Tresor', 'odoo.applicationResourceId': 'Ressource für die Anwendungs-API',
    'ios.projectDirectory': 'App-Ordner', 'ios.projectFile': 'Projektdatei', 'ios.scheme': 'Scheme', 'ios.bundleId': 'Bundle-ID',
    'ios.deploymentTarget': 'Mindestversion', 'ios.xcodeCloudResourceId': 'Xcode-Cloud-Referenz',
    'android.projectDirectory': 'Projektordner im Repository', 'android.module': 'Modul', 'android.variant': 'Variante',
    'android.applicationId': 'Application-ID', 'android.minSdk': 'minSdk', 'android.targetSdk': 'targetSdk', 'android.compileSdk': 'compileSdk',
}
const reasonMessages: Record<string, string> = {
    'Duplicate addons path': 'enthält einen Pfad doppelt',
    'Duplicate module': 'enthält ein Modul doppelt',
    'Community edition has no Enterprise addons repository': 'gibt es nur bei der Enterprise-Edition',
    'Odoo.sh metadata requires Odoo.sh hosting': 'sind nur beim Betrieb auf Odoo.sh erlaubt',
    'Build ID and build host belong together': 'Build-ID und Build-Host gehören zusammen; kopiere beide aus Odoo.sh',
    'SSH requires the copied build ID and host': 'braucht zuerst Build-ID und Build-Host',
    'Declare a branch before its stage': 'braucht zuerst einen Entwicklungs-Branch',
    'Enterprise addons must be a separate repository': 'muss ein anderes Repository als das Standard-Repository sein',
    'minSdk must not exceed targetSdk': 'darf nicht größer als targetSdk sein',
    'targetSdk must not exceed compileSdk': 'darf nicht größer als compileSdk sein',
    'Settings for the selected mode are required': 'Einstellungen für den gewählten Modus fehlen',
    'Use a repository-relative path without traversal': 'muss ein relativer Pfad im Repository sein (ohne „..“, ohne führenden Schrägstrich)',
    'Invalid branch name': 'ist kein gültiger Branch-Name',
    'Use an .xcodeproj, .xcworkspace or Package.swift path': 'muss auf .xcodeproj, .xcworkspace oder Package.swift enden',
    'Use an https://www.odoo.sh/project/... link without query or credentials': 'muss mit https://www.odoo.sh/project/ beginnen, ohne Parameter oder Zugangsdaten',
    'Invalid scheme': 'ist kein gültiger Scheme-Name',
}
type SettingsIssue = { path: PropertyKey[]; message: string; code: string }
export function describeIssue(issue: SettingsIssue): string {
    const keys = issue.path.filter((part): part is string => typeof part === 'string')
    const index = issue.path.find((part): part is number => typeof part === 'number')
    const key = keys.join('.')
    const label = fieldLabels[key] ?? fieldLabels[keys.slice(0, -1).join('.')] ?? 'Eingabe'
    const reason = reasonMessages[issue.message] ?? (issue.code === 'too_big' ? 'ist zu lang oder zu groß' : issue.code === 'too_small' ? 'ist zu kurz oder zu klein' : 'hat kein gültiges Format')
    return `${label}${index !== undefined ? ` (Eintrag ${index + 1})` : ''}: ${reason}.`
}
/** German text for the shared field validator and authoritative server issues; unknown messages are shown as sent. */
export function describeFieldIssue(message: string): string {
    const known: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
        [/^Required$/, () => 'Pflichtfeld: bitte ausfüllen.'],
        [/^Expected true or false$/, () => 'Erwartet ja oder nein.'],
        [/^Expected a list$/, () => 'Erwartet eine Liste.'],
        [/^At most (\d+) entries$/, match => `Höchstens ${match[1]} Einträge.`],
        [/^Duplicate entries$/, () => 'Ein Eintrag kommt doppelt vor.'],
        [/^Unknown option$/, () => 'Diese Auswahl gibt es in der aktuellen Fassung nicht (mehr).'],
        [/^Expected text entries$/, () => 'Erwartet Texteinträge.'],
        [/^Entries must not be blank or padded$/, () => 'Einträge dürfen nicht leer sein und nicht mit Leerzeichen beginnen oder enden.'],
        [/^Entries have at most (\d+) characters$/, match => `Jeder Eintrag hat höchstens ${match[1]} Zeichen.`],
        [/^Invalid entry format$/, () => 'Ein Eintrag hat kein gültiges Format.'],
        [/^Expected text$/, () => 'Erwartet Text.'],
        [/^Use null for an empty value$/, () => 'Leeres Feld bitte ganz leeren.'],
        [/^Remove leading or trailing spaces$/, () => 'Ohne Leerzeichen am Anfang oder Ende.'],
        [/^At most (\d+) characters$/, match => `Höchstens ${match[1]} Zeichen.`],
        [/^Invalid format$/, () => 'Kein gültiges Format.'],
        [/^Expected a whole number$/, () => 'Bitte eine ganze Zahl eingeben.'],
        [/^Between (-?\d+) and (-?\d+)$/, match => `Erlaubt sind Werte von ${match[1]} bis ${match[2]}.`],
        [/^Use a repository-relative path without traversal$/, () => 'Relativer Pfad im Repository (ohne „..“ und ohne führenden Schrägstrich).'],
        [/^Invalid branch name$/, () => 'Kein gültiger Branch-Name.'],
        [/^Choose a granted repository$/, () => 'Wähle ein freigegebenes Repository.'],
        [/^Invalid resource reference$/, () => 'Keine gültige Ressourcen-ID.'],
        [/^Use a canonical https URL without credentials, query or fragment$/, () => 'https-Adresse ohne Zugangsdaten, Parameter oder Anker.'],
        [/^Unknown field$/, () => 'Dieses Feld gibt es in der aktuellen Fassung nicht.'],
    ]
    for (const [pattern, text] of known) { const match = message.match(pattern); if (match) return text(match) }
    return message
}
export function validateSettings(settings: DevelopmentSettings): { valid: true } | { valid: false; reason: string; field: string } {
    const result = DevelopmentSettingsSchema.safeParse(settings)
    if (result.success) return { valid: true }
    const issue = result.error.issues[0]!
    return { valid: false, reason: describeIssue(issue), field: issue.path.join('.') }
}
export function sameSettings(a: unknown, b: unknown): boolean {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]))
    return value
}
/** Short one-line description of a persisted configuration. */
export function describeMode(settings: DevelopmentSettings): string {
    if (settings.mode === 'odoo' && settings.odoo) return `Odoo ${settings.odoo.major} · ${settings.odoo.edition === 'enterprise' ? 'Enterprise' : 'Community'} · ${settings.odoo.hosting === 'odoo_sh' ? 'Odoo.sh' : settings.odoo.hosting === 'self_hosted' ? 'selbst gehostet' : 'lokal'}`
    return modeLabels[settings.mode]
}
/** Only https URLs are rendered as links; anything else is shown as text. */
export function safeHttpsUrl(value: string | null | undefined): string | null {
    if (!value) return null
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
export function formatTimestamp(value: number | null | undefined): string {
    return typeof value === 'number' && value > 0 ? new Date(value).toLocaleString('de-DE') : 'unbekannt'
}
