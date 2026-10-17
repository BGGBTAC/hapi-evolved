import { useQuery } from '@tanstack/react-query'
import {
    DevelopmentConfigResponseSchema, DevelopmentConflictResponseSchema, DevelopmentContextSchema, DevelopmentSettingsSchema,
    type DevelopmentEffect, type DevelopmentMode, type DevelopmentSettings, type DoctorState, type CommitStatusState, type ProjectDevelopmentConfig,
} from '@hapi/protocol/evolvedDevelopment'
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
} as const
export const ANDROID_SDK_TERMS_URL = 'https://developer.android.com/studio/terms'

export const developmentPath = (projectId: string, suffix = '') => `${projectPath(projectId)}/development${suffix}`
export function developmentScope(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'>) {
    const project = evolved.project!
    return [evolved.api.baseUrl, evolved.me.user.id, project.id, project.role, project.profile] as const
}

export function useDevelopmentConfig(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'> | null, enabled = true) {
    const project = evolved?.project
    const query = useQuery({
        queryKey: ['evolved', 'development', ...(evolved && project ? developmentScope(evolved) : [])],
        enabled: enabled && !!project,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentConfigResponseSchema.parse(await evolved!.api.request(developmentPath(project!.id), { signal })),
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
export function useDevelopmentContext(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'>, revision: number | undefined) {
    const project = evolved.project!
    const query = useQuery({
        queryKey: ['evolved', 'development-context', ...developmentScope(evolved), revision],
        enabled: revision !== undefined,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentContextSchema.parse(await evolved.api.request(developmentPath(project.id, '/context'), { signal })),
    })
    const current = query.data?.projectId === project.id && keepsData(query.error) ? query.data : undefined
    return { ...query, current, refreshError: current && query.error ? query.error : null }
}

/** Current config from a stale-tab 409, validated with the shared schema; otherwise null. */
export function conflictConfig(error: unknown): ProjectDevelopmentConfig | null {
    if (!(error instanceof EvolvedApiError) || error.status !== 409 || error.code !== 'development_revision_conflict') return null
    const parsed = DevelopmentConflictResponseSchema.safeParse(error.payload)
    return parsed.success ? parsed.data.config : null
}

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
    agent_start_changed: 'Projekt, Freigaben oder Konfiguration haben sich während des Starts geändert. Die Aufgabe wurde nicht übergeben.',
}
/** Plain German text for any thrown value; never renders objects or raw provider bodies. */
export function describeDevelopmentError(error: unknown): string {
    if (error instanceof Error && error.name === 'ZodError') return 'Die Antwort des Servers hat ein unerwartetes Format. Hub und Web-App haben vermutlich unterschiedliche Versionen.'
    if (error instanceof EvolvedApiError) {
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
export function validateSettings(settings: DevelopmentSettings): { valid: true } | { valid: false; reason: string; field: string } {
    const result = DevelopmentSettingsSchema.safeParse(settings)
    if (result.success) return { valid: true }
    const issue = result.error.issues[0]!
    return { valid: false, reason: describeIssue(issue), field: issue.path.join('.') }
}
export function sameSettings(a: DevelopmentSettings, b: DevelopmentSettings): boolean {
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
