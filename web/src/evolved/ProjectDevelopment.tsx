import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { defaultAndroidSettings, defaultIosSettings, defaultOdooSettings, ODOO_MAJORS } from '@hapi/protocol/evolvedDevelopment'
import {
    DEVELOPMENT_MODULE_LIMITS, DevelopmentModuleUpdateResponseSchema, developmentModuleDefaults, developmentModuleJsonBytes, modeForBuiltinModuleId, validateDevelopmentModuleValues,
    type DevelopmentModuleCatalogEntry, type DevelopmentModuleDetail, type DevelopmentModuleField, type DevelopmentModuleSettingsInput,
    type DevelopmentModulesResponse, type PluginModuleSettingsEntry, type ProjectDevelopmentModuleConfig,
} from '@hapi/protocol/developmentModules'
import { useEvolved } from './auth'
import { canWriteProject, EvolvedApiError } from './api'
import { Loading } from './ui'
import { WorkspaceLink } from './workspaceNavigation'
import { useProjectRepositories } from './repositoryCatalog'
import { AndroidFields, IosFields, OdooFields, RepositorySelect, RepositoryStatus } from './DevelopmentSettingsFields'
import { DevelopmentModuleFields, DevelopmentModulePicker, moduleFieldDomId, type ModulePickerOption } from './DevelopmentModuleFields'
import { DevelopmentTools } from './DevelopmentTools'
import { DevelopmentTasks } from './DevelopmentTasks'
import { DevelopmentHandbook } from './DevelopmentHandbook'
import {
    builtinSections, conflictConfig, describeActiveModule, describeDevelopmentError, describeFieldIssue, describeIssue, describeModuleState, developmentPath,
    developmentScope, formatTimestamp, invalidateDevelopmentQueries, modeHints, modeLabels, moduleOriginLabel, moduleStateLabels, sameSettings, settingsInput, settingsIssues,
    shortDigest, useDevelopmentModuleContext, useDevelopmentModuleDetail, useDevelopmentModules, validateSettings,
} from './developmentApi'
import type { SetupIntent } from './setupIntent'
import { isBundledPluginId } from '@hapi/protocol/bundledPlugins'
import './development.css'

/**
 * `settings` shows only the module form, `checks` only checks, tasks and handbook of the saved module (both used by the
 * setup wizard); `all` is the development tab. An `intent` is a browser-local draft (intended module and values, repository
 * to bind, or the whole form as last edited in the wizard) that is put into the unsaved form and marked as such. With
 * `onDraftChange` the wizard keeps the current unsaved form across its steps and reloads; `null` means nothing is pending
 * any more (saved, discarded, or already exactly what is saved). Nothing is ever saved without the explicit button.
 */
type PanelProps = { section?: 'all' | 'settings' | 'checks'; intent?: SetupIntent | null; onDraftChange?: (draft: DevelopmentModuleSettingsInput | null, baseRevision: number) => void }
export function ProjectDevelopmentPanel(props: PanelProps = {}) {
    const evolved = useEvolved()
    if (!evolved.project) return null
    // Account, project, role or profile changes discard drafts, results and late responses.
    return <DevelopmentForProject key={JSON.stringify(developmentScope(evolved))} {...props} />
}

function DevelopmentForProject(props: PanelProps) {
    const evolved = useEvolved()
    const modules = useDevelopmentModules(evolved)
    // Only a load without validated data replaces the workspace; a failed refresh keeps the form and draft.
    if (!modules.current) return modules.error ? <section className="ev-panel ev-dev" aria-labelledby="ev-dev-error"><h2 id="ev-dev-error">Entwicklungsmodul nicht geladen</h2>
        <p className="ev-error" role="alert">{describeDevelopmentError(modules.error)}</p>
        <button disabled={modules.isFetching} onClick={() => void modules.refetch()}>Erneut laden</button></section> : <Loading />
    if (props.section === 'checks') return <div className="ev-dev">{modules.current.config.settings.activeModuleId
        ? <ModuleWorkspace config={modules.current.config} unsaved={false} />
        : <section className="ev-panel"><h2>Kein Modul gespeichert</h2><p className="ev-muted">Prüfungen und Einrichtungsaufgaben gehören zu einem gespeicherten Entwicklungsmodul. Ohne Modul arbeiten Sitzungen allgemein.</p></section>}</div>
    return <DevelopmentWorkspace response={modules.current} refetching={modules.isFetching} refreshError={modules.refreshError} reload={() => void modules.refetch()} section={props.section ?? 'all'} intent={props.intent ?? null} onDraftChange={props.onDraftChange} />
}

/**
 * Puts a setup intent into an editable draft; returns null when the saved configuration already is exactly that.
 * The same active module id alone is not enough: the reviewed revision and the typed values must match as well.
 */
export function applyIntent(draft: DevelopmentModuleSettingsInput, intent: SetupIntent | null): DevelopmentModuleSettingsInput | null {
    if (!intent) return null
    if (intent.draft) return sameSettings(intent.draft.settings, draft) ? null : intent.draft.settings
    let next = draft
    if (intent.moduleId) {
        const mode = modeForBuiltinModuleId(intent.moduleId)
        if (mode && mode !== 'none') {
            if (intent.moduleId !== next.activeModuleId) next = { ...next, activeModuleId: intent.moduleId, ...(next[mode] ? {} : { [mode]: builtinDefaults[mode]() }) }
        } else if (intent.moduleDigest) {
            const current = next.modules[intent.moduleId]
            const values = intent.values ?? current?.values ?? {}
            if (intent.moduleId !== next.activeModuleId || current?.moduleDigest !== intent.moduleDigest || !sameSettings(current.values, values))
                next = { ...next, activeModuleId: intent.moduleId, modules: { ...next.modules, [intent.moduleId]: { moduleDigest: intent.moduleDigest, values: { ...values } } } }
        }
    }
    if (intent.repositoryId && intent.repositoryId !== next.repositoryId) next = { ...next, repositoryId: intent.repositoryId }
    return next === draft ? null : next
}

type Issue = { path: string[]; message: string }
const fieldsOf = (detail: DevelopmentModuleDetail | undefined): readonly DevelopmentModuleField[] | null => detail?.form.kind === 'fields' ? detail.form.fields : null
const builtinDefaults = { odoo: defaultOdooSettings, ios: defaultIosSettings, android: defaultAndroidSettings } as const

function DevelopmentWorkspace({ response, refetching, refreshError, reload, section, intent, onDraftChange }: {
    response: DevelopmentModulesResponse; refetching: boolean; refreshError: unknown; reload: () => void
    section: 'all' | 'settings'; intent: SetupIntent | null; onDraftChange?: (draft: DevelopmentModuleSettingsInput | null, baseRevision: number) => void
}) {
    const evolved = useEvolved()
    const { api, project } = evolved
    const client = useQueryClient()
    const projectId = project!.id
    const canEdit = response.canEdit
    const catalog = response.catalog.modules
    const [persisted, setPersisted] = useState<ProjectDevelopmentModuleConfig>(response.config)
    // Only administrators can turn an intent into a draft; for everyone else it stays a visible, unapplied note.
    const [initial] = useState(() => canEdit ? applyIntent(settingsInput(response.config.settings), intent) : null)
    const [draft, setDraft] = useState<DevelopmentModuleSettingsInput>(() => initial ?? settingsInput(response.config.settings))
    const intentOpen = !!initial
    // Saved meanwhile (another tab or administrator) with other values or another revision of the same module.
    const [savedDiffers] = useState(() => !!initial && !intent?.draft && !!intent?.moduleId && intent.moduleId === response.config.settings.activeModuleId)
    // A restored wizard draft keeps the revision it was based on, so a newer saved revision shows the existing conflict choice.
    const [baseRevision, setBaseRevision] = useState(initial && intent?.draft ? intent.draft.baseRevision : response.config.revision)
    const [draftKey, setDraftKey] = useState(0)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [serverIssues, setServerIssues] = useState<Issue[]>([])
    const [notice, setNotice] = useState('')
    const saveRequest = useRef<AbortController | null>(null)
    // Entries created only because a module was looked at; dropped again when the user moves on untouched.
    const autoEntries = useRef(new Map<string, string>())
    useEffect(() => () => saveRequest.current?.abort(), [])

    const persistedInput = settingsInput(persisted.settings)
    const changed = !sameSettings(draft, persistedInput)
    const stale = changed && baseRevision !== persisted.revision
    // Every incoming config (GET, conflict body, save result) passes through here. Responses can arrive
    // out of order, so the known revision only moves forward; the same revision refreshes the module status.
    const knownRevision = useRef(response.config.revision)
    const adopt = (incoming: ProjectDevelopmentModuleConfig): boolean => {
        if (incoming.projectId !== projectId || incoming.revision < knownRevision.current) return false
        const newer = incoming.revision > knownRevision.current
        knownRevision.current = incoming.revision
        setPersisted(incoming)
        return newer
    }
    const resetDraft = (config: ProjectDevelopmentModuleConfig) => {
        setDraft(settingsInput(config.settings)); setBaseRevision(config.revision); setDraftKey(key => key + 1); setServerIssues([]); autoEntries.current.clear()
    }
    // A newer server revision replaces a clean form; a draft is kept and reported as a conflict.
    useEffect(() => {
        if (adopt(response.config) && !changed) resetDraft(response.config)
    }, [response.config]) // Only a new server response may replace the form.

    const repositories = useProjectRepositories(evolved)
    const activeId = draft.activeModuleId
    const builtinMode = modeForBuiltinModuleId(activeId)
    const selectedEntry = activeId ? catalog.find(entry => entry.id === activeId) ?? null : null
    const pluginSelected = !!activeId && builtinMode === null
    // Builtin modules keep their reviewed forms; the catalog names the renderer, nothing is inferred from the id.
    const renderer = selectedEntry?.form.kind === 'builtin' ? selectedEntry.form.renderer : null
    const savedActive = persisted.settings.activeModuleId
    const needsDetail = !!selectedEntry && (selectedEntry.form.kind === 'fields' || activeId !== savedActive)
    const detail = useDevelopmentModuleDetail(evolved, needsDetail ? activeId : null, needsDetail ? selectedEntry!.digest : null)
    const fields = fieldsOf(detail.current)
    const draftEntry = pluginSelected ? draft.modules[activeId!] : undefined
    const savedEntry: PluginModuleSettingsEntry | undefined = pluginSelected ? persisted.settings.modules[activeId!] : undefined
    const entryChanged = pluginSelected && !sameSettings(draftEntry ?? null, savedEntry ? { moduleDigest: savedEntry.moduleDigest, values: savedEntry.values } : null)
    // The stored values belong to another revision than the installed one: explicit adoption first.
    const needsAdoption = !!draftEntry && !!selectedEntry && draftEntry.moduleDigest !== selectedEntry.digest
    const adopting = !!draftEntry && !!savedEntry && draftEntry.moduleDigest !== savedEntry.moduleDigest
    const valuesEditable = canEdit && !saving && pluginSelected && !!draftEntry && !!fields && !needsAdoption && selectedEntry?.state === 'ready'

    // A newly selected plugin module starts with the defaults of exactly the revision shown.
    useEffect(() => {
        const module = detail.current
        if (!canEdit || !module || module.form.kind !== 'fields' || !pluginSelected || draftEntry || module.id !== activeId) return
        const entry = { moduleDigest: module.digest, values: developmentModuleDefaults(module.form.fields) }
        autoEntries.current.set(module.id, JSON.stringify(entry))
        setDraft(current => current.activeModuleId === module.id && !current.modules[module.id] ? { ...current, modules: { ...current.modules, [module.id]: entry } } : current)
    }, [detail.current, activeId, draftEntry, pluginSelected, canEdit])

    const builtinValidation = validateSettings(builtinSections(draft))
    const invalidField = builtinValidation.valid ? null : builtinValidation.field
    const clientIssues: Record<string, string> = {}
    let moduleIssue: string | null = null
    if (valuesEditable && fields && entryChanged) {
        const result = validateDevelopmentModuleValues(fields, draftEntry!.values)
        if (!result.ok) for (const issue of result.issues) {
            if (!issue.field) moduleIssue = describeFieldIssue(issue.message)
            else clientIssues[issue.field] ??= describeFieldIssue(issue.message)
        }
    }
    // The whole PUT body (all module entries and builtin sections) has a fixed budget; say so before the server refuses.
    const draftBytes = developmentModuleJsonBytes(draft)
    // Authoritative server issues stay visible at their field until that field changes, even if the browser check does not know them.
    const serverFieldIssues: Record<string, string> = {}
    const otherIssues: string[] = []
    for (const issue of serverIssues) {
        const [scope, moduleId, part, fieldId] = issue.path
        if (scope === 'modules' && moduleId === activeId && part === 'values' && fieldId) serverFieldIssues[fieldId] ??= describeFieldIssue(issue.message)
        else if (scope === 'modules' && moduleId) otherIssues.push(`${catalog.find(entry => entry.id === moduleId)?.title ?? 'Anderes Modul'}${fieldId ? ` · ${fieldId}` : ''}: ${describeFieldIssue(issue.message)}`)
        else otherIssues.push(describeIssue({ path: issue.path, message: issue.message, code: 'custom' }))
    }
    const fieldIssues = { ...serverFieldIssues, ...clientIssues }
    const invalidLabels = fields?.filter(field => fieldIssues[field.id]).map(field => field.label) ?? []
    const activating = activeId !== savedActive
    const editable = canEdit && !saving

    const saveBlocker = !canEdit ? 'Nur Projektadministratoren können das Entwicklungsmodul ändern.'
        : saving ? 'Wird gespeichert …'
            : stale ? 'Die gespeicherte Fassung wurde inzwischen geändert. Entscheide oben, wie du fortfährst.'
                : !changed ? 'Keine ungespeicherten Änderungen.'
                    : activeId && !selectedEntry && activating ? 'Dieses Modul ist nicht installiert und kann nicht gewählt werden.'
                        : activating && selectedEntry && selectedEntry.state !== 'ready' ? `${selectedEntry.title} kann nicht aktiviert werden: ${moduleStateLabels[selectedEntry.state]}.`
                            : pluginSelected && !draftEntry ? detail.error ? `Moduldetails nicht geladen: ${describeDevelopmentError(detail.error)}` : detail.changed ? 'Das Modul wurde gerade geändert. Lade die gespeicherte Fassung neu.' : 'Moduldetails werden geladen …'
                                : pluginSelected && needsAdoption && (entryChanged || activating) ? 'Diese Einstellungen gehören zu einer älteren Modulfassung. Übernimm zuerst die installierte Fassung.'
                                    : pluginSelected && entryChanged && selectedEntry?.state !== 'ready' ? 'Werte eines nicht verfügbaren Moduls können nicht geändert werden. Verwirf diese Änderung.'
                                        : pluginSelected && entryChanged && !fields ? 'Moduldetails werden geladen …'
                                            : !builtinValidation.valid ? builtinValidation.reason
                                                : moduleIssue ? moduleIssue
                                                : draftBytes > DEVELOPMENT_MODULE_LIMITS.settingsBytes ? `Die Einstellungen aller Module sind zu groß (${Math.ceil(draftBytes / 1024)} KiB, höchstens ${DEVELOPMENT_MODULE_LIMITS.settingsBytes / 1024} KiB). Entferne nicht mehr benötigte Modulkonfigurationen oder kürze Werte.`
                                                : invalidLabels.length ? `${invalidLabels.length === 1 ? 'Ein Feld ist' : `${invalidLabels.length} Felder sind`} ungültig: ${invalidLabels.join(', ')}.` : null

    const focusFirstInvalid = () => {
        const field = fields?.find(item => fieldIssues[item.id])
        if (field) { document.getElementById(moduleFieldDomId(fieldPrefix, field.id))?.focus(); return }
        if (invalidField) document.querySelector<HTMLElement>('.ev-dev-form [aria-invalid="true"]')?.focus()
    }
    const save = () => {
        if (saveBlocker || saveRequest.current) { if (!saving) focusFirstInvalid(); return }
        const controller = new AbortController(); saveRequest.current = controller
        const settings = draft
        setSaving(true); setError(null); setNotice(''); setServerIssues([])
        void (async () => {
            try {
                const result = DevelopmentModuleUpdateResponseSchema.parse(await api.request(developmentPath(projectId, '/modules'), { method: 'PUT', body: { expectedRevision: changed ? baseRevision : persisted.revision, settings }, signal: controller.signal }))
                if (controller.signal.aborted) return
                // A newer revision may already be known from another read; then the saved draft becomes a visible conflict.
                if (adopt(result.config)) resetDraft(result.config)
                setNotice(`Gespeichert als Revision ${result.config.revision}.`)
                await invalidateDevelopmentQueries(client)
            } catch (failure) {
                if (controller.signal.aborted) return
                const current = conflictConfig(failure)
                const issues = settingsIssues(failure)
                if (current) { adopt(current); setError(null) }
                else if (issues) { setServerIssues(issues); setError(describeDevelopmentError(failure)) }
                else {
                    setError(describeDevelopmentError(failure))
                    // A changed or unavailable module: reload the catalog so the current revision and state become visible; the draft stays.
                    if (failure instanceof EvolvedApiError && ['development_module_changed', 'development_module_unavailable', 'development_module_not_found'].includes(failure.code ?? '')) reload()
                }
            } finally {
                if (saveRequest.current === controller) saveRequest.current = null
                if (!controller.signal.aborted) setSaving(false)
            }
        })()
    }
    useEffect(() => { if (serverIssues.length) focusFirstInvalid() }, [serverIssues])
    const discard = () => { resetDraft(persisted); setError(null); setNotice('') }
    // The wizard keeps exactly the current unsaved form (browser-local, scoped); a clean form means nothing is pending.
    useEffect(() => { if (canEdit) onDraftChange?.(changed ? draft : null, baseRevision) }, [draft, baseRevision, changed])
    const update = (next: DevelopmentModuleSettingsInput) => { setNotice(''); setDraft(next) }
    const chooseModule = (id: string | null) => {
        const modules = { ...draft.modules }
        const previous = draft.activeModuleId
        // A plugin entry that was only created by looking at the module is not kept as configuration.
        if (previous && previous !== id && autoEntries.current.get(previous) === JSON.stringify(modules[previous] ?? null)) { delete modules[previous]; autoEntries.current.delete(previous) }
        const next = { ...draft, activeModuleId: id, modules }
        const mode = modeForBuiltinModuleId(id)
        update(mode && mode !== 'none' && !next[mode] ? { ...next, [mode]: builtinDefaults[mode]() } : next)
    }
    const setValue = (fieldId: string, value: unknown) => {
        if (!activeId || !draftEntry) return
        autoEntries.current.delete(activeId)
        setServerIssues(issues => issues.filter(issue => !(issue.path[1] === activeId && issue.path[3] === fieldId)))
        update({ ...draft, modules: { ...draft.modules, [activeId]: { ...draftEntry, values: { ...draftEntry.values, [fieldId]: value } } } })
    }
    const adoptInstalled = () => {
        if (!activeId || !draftEntry || !detail.current || !fields) return
        // Keep every value whose field still exists (also when it became invalid, so it can be corrected visibly);
        // new fields start with their default. Nothing is persisted before an explicit save.
        const values: Record<string, unknown> = {}
        for (const field of fields) values[field.id] = Object.hasOwn(draftEntry.values, field.id) ? draftEntry.values[field.id] : structuredClone(field.default)
        autoEntries.current.delete(activeId)
        update({ ...draft, modules: { ...draft.modules, [activeId]: { moduleDigest: detail.current.digest, values } } })
    }

    const removeEntry = (id: string) => {
        autoEntries.current.delete(id)
        const modules = { ...draft.modules }
        delete modules[id]
        update({ ...draft, modules })
    }
    const inactiveEntries = Object.entries(draft.modules).filter(([id]) => id !== activeId)
    const fieldPrefix = `ev-dev-field-${draftKey}`
    const pickerOptions = modulePickerOptions(catalog, persisted, draft)
    const sameModule = activeId === savedActive && !changed
    const persistedLabel = describeActiveModule(persisted.settings, catalog)
    const storedOnly = needsAdoption && draftEntry ? Object.entries(draftEntry.values) : []
    const newFields = adopting && fields && savedEntry ? new Set(fields.filter(field => !Object.hasOwn(savedEntry.values, field.id)).map(field => field.id)) : undefined
    const droppedValues = adopting && fields && savedEntry ? Object.entries(savedEntry.values).filter(([key]) => !fields.some(field => field.id === key)) : []

    return <div className="ev-dev">
        <section className="ev-panel" aria-labelledby="ev-dev-title">
            <div className="ev-dev-summary"><div>
                <h2 id="ev-dev-title">Entwicklungsmodul</h2>
                <p>{persisted.revision === 0 ? 'Noch nicht eingerichtet: Sitzungen arbeiten allgemein.' : `Gespeichert: ${persistedLabel} · Revision ${persisted.revision}${persisted.updatedBy ? ` · ${persisted.updatedBy.displayName}` : ''}${persisted.updatedAt ? `, ${formatTimestamp(persisted.updatedAt)}` : ''}`}</p>
                <div className="ev-dev-pills">
                    <span className="ev-dev-pill" data-tone={savedActive ? 'accent' : undefined}>Aktiv: {persistedLabel}</span>
                    {persisted.active.state !== 'ready' && persisted.active.state !== 'none' && <span className="ev-dev-pill" data-tone="warn">{moduleStateLabels[persisted.active.state]}</span>}
                    {changed && <span className="ev-dev-pill" data-tone="warn">Ungespeicherter Entwurf</span>}
                </div>
            </div><button type="button" disabled={refetching || saving} onClick={reload}>Gespeicherte Fassung neu laden</button></div>
            {refreshError != null && <div className="ev-error" role="alert"><p>Aktualisieren fehlgeschlagen: {describeDevelopmentError(refreshError)} Angezeigt wird die zuletzt geladene Fassung (Revision {persisted.revision}){changed ? '; dein Entwurf bleibt erhalten' : ''}.</p>
                <div className="ev-actions"><button type="button" disabled={refetching} onClick={reload}>Erneut versuchen</button></div></div>}
            {persisted.active.state !== 'ready' && persisted.active.state !== 'none' && <div className="ev-callout" role="status">
                <p><strong>{persistedLabel}: {moduleStateLabels[persisted.active.state]}.</strong> {describeModuleState(persisted.active.state)}</p>
                {/* Specific reasons (e.g. which provider is unknown) add information; generic ones would repeat the sentence above. */}
                {(persisted.active.state === 'unsupported' || persisted.active.state === 'invalid') && persisted.active.reasons.length > 0 && <ul className="ev-dev-links">{persisted.active.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
            </div>}

            {intentOpen && changed && <div className="ev-callout" role="status" id="ev-dev-intent">
                <p><strong>Vorgemerkt, noch nicht gespeichert.</strong> {draft.activeModuleId && draft.activeModuleId !== savedActive ? `Modul ${describeActiveModule({ activeModuleId: draft.activeModuleId, odoo: draft.odoo }, catalog)} ist nur ein Entwurf und noch nicht aktiv. ` : ''}{draft.repositoryId && draft.repositoryId !== persisted.settings.repositoryId ? 'Das gewählte Standard-Repository ist vorgemerkt. ' : ''}Erst „Speichern“ übernimmt die Angaben; „Verwerfen“ entfernt die Vormerkung.</p>
                {savedDiffers && <p>Inzwischen ist dieses Modul mit anderen Werten oder einer anderen Fassung gespeichert (Revision {persisted.revision}). Angezeigt wird deine Vormerkung; „Speichern“ ersetzt die gespeicherte Konfiguration, „Verwerfen“ behält sie.</p>}
            </div>}
            {!canEdit && applyIntent(persistedInput, intent) && <p className="ev-callout" role="note">In diesem Browser ist für dieses Projekt ein Entwurf vorgemerkt. Nur Projektadministratoren können ihn prüfen und speichern; er bleibt unverändert erhalten.</p>}

            {stale && <div className="ev-callout" role="alert">
                <p><strong>Die Konfiguration wurde inzwischen geändert</strong> (Revision {persisted.revision}{persisted.updatedBy ? ` von ${persisted.updatedBy.displayName}` : ''}{persisted.updatedAt ? `, ${formatTimestamp(persisted.updatedAt)}` : ''}): {persistedLabel}. Dein Entwurf wurde nicht gespeichert und ist erhalten.</p>
                <div className="ev-actions"><button type="button" onClick={discard}>Gespeicherte Fassung übernehmen (Entwurf verwerfen)</button><button type="button" onClick={() => { setBaseRevision(persisted.revision); setNotice('') }}>Entwurf behalten und auf Revision {persisted.revision} aufbauen</button></div>
            </div>}

            <form className="ev-dev-form" aria-label="Einstellungen des Entwicklungsmoduls" noValidate onSubmit={event => { event.preventDefault(); save() }}
                // A disabled save button blocks implicit submission; Enter in a text field still leads to the first problem.
                onKeyDown={event => { if (event.key === 'Enter' && saveBlocker && event.target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(event.target.type)) { event.preventDefault(); focusFirstInvalid() } }}>
                <div className="ev-dev-wide">
                    <DevelopmentModulePicker options={pickerOptions} value={activeId} disabled={!editable} onChange={chooseModule} describedBy="ev-dev-mode-hint" />
                    <p className="ev-dev-mode-hint" id="ev-dev-mode-hint">{builtinMode ? modeHints[builtinMode] : selectedEntry?.summary ?? ''} Ein Modul ist kein Sicherheitsprofil: Es ändert keine Rechte oder Freigaben, installiert nichts und startet nichts.</p>
                </div>
                {selectedEntry && <ModuleSource entry={selectedEntry} saved={savedEntry ?? null} />}
                {activeId && !selectedEntry && <div className="ev-dev-wide ev-callout" role="status"><p><strong>Dieses Modul ist nicht installiert.</strong> {describeModuleState('missing')} Wähle ein anderes Modul oder lass die Auswahl unverändert.</p></div>}
                <div className="ev-dev-wide"><RepositorySelect label="Standard-Repository für Sitzungen" emptyLabel="Kein Standard (Projektordner)" choices={repositories} value={draft.repositoryId} disabled={!editable} onChange={repositoryId => update({ ...draft, repositoryId })}
                    hint="Vorauswahl für neue Sitzungen; beim Start änderbar. Gilt für jedes Modul." />
                    <RepositoryStatus choices={repositories} repositoryId={draft.repositoryId} projectId={projectId} /></div>
                {renderer === 'odoo' && draft.odoo && <OdooFields key={`odoo:${draftKey}`} value={draft.odoo} onChange={odoo => update({ ...draft, odoo })} majors={ODOO_MAJORS} choices={repositories} repositoryId={draft.repositoryId} disabled={!editable} invalidField={invalidField} projectId={projectId} />}
                {renderer === 'ios' && draft.ios && <IosFields key={`ios:${draftKey}`} value={draft.ios} onChange={ios => update({ ...draft, ios })} disabled={!editable} invalidField={invalidField} projectId={projectId} />}
                {renderer === 'android' && draft.android && <AndroidFields key={`android:${draftKey}`} value={draft.android} onChange={android => update({ ...draft, android })} canEdit={canEdit} acknowledgement={persisted.androidSdkLicenseAcknowledgement} disabled={!editable} invalidField={invalidField} projectId={projectId} />}

                {pluginSelected && needsAdoption && <div className="ev-dev-wide ev-callout" role="status">
                    <p><strong>Neue Modulfassung installiert.</strong> Die Einstellungen dieses Projekts gehören zu Fassung <code>{shortDigest(draftEntry!.moduleDigest)}</code>, installiert ist <code>{shortDigest(selectedEntry!.digest)}</code> ({selectedEntry!.contentVersion}). Bis ein Projektadministrator die neue Fassung übernimmt, sind Aufgaben, Prüfungen und Handbuch gesperrt. Die gespeicherten Werte bleiben unverändert.</p>
                    {storedOnly.length > 0 && <details><summary>Gespeicherte Werte ({storedOnly.length})</summary><ul className="ev-dev-links">{storedOnly.map(([key, value]) => <li key={key}>{fields?.find(field => field.id === key)?.label ?? key}: <code>{formatValue(value)}</code></li>)}</ul></details>}
                    {canEdit && selectedEntry!.state === 'ready' && <div className="ev-actions"><button type="button" disabled={!editable || !fields} onClick={adoptInstalled}>{fields ? 'Installierte Fassung übernehmen und Werte prüfen' : 'Moduldetails werden geladen …'}</button></div>}
                    {!canEdit && <p className="ev-muted">Nur Projektadministratoren können eine neue Fassung übernehmen.</p>}
                </div>}
                {pluginSelected && adopting && !needsAdoption && <div className="ev-dev-wide ev-callout" role="status">
                    <p><strong>Übernahme vorbereitet (noch nicht gespeichert).</strong> Prüfe die Werte für Fassung {selectedEntry?.contentVersion ?? ''}; neue Felder sind mit ihrer Vorgabe vorbelegt und markiert.</p>
                    {droppedValues.length > 0 && <p>Diese gespeicherten Werte gehören zu Feldern, die es in der neuen Fassung nicht mehr gibt, und werden mit dem Speichern nicht übernommen: {droppedValues.map(([key, value]) => `${key} = ${formatValue(value)}`).join(' · ')}</p>}
                </div>}
                {pluginSelected && !needsAdoption && draftEntry && fields && <DevelopmentModuleFields key={`${activeId}:${draftKey}:${draftEntry.moduleDigest}`} fields={fields} values={draftEntry.values} onChange={setValue}
                    disabled={!valuesEditable} issues={fieldIssues} choices={repositories} projectId={projectId} idPrefix={fieldPrefix} newFields={newFields} />}
                {pluginSelected && !needsAdoption && draftEntry && !fields && selectedEntry && (detail.error
                    ? <p className="ev-dev-wide ev-error" role="alert">Moduldetails nicht geladen: {describeDevelopmentError(detail.error)} <button type="button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>Erneut laden</button></p>
                    : detail.changed ? <p className="ev-dev-wide ev-callout" role="status">Das Modul wurde gerade geändert. <button type="button" onClick={reload}>Katalog neu laden</button></p>
                        : <p className="ev-dev-wide ev-muted" role="status">Moduldetails werden geladen …</p>)}
                {pluginSelected && !needsAdoption && draftEntry && !selectedEntry && <StoredValues entry={draftEntry} />}
                {inactiveEntries.length > 0 && <details className="ev-dev-wide"><summary>Aufbewahrte Einstellungen anderer Module ({inactiveEntries.length})</summary>
                    <p className="ev-muted">Beim Wechsel des Moduls bleiben diese Werte erhalten und gelten wieder, wenn das Modul erneut gewählt wird.</p>
                    <ul className="ev-dev-checks">{inactiveEntries.map(([id, entry]) => { const entryInfo = catalog.find(item => item.id === id); return <li key={id}><div>
                        <strong>{entryInfo?.title ?? describeActiveModule({ activeModuleId: id, odoo: null }, catalog)}</strong>
                        <small>{entryInfo ? entryInfo.digest === entry.moduleDigest ? 'Passt zur installierten Fassung' : 'Ältere Fassung; bei erneuter Wahl übernehmen' : 'Nicht mehr installiert'} · {Object.keys(entry.values).length} Werte</small>
                    </div>{canEdit && <button type="button" disabled={!editable} onClick={() => removeEntry(id)} aria-label={`Aufbewahrte Einstellungen von ${entryInfo?.title ?? id} entfernen`}>Entfernen</button>}</li> })}</ul>
                    {canEdit && <p className="ev-muted">Entfernen wirkt erst mit dem Speichern.</p>}
                </details>}
                {selectedEntry && !sameModule && detail.current && detail.current.constraints.length > 0 && <details className="ev-dev-wide"><summary>Grenzen und Voraussetzungen ({detail.current.constraints.length})</summary><ul className="ev-dev-links">{detail.current.constraints.map(item => <li key={item}>{item}</li>)}</ul></details>}

                {error && <p className="ev-dev-wide ev-error" role="alert">{error}</p>}
                {otherIssues.length > 0 && <ul className="ev-dev-wide ev-dev-links ev-dev-invalid">{otherIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
                {notice && <p className="ev-dev-wide ev-success" role="status">{notice}</p>}
                {canEdit && <div className="ev-dev-wide ev-dev-savebar">
                    <p id="ev-dev-save-state" data-state={saveBlocker ? undefined : 'dirty'} role="status">{saveBlocker ?? `Ungespeichert: ${describeActiveModule({ activeModuleId: activeId, odoo: draft.odoo }, catalog)}.`}</p>
                    <div className="ev-actions">{changed && <button type="button" disabled={saving} onClick={discard}>Verwerfen</button>}<button type="submit" className="ev-primary" disabled={!!saveBlocker} aria-describedby="ev-dev-save-state">Speichern</button></div>
                </div>}
                {!canEdit && <p className="ev-dev-wide ev-muted" role="note">Nur Projektadministratoren können das Entwicklungsmodul ändern.</p>}
            </form>
        </section>

        {section === 'all' && savedActive && <ModuleWorkspace config={persisted} unsaved={changed} />}
        {section === 'all' && !savedActive && <section className="ev-panel"><h2>Was ein Modul bringt</h2><p className="ev-muted">Handbuch, Werkzeug- und Projektprüfung sowie passende Aufgaben zum Starten.</p></section>}
    </div>
}

/** Tools, tasks and handbook of the saved, ready module; anything else is reported, never substituted. */
function ModuleWorkspace({ config, unsaved }: { config: ProjectDevelopmentModuleConfig; unsaved: boolean }) {
    const evolved = useEvolved()
    // A doctor remedy may open the start form of the matching task; starting stays an explicit click there.
    const [requestedTask, setRequestedTask] = useState<{ id: string; nonce: number } | null>(null)
    const context = useDevelopmentModuleContext(evolved, config.revision)
    const current = context.current
    const refresh = () => void context.refetch()
    const client = useQueryClient()
    const moduleChanged = () => void invalidateDevelopmentQueries(client)
    if (config.active.state !== 'ready') return <section className="ev-panel" aria-labelledby="ev-dev-unavailable">
        <h2 id="ev-dev-unavailable">Aufgaben, Prüfungen und Handbuch gesperrt</h2>
        <p role="status">Solange das Modul nicht bereit ist ({moduleStateLabels[config.active.state]}), startet HAPI keine Aufgaben oder Prüfungen dieses Moduls und zeigt kein Handbuch. Es wird auch nicht auf „Allgemein“ oder ein anderes Modul ausgewichen.</p>
    </section>
    // Content must come from the saved revision and exactly the module revision the configuration reports.
    const matches = current && current.revision === config.revision && current.active.state === 'ready' && !!current.module
        && current.module.id === config.active.moduleId && current.module.digest === config.active.installedDigest
    return <>
        {context.error && <p className="ev-error" role="alert">{current ? `Projektkontext nicht aktualisiert (angezeigt: Stand ${formatTimestamp(current.observedAt)}): ` : 'Projektkontext nicht verfügbar: '}{describeDevelopmentError(context.error)} <button type="button" disabled={context.isFetching} onClick={refresh}>Erneut laden</button></p>}
        {!current && !context.error && <Loading />}
        {current && !matches && <p className="ev-callout" role="status">{current.active.state !== 'ready' ? `${moduleStateLabels[current.active.state]}: ${describeModuleState(current.active.state)}` : `Der Projektkontext stammt von Revision ${current.revision} oder einer anderen Modulfassung.`} <button type="button" disabled={context.isFetching} onClick={refresh}>Aktualisieren</button></p>}
        {current && matches && <>
            <DevelopmentTools config={config} context={current} module={current.module!} unsaved={unsaved} canRun={canWriteProject(evolved.project!.role)} onContextRefresh={refresh} onModuleChanged={moduleChanged}
                onOpenTask={id => setRequestedTask(previous => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))} />
            <DevelopmentTasks config={config} module={current.module!} unsaved={unsaved} onModuleChanged={moduleChanged} requestedTask={requestedTask} />
            <DevelopmentHandbook config={config} module={current.module!} />
        </>}
    </>
}

function modulePickerOptions(catalog: readonly DevelopmentModuleCatalogEntry[], persisted: ProjectDevelopmentModuleConfig, draft: DevelopmentModuleSettingsInput): ModulePickerOption[] {
    const savedActive = persisted.settings.activeModuleId
    const options: ModulePickerOption[] = [{ id: null, title: modeLabels.none, detail: 'Keine Spezialisierung; Sitzungen arbeiten wie bisher.' }]
    for (const entry of catalog) {
        const origin = moduleOriginLabel(entry.source)
        const stored = draft.modules[entry.id]
        const outdated = !!stored && stored.moduleDigest !== entry.digest
        const saved = entry.id === savedActive
        options.push({
            id: entry.id, title: entry.title, detail: `${origin} · Fassung ${entry.contentVersion}${stored && !saved ? ' · Einstellungen vorhanden' : ''}`,
            badge: entry.state !== 'ready' ? moduleStateLabels[entry.state] : outdated ? 'Neue Fassung' : saved ? 'Gespeichert' : undefined,
            tone: entry.state !== 'ready' || outdated ? 'warn' : saved ? 'accent' : undefined,
            // A module that cannot be activated stays visible with its reason; the saved one stays selectable.
            disabled: entry.state !== 'ready' && !saved && draft.activeModuleId !== entry.id,
        })
    }
    // The saved module stays visible even when it is no longer installed.
    for (const id of [savedActive, draft.activeModuleId]) if (id && !catalog.some(entry => entry.id === id) && !options.some(option => option.id === id)) {
        options.push({ id, title: describeActiveModule({ activeModuleId: id, odoo: null }, catalog), detail: 'Nicht mehr installiert · Einstellungen bleiben erhalten', badge: moduleStateLabels.missing, tone: 'warn' })
    }
    return options
}

function ModuleSource({ entry, saved }: { entry: DevelopmentModuleCatalogEntry; saved: PluginModuleSettingsEntry | null }) {
    if (entry.source.kind === 'builtin') return <p className="ev-dev-wide ev-muted">Mitgeliefert mit HAPI · Fassung {entry.contentVersion} · wird mit HAPI aktualisiert.</p>
    const source = entry.source, bundled = isBundledPluginId(source.pluginId)
    return <details className="ev-dev-wide"><summary>Herkunft: {moduleOriginLabel(source)} · {source.repository}{bundled ? ' · unveränderlich' : ''}{!source.enabled ? ' · deaktiviert' : ''}</summary>
        <dl className="ev-dev-provenance">
            <dt>Installiert</dt><dd>Fassung {entry.contentVersion} · Commit <code>{source.commitSha.slice(0, 12)}</code> · Manifest <code>{source.manifestSha256.slice(0, 12)}</code> · Modul <code>{shortDigest(entry.digest)}</code></dd>
            <dt>Im Projekt</dt><dd>{saved ? <>Übernommen am {formatTimestamp(saved.adopted.at)} aus Version {saved.adopted.pluginVersion}, Commit <code>{saved.adopted.commitSha.slice(0, 12)}</code> · Modul <code>{shortDigest(saved.moduleDigest)}</code>{saved.moduleDigest !== entry.digest ? ' · ältere Fassung' : ''}</> : 'Noch nicht gespeichert'}</dd>
            <dt>Aktualisierung</dt><dd>{bundled ? 'Mit HAPI ausgeliefert und über die Plugin-Verwaltung weder änderbar noch entfernbar. Eine neue Fassung kommt nur mit einem HAPI-Release und gilt erst, wenn ein Projektadministrator sie hier übernimmt.' : 'Neue Plugin-Fassungen gelten erst, wenn ein Projektadministrator sie hier übernimmt.'}</dd>
            <dt>Inhalt</dt><dd>{entry.counts.tasks} Aufgaben · {entry.counts.topics} Handbuchthemen · {entry.counts.checks} Prüfungen{entry.providers.some(provider => !provider.supported) ? ' · enthält nicht unterstützte Prüfungen' : ''}</dd>
        </dl>
        {entry.reasons.length > 0 && <ul className="ev-dev-links">{entry.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </details>
}

function StoredValues({ entry }: { entry: { moduleDigest: string; values: Record<string, unknown> } }) {
    const values = Object.entries(entry.values)
    return <details className="ev-dev-wide"><summary>Gespeicherte Werte ({values.length})</summary><ul className="ev-dev-links">{values.map(([key, value]) => <li key={key}>{key}: <code>{formatValue(value)}</code></li>)}</ul></details>
}
function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'leer'
    if (typeof value === 'boolean') return value ? 'ja' : 'nein'
    if (Array.isArray(value)) return value.length ? value.join(', ') : 'leer'
    return String(value)
}

/** Compact overview entry: shows only the persisted module and its availability, never a draft or assumed readiness. */
export function DevelopmentOverviewCard() {
    const evolved = useEvolved()
    const modules = useDevelopmentModules(evolved)
    const projectId = evolved.project!.id
    const current = modules.current
    const settings = current?.config.settings
    const state = current?.config.active.state
    return <section className="ev-panel ev-dev-summary" aria-label="Entwicklungsmodul">
        <div><h2>Entwicklung</h2>
            <p role="status">{!current && modules.error ? `Nicht verfügbar: ${describeDevelopmentError(modules.error)}` : !current || !settings ? 'Wird geladen …' : !settings.activeModuleId ? 'Allgemein – kein Modul gespeichert.'
                : `${describeActiveModule(settings, current.catalog.modules)}${state && state !== 'ready' ? ` · ${moduleStateLabels[state]}` : ''}${settings.repositoryId ? ' · mit Standard-Repository' : ' · ohne Standard-Repository'}`}</p></div>
        <div className="ev-actions"><WorkspaceLink tab="development" projectId={projectId} className="ew-text-link">{settings?.activeModuleId ? state === 'ready' ? 'Handbuch, Prüfungen und Aufgaben' : 'Status ansehen' : 'Modul wählen'}</WorkspaceLink>
            <WorkspaceLink tab="setup" projectId={projectId} className="ew-text-link">Einrichtung Schritt für Schritt</WorkspaceLink></div>
    </section>
}
