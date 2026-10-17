import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    defaultDevelopmentSettings, DevelopmentConfigUpdateResponseSchema, DEVELOPMENT_MODES, ODOO_MAJORS,
    type DevelopmentConfigResponse, type DevelopmentMode, type DevelopmentSettings, type ProjectDevelopmentConfig,
} from '@hapi/protocol/evolvedDevelopment'
import { useEvolved } from './auth'
import { canWriteProject } from './api'
import { Loading } from './ui'
import { WorkspaceLink } from './workspaceNavigation'
import { useProjectRepositories } from './repositoryCatalog'
import { SegmentedChoice } from './DevelopmentModePicker'
import { AndroidFields, IosFields, OdooFields, RepositorySelect, RepositoryStatus } from './DevelopmentSettingsFields'
import { DevelopmentTools } from './DevelopmentTools'
import { DevelopmentTasks } from './DevelopmentTasks'
import { DevelopmentHandbook } from './DevelopmentHandbook'
import {
    conflictConfig, describeDevelopmentError, describeMode, developmentPath, developmentScope, formatTimestamp, modeHints, modeLabels,
    sameSettings, useDevelopmentConfig, useDevelopmentContext, validateSettings,
} from './developmentApi'
import './development.css'

export function ProjectDevelopmentPanel() {
    const evolved = useEvolved()
    if (!evolved.project) return null
    // Account, project, role or profile changes discard drafts, results and late responses.
    return <DevelopmentForProject key={JSON.stringify(developmentScope(evolved))} />
}

function DevelopmentForProject() {
    const evolved = useEvolved()
    const config = useDevelopmentConfig(evolved)
    // Only a load without validated data replaces the workspace; a failed refresh keeps the form and draft.
    if (!config.current) return config.error ? <section className="ev-panel ev-dev" aria-labelledby="ev-dev-error"><h2 id="ev-dev-error">Entwicklungsmodus nicht geladen</h2>
        <p className="ev-error" role="alert">{describeDevelopmentError(config.error)}</p>
        <button disabled={config.isFetching} onClick={() => void config.refetch()}>Erneut laden</button></section> : <Loading />
    return <DevelopmentWorkspace response={config.current} refetching={config.isFetching} refreshError={config.refreshError} reload={() => void config.refetch()} />
}

function DevelopmentWorkspace({ response, refetching, refreshError, reload }: { response: DevelopmentConfigResponse; refetching: boolean; refreshError: unknown; reload: () => void }) {
    const evolved = useEvolved()
    const { api, project } = evolved
    const client = useQueryClient()
    const projectId = project!.id
    const canEdit = response.canEdit
    const [persisted, setPersisted] = useState<ProjectDevelopmentConfig>(response.config)
    const [draft, setDraft] = useState<DevelopmentSettings>(response.config.settings)
    const [baseRevision, setBaseRevision] = useState(response.config.revision)
    const [draftKey, setDraftKey] = useState(0)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState('')
    const saveRequest = useRef<AbortController | null>(null)
    useEffect(() => () => saveRequest.current?.abort(), [])

    const changed = !sameSettings(draft, persisted.settings)
    const stale = changed && baseRevision !== persisted.revision
    // Every incoming config (GET, conflict body, save result) passes through here.
    // Responses can arrive out of order, so the known revision only moves forward.
    const knownRevision = useRef(response.config.revision)
    const adopt = (incoming: ProjectDevelopmentConfig): boolean => {
        if (incoming.projectId !== projectId || incoming.revision <= knownRevision.current) return false
        knownRevision.current = incoming.revision
        setPersisted(incoming)
        return true
    }
    // A newer server revision replaces a clean form; a draft is kept and reported as a conflict.
    useEffect(() => {
        const incoming = response.config
        if (adopt(incoming) && !changed) { setDraft(incoming.settings); setBaseRevision(incoming.revision); setDraftKey(key => key + 1) }
    }, [response.config]) // Only a new server response may replace the form.

    const repositories = useProjectRepositories(evolved)
    const context = useDevelopmentContext(evolved, persisted.settings.mode === 'none' ? undefined : persisted.revision)
    const catalogEntry = draft.mode === 'none' ? null : response.catalog.modes.find(entry => entry.mode === draft.mode) ?? null
    const validation = validateSettings(draft)
    const editable = canEdit && !saving
    const invalidField = validation.valid ? null : validation.field

    const saveBlocker = !canEdit ? 'Nur Projektadministratoren können den Entwicklungsmodus ändern.'
        : saving ? 'Wird gespeichert …'
            : stale ? 'Die gespeicherte Fassung wurde inzwischen geändert. Entscheide oben, wie du fortfährst.'
                : !changed ? 'Keine ungespeicherten Änderungen.'
                    : !validation.valid ? validation.reason : null

    const save = () => {
        if (saveBlocker || saveRequest.current) return
        const controller = new AbortController(); saveRequest.current = controller
        const settings = draft
        setSaving(true); setError(null); setNotice('')
        void (async () => {
            try {
                const result = DevelopmentConfigUpdateResponseSchema.parse(await api.request(developmentPath(projectId), { method: 'PUT', body: { expectedRevision: changed ? baseRevision : persisted.revision, settings }, signal: controller.signal }))
                if (controller.signal.aborted) return
                // A newer revision may already be known from another read; then the saved draft becomes a visible conflict.
                if (adopt(result.config)) { setDraft(result.config.settings); setBaseRevision(result.config.revision); setDraftKey(key => key + 1) }
                setNotice(`Gespeichert als Revision ${result.config.revision}.`)
                await client.invalidateQueries({ queryKey: ['evolved', 'development'] })
            } catch (failure) {
                if (controller.signal.aborted) return
                const current = conflictConfig(failure)
                if (current) { adopt(current); setError(null) } else setError(describeDevelopmentError(failure))
            } finally {
                if (saveRequest.current === controller) saveRequest.current = null
                if (!controller.signal.aborted) setSaving(false)
            }
        })()
    }
    const discard = () => { setDraft(persisted.settings); setBaseRevision(persisted.revision); setDraftKey(key => key + 1); setError(null); setNotice('') }
    const chooseMode = (mode: DevelopmentMode) => { setNotice(''); setDraft(current => defaultDevelopmentSettings(mode, current)) }
    const updateDraft = (next: DevelopmentSettings) => { setNotice(''); setDraft(next) }
    const modeOptions = DEVELOPMENT_MODES.map(mode => ({ id: mode, label: modeLabels[mode] }))
    const sameMode = draft.mode === persisted.settings.mode && !changed

    return <div className="ev-dev">
        <section className="ev-panel" aria-labelledby="ev-dev-title">
            <div className="ev-dev-summary"><div>
                <h2 id="ev-dev-title">Entwicklungsmodus</h2>
                <p>{persisted.revision === 0 ? 'Noch nicht eingerichtet: Sitzungen arbeiten allgemein.' : `Gespeichert: ${describeMode(persisted.settings)} · Revision ${persisted.revision}${persisted.updatedBy ? ` · ${persisted.updatedBy.displayName}` : ''}${persisted.updatedAt ? `, ${formatTimestamp(persisted.updatedAt)}` : ''}`}</p>
                <div className="ev-dev-pills">
                    <span className="ev-dev-pill" data-tone={persisted.settings.mode === 'none' ? undefined : 'accent'}>Aktiv: {describeMode(persisted.settings)}</span>
                    {changed && <span className="ev-dev-pill" data-tone="warn">Ungespeicherter Entwurf</span>}
                </div>
            </div><button type="button" disabled={refetching || saving} onClick={reload}>Gespeicherte Fassung neu laden</button></div>
            {refreshError != null && <div className="ev-error" role="alert"><p>Aktualisieren fehlgeschlagen: {describeDevelopmentError(refreshError)} Angezeigt wird die zuletzt geladene Fassung (Revision {persisted.revision}){changed ? '; dein Entwurf bleibt erhalten' : ''}.</p>
                <div className="ev-actions"><button type="button" disabled={refetching} onClick={reload}>Erneut versuchen</button></div></div>}

            {stale && <div className="ev-callout" role="alert">
                <p><strong>Die Konfiguration wurde inzwischen geändert</strong> (Revision {persisted.revision}{persisted.updatedBy ? ` von ${persisted.updatedBy.displayName}` : ''}{persisted.updatedAt ? `, ${formatTimestamp(persisted.updatedAt)}` : ''}): {describeMode(persisted.settings)}. Dein Entwurf wurde nicht gespeichert und ist erhalten.</p>
                <div className="ev-actions"><button type="button" onClick={discard}>Gespeicherte Fassung übernehmen (Entwurf verwerfen)</button><button type="button" onClick={() => { setBaseRevision(persisted.revision); setNotice('') }}>Entwurf behalten und auf Revision {persisted.revision} aufbauen</button></div>
            </div>}

            <div className="ev-dev-form">
                <div className="ev-dev-wide"><span className="ev-dev-field-label" id="ev-dev-mode-label">Modus</span>
                    <SegmentedChoice legend="Entwicklungsmodus" variant="modes" describedBy="ev-dev-mode-hint" options={modeOptions} value={draft.mode} disabled={!editable} onChange={chooseMode} />
                    <p className="ev-dev-mode-hint" id="ev-dev-mode-hint">{modeHints[draft.mode]} Der Modus ist kein Sicherheitsprofil: Er ändert keine Rechte oder Freigaben und startet nichts.</p>
                </div>
                <div className="ev-dev-wide"><RepositorySelect label="Standard-Repository für Sitzungen" emptyLabel="Kein Standard (Projektordner)" choices={repositories} value={draft.repositoryId} disabled={!editable} onChange={repositoryId => updateDraft({ ...draft, repositoryId })}
                    hint="Vorauswahl für neue Sitzungen; beim Start änderbar." />
                    <RepositoryStatus choices={repositories} repositoryId={draft.repositoryId} projectId={projectId} /></div>
                {draft.mode === 'odoo' && draft.odoo && <OdooFields key={`odoo:${draftKey}`} value={draft.odoo} onChange={odoo => updateDraft({ ...draft, odoo })} majors={catalogEntry?.odooMajors ?? ODOO_MAJORS} choices={repositories} repositoryId={draft.repositoryId} disabled={!editable} invalidField={invalidField} projectId={projectId} />}
                {draft.mode === 'ios' && draft.ios && <IosFields key={`ios:${draftKey}`} value={draft.ios} onChange={ios => updateDraft({ ...draft, ios })} disabled={!editable} invalidField={invalidField} projectId={projectId} />}
                {draft.mode === 'android' && draft.android && <AndroidFields key={`android:${draftKey}`} value={draft.android} onChange={android => updateDraft({ ...draft, android })} canEdit={canEdit} acknowledgement={persisted.androidSdkLicenseAcknowledgement} disabled={!editable} invalidField={invalidField} projectId={projectId} />}
                {catalogEntry && !sameMode && <div className="ev-dev-wide ev-callout"><p><strong>{catalogEntry.title}</strong> · Handbuch {catalogEntry.packVersion}, geprüft am {catalogEntry.verifiedAt}</p><p className="ev-muted">{catalogEntry.summary}</p>
                    {catalogEntry.constraints.length > 0 && <details><summary>Grenzen und Voraussetzungen ({catalogEntry.constraints.length})</summary><ul className="ev-dev-links">{catalogEntry.constraints.map(item => <li key={item}>{item}</li>)}</ul></details>}</div>}
            </div>

            {error && <p className="ev-error" role="alert">{error}</p>}
            {notice && <p className="ev-success" role="status">{notice}</p>}
            {canEdit && <div className="ev-dev-savebar">
                <p id="ev-dev-save-state" data-state={saveBlocker ? undefined : 'dirty'} role="status">{saveBlocker ?? `Ungespeichert: ${describeMode(draft)}.`}</p>
                <div className="ev-actions">{changed && <button type="button" disabled={saving} onClick={discard}>Verwerfen</button>}<button type="button" className="ev-primary" disabled={!!saveBlocker} aria-describedby="ev-dev-save-state" onClick={save}>Speichern</button></div>
            </div>}
            {!canEdit && <p className="ev-muted" role="note">Nur Projektadministratoren können den Entwicklungsmodus ändern.</p>}
        </section>

        {persisted.settings.mode !== 'none' && <>
            {context.error && <p className="ev-error" role="alert">{context.current ? `Projektkontext nicht aktualisiert (angezeigt: Stand ${formatTimestamp(context.current.observedAt)}): ` : 'Projektkontext nicht verfügbar: '}{describeDevelopmentError(context.error)} <button type="button" disabled={context.isFetching} onClick={() => void context.refetch()}>Erneut laden</button></p>}
            {!context.current && !context.error && <Loading />}
            {context.current && context.current.revision !== persisted.revision && <p className="ev-callout" role="status">Der Projektkontext stammt von Revision {context.current.revision}. <button type="button" onClick={() => void context.refetch()}>Aktualisieren</button></p>}
            {context.current && context.current.revision === persisted.revision && <>
                <DevelopmentTools config={persisted} context={context.current} unsaved={changed} canRun={canWriteProject(project!.role)} onContextRefresh={() => void context.refetch()} />
                <DevelopmentTasks config={persisted} context={context.current} unsaved={changed} />
                <DevelopmentHandbook config={persisted} context={context.current} />
            </>}
        </>}
        {persisted.settings.mode === 'none' && <section className="ev-panel"><h2>Was ein Modus bringt</h2><p className="ev-muted">Handbuch, Werkzeug- und Projektprüfung sowie passende Aufgaben zum Starten.</p></section>}
    </div>
}

/** Compact overview entry: shows only the persisted mode, never a draft or assumed readiness. */
export function DevelopmentOverviewCard() {
    const evolved = useEvolved()
    const config = useDevelopmentConfig(evolved)
    const projectId = evolved.project!.id
    const settings = config.current?.config.settings
    return <section className="ev-panel ev-dev-summary" aria-label="Entwicklungsmodus">
        <div><h2>Entwicklung</h2>
            <p role="status">{!settings && config.error ? `Nicht verfügbar: ${describeDevelopmentError(config.error)}` : !settings ? 'Wird geladen …' : settings.mode === 'none' ? 'Allgemein – keine Spezialisierung gespeichert.' : `${describeMode(settings)}${settings.repositoryId ? ' · mit Standard-Repository' : ' · ohne Standard-Repository'}`}</p></div>
        <WorkspaceLink tab="development" projectId={projectId} className="ew-text-link">{settings && settings.mode !== 'none' ? 'Handbuch, Prüfungen und Aufgaben' : 'Modus wählen'}</WorkspaceLink>
    </section>
}
