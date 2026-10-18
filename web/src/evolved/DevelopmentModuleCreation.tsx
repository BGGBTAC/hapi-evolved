import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { defaultAndroidSettings, defaultIosSettings, defaultOdooSettings, ODOO_MAJORS, type OdooMajor } from '@hapi/protocol/evolvedDevelopment'
import {
    DEVELOPMENT_MODULE_CONTRACT_VERSION, developmentModuleDefaults, modeForBuiltinModuleId, validateDevelopmentModuleValues,
    type DevelopmentModuleField, type DevelopmentModuleSettingsInput,
} from '@hapi/protocol/developmentModules'
import type { EvolvedSession } from './auth'
import { EvolvedApiError } from './api'
import { SegmentedChoice } from './DevelopmentModePicker'
import { DevelopmentModuleFields, DevelopmentModulePicker, type ModulePickerOption } from './DevelopmentModuleFields'
import { describeDevelopmentError, describeFieldIssue, settingsIssues, modeHints, modeLabels, moduleStateLabels, useGlobalDevelopmentCatalog, useGlobalDevelopmentModuleDetail } from './developmentApi'

/** Contract-v2 `development` field of POST /projects (`DevelopmentModuleCreationSchema`). */
type Creation = { contractVersion: typeof DEVELOPMENT_MODULE_CONTRACT_VERSION; settings: DevelopmentModuleSettingsInput }
/** Hub refusals meaning the catalog/detail the user reviewed no longer matches the installed module. */
const STALE_CODES = ['development_module_changed', 'development_module_unavailable', 'development_module_not_found']
type Stale = { moduleId: string; message: string; refreshing: boolean; failed: string | null }

/**
 * Module choice while creating a project, from the project-independent catalog. Builtins keep their
 * reviewed sections (Odoo version choice); plugin modules use their generic fields with the defaults
 * of exactly the revision shown. A new project has no repository grants, so repository fields stay empty.
 */
export function useDevelopmentCreation(evolved: Pick<EvolvedSession, 'api' | 'me'>) {
    const catalog = useGlobalDevelopmentCatalog(evolved)
    const client = useQueryClient()
    const [moduleId, setModuleId] = useState<string | null>(null)
    // Set when the hub refused the reviewed module revision; creation with that module stays blocked until the catalog is reloaded.
    const [stale, setStale] = useState<Stale | null>(null)
    const [odooMajor, setOdooMajor] = useState<OdooMajor>(20)
    const [values, setValues] = useState<Record<string, unknown> | null>(null)
    const [serverIssues, setServerIssues] = useState<Record<string, string>>({})
    const entry = moduleId ? catalog.current?.modules.find(item => item.id === moduleId) ?? null : null
    const fieldsForm = entry?.form.kind === 'fields'
    const detail = useGlobalDevelopmentModuleDetail(evolved, fieldsForm ? moduleId : null, fieldsForm ? entry!.digest : null)
    const fields: readonly DevelopmentModuleField[] | null = detail.current?.form.kind === 'fields' ? detail.current.form.fields : null
    // Typed values stay per field id. After a reload with a changed definition, fields that still exist keep the user's value
    // (re-validated against the new rules), new fields start with their default and values of removed fields are listed, never sent.
    const shown = fields ? values ? Object.fromEntries(fields.map(field => [field.id, Object.hasOwn(values, field.id) ? values[field.id] : structuredClone(field.default)])) : developmentModuleDefaults(fields) : null
    const droppedValues = fields && values ? Object.entries(values).filter(([key]) => !fields.some(field => field.id === key)) : []
    const newFields = fields && values ? new Set(fields.filter(field => !Object.hasOwn(values, field.id)).map(field => field.id)) : undefined
    const staleSelected = !!stale && stale.moduleId === moduleId

    // A new project has no repository grants. A module that requires a repository is therefore created in two phases:
    // the project starts general and the module is only noted as a draft (see `intent`); its repository fields are
    // chosen after the grant and clone in the same project, then the module is activated with the regular save.
    const repositoryFields = new Set(fields?.filter(field => field.kind === 'repository').map(field => field.id) ?? [])
    const needsRepository = fields?.some(field => field.kind === 'repository' && field.required) ?? false
    const issues: Record<string, string> = { ...serverIssues }
    let general: string | null = null
    if (fields && shown) {
        const result = validateDevelopmentModuleValues(fields, shown)
        if (!result.ok) for (const issue of result.issues) {
            if (issue.field && needsRepository && repositoryFields.has(issue.field)) continue
            if (issue.field) issues[issue.field] ??= describeFieldIssue(issue.message)
            else general = describeFieldIssue(issue.message)
        }
    }
    const blocker = !moduleId ? null
        : staleSelected ? 'Das Modul wurde seit dem Laden geändert, deaktiviert oder entfernt. Lade die Modulliste neu und prüfe die Einstellungen, bevor du erneut anlegst.'
        : !entry ? 'Dieses Modul ist nicht mehr im Katalog. Wähle „Allgemein“ oder ein anderes Modul.'
            : entry.state !== 'ready' ? `${entry.title}: ${moduleStateLabels[entry.state]}.`
                : !fieldsForm ? null
                    : detail.error ? `Moduldetails nicht geladen: ${describeDevelopmentError(detail.error)}`
                        : detail.changed ? 'Das Modul wurde gerade geändert. Lade die Modulliste neu.'
                            : !fields ? 'Moduldetails werden geladen …'
                                : general ?? (Object.keys(issues).length ? `Ungültige Moduleinstellungen: ${fields.filter(field => issues[field.id]).map(field => field.label).join(', ')}.` : null)
    const deferred = !!moduleId && !blocker && needsRepository

    const choose = (id: string | null) => { setModuleId(id); setValues(null); setServerIssues({}) }
    /** Reload catalog and module details (both keyed by digest, gcTime 0); nothing is submitted or installed. */
    const refreshModules = async () => {
        setStale(current => current && { ...current, refreshing: true, failed: null })
        await client.invalidateQueries({ predicate: query => query.queryKey[0] === 'evolved' && (query.queryKey[1] === 'development-catalog' || query.queryKey[1] === 'development-catalog-module') })
        const result = await catalog.refetch()
        setServerIssues({})
        setStale(current => current && (result.error ? { ...current, refreshing: false, failed: describeDevelopmentError(result.error) } : null))
    }
    /** Interpret a refused creation: field issues stay at their field, a changed/unavailable module asks for an explicit reload. */
    const handleFailure = (failure: unknown) => {
        const issues = settingsIssues(failure)
        if (issues) { showServerIssues(issues); return }
        if (moduleId && failure instanceof EvolvedApiError && STALE_CODES.includes(failure.code ?? '')) setStale({ moduleId, message: describeDevelopmentError(failure), refreshing: false, failed: null })
    }
    /** Values of fields that no longer exist are dropped explicitly (they would not be sent anyway). */
    const discardDroppedValues = () => { if (shown) setValues(shown) }
    const setValue = (fieldId: string, value: unknown) => {
        if (!shown) return
        setServerIssues(current => { const next = { ...current }; delete next[fieldId]; return next })
        // Values of removed fields stay listed (not sent) until the user discards them explicitly.
        setValues({ ...values, ...shown, [fieldId]: value })
    }
    /** Contract-v2 creation body, or undefined for a general project. */
    const development = (): Creation | undefined => {
        if (!moduleId || deferred) return undefined
        const mode = modeForBuiltinModuleId(moduleId)
        const settings: Creation['settings'] = { activeModuleId: moduleId, repositoryId: null, odoo: null, ios: null, android: null, modules: {} }
        if (mode === 'odoo') settings.odoo = defaultOdooSettings(odooMajor)
        else if (mode === 'ios') settings.ios = defaultIosSettings()
        else if (mode === 'android') settings.android = defaultAndroidSettings()
        else if (detail.current && shown) settings.modules = { [moduleId]: { moduleDigest: detail.current.digest, values: shown } }
        return { contractVersion: DEVELOPMENT_MODULE_CONTRACT_VERSION, settings }
    }
    /** Field issues of a refused creation (`development_module_settings_invalid`) stay at their field until it changes. */
    const showServerIssues = (list: Array<{ path: string[]; message: string }>) => {
        const next: Record<string, string> = {}
        for (const issue of list) if (issue.path[0] === 'modules' && issue.path[1] === moduleId && issue.path[3]) next[issue.path[3]] ??= describeFieldIssue(issue.message)
        setServerIssues(next)
    }
    /** The reviewed module revision and typed values of a deferred (two-phase) module; repository fields stay empty. */
    const intent = (): { moduleId: string; moduleDigest: string; values: Record<string, unknown> } | null => {
        if (!deferred || !moduleId || !detail.current || !shown) return null
        return { moduleId, moduleDigest: detail.current.digest, values: Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, repositoryFields.has(key) ? null : value])) }
    }
    const reset = () => { setModuleId(null); setOdooMajor(20); setValues(null); setServerIssues({}); setStale(null) }
    // Inputs such as lists keep their raw text while typing; an explicit reset remounts them (not on every keystroke).
    const [resetGeneration, setResetGeneration] = useState(0)
    const resetValues = () => { setValues(null); setServerIssues({}); setResetGeneration(generation => generation + 1) }
    return { catalog, moduleId, entry, choose, odooMajor, setOdooMajor, fields, values: shown, setValue, issues, blocker, deferred, intent, development, showServerIssues, handleFailure, reset,
        stale: staleSelected ? stale : null, refreshModules, droppedValues, discardDroppedValues, resetValues, fieldsKey: `${moduleId ?? ''}:${resetGeneration}`, newFields, detailChanged: detail.changed, refetchDetail: () => void detail.refetch() }
}

export function DevelopmentCreationFields({ creation, disabled }: { creation: ReturnType<typeof useDevelopmentCreation>; disabled: boolean }) {
    const { catalog, moduleId, entry } = creation
    const options: ModulePickerOption[] = [{ id: null, title: modeLabels.none, detail: 'Keine Spezialisierung' }]
    for (const item of catalog.current?.modules ?? []) options.push({
        id: item.id, title: item.title, detail: `${item.source.kind === 'plugin' ? `Plugin ${item.source.pluginName} ${item.source.pluginVersion}` : 'Mitgeliefert'} · Fassung ${item.contentVersion}`,
        badge: item.state !== 'ready' ? moduleStateLabels[item.state] : undefined, tone: item.state !== 'ready' ? 'warn' : undefined, disabled: item.state !== 'ready',
    })
    const mode = modeForBuiltinModuleId(moduleId)
    return <div className="ev-form-wide ev-stack">
        <span className="ev-dev-field-label">Entwicklungsmodul</span>
        {catalog.error && <p className="ev-error" role="alert">Modulkatalog nicht geladen: {describeDevelopmentError(catalog.error)} Das Projekt kann allgemein angelegt werden; ein Modul wählst du später unter „Entwicklung“. <button type="button" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>Erneut laden</button></p>}
        {catalog.isPending && !catalog.error ? <p className="ev-muted" role="status">Modulkatalog wird geladen …</p>
            : <DevelopmentModulePicker options={options} value={moduleId} disabled={disabled} onChange={creation.choose} describedBy="ev-create-module-hint" />}
        {mode === 'odoo' && <div><span className="ev-dev-field-label">Odoo-Version</span><SegmentedChoice legend="Odoo-Version" options={ODOO_MAJORS.map(major => ({ id: String(major) as `${OdooMajor}`, label: `${major}.0` }))} value={String(creation.odooMajor) as `${OdooMajor}`} disabled={disabled} onChange={major => creation.setOdooMajor(Number(major) as OdooMajor)} /></div>}
        {creation.stale && <div className="ev-callout" role="alert">
            <p><strong>Modul nicht mehr aktuell.</strong> {creation.stale.message} Das Projekt wurde nicht angelegt. Name, Team, Ordner und deine Eingaben bleiben erhalten.</p>
            {creation.stale.failed && <p className="ev-error">Neu laden fehlgeschlagen: {creation.stale.failed}</p>}
            <div className="ev-actions"><button type="button" disabled={disabled || creation.stale.refreshing} onClick={() => void creation.refreshModules()}>{creation.stale.refreshing ? 'Modulliste wird geladen …' : 'Modulliste neu laden und prüfen'}</button>
                <button type="button" disabled={disabled} onClick={() => creation.choose(null)}>Stattdessen „Allgemein“ wählen</button></div>
        </div>}
        {!creation.stale && moduleId && (!entry || entry.state !== 'ready') && !catalog.isFetching && <div className="ev-callout" role="status">
            <p>{entry ? `${entry.title} ist derzeit nicht verwendbar (${moduleStateLabels[entry.state]}).` : 'Das gewählte Modul ist nicht mehr installiert.'} Wähle „Allgemein“ oder ein anderes Modul.</p>
            <div className="ev-actions"><button type="button" disabled={disabled} onClick={() => creation.choose(null)}>„Allgemein“ wählen</button></div>
        </div>}
        {!creation.stale && creation.detailChanged && <p className="ev-callout" role="status">Das Modul wurde gerade geändert. <button type="button" disabled={disabled || catalog.isFetching} onClick={() => void creation.refreshModules()}>Modulliste neu laden</button></p>}
        {creation.droppedValues.length > 0 && <div className="ev-callout" role="status">
            <p>Die aktuelle Fassung hat diese Felder nicht mehr; ihre Werte werden nicht übernommen: {creation.droppedValues.map(([key, value]) => `${key} = ${Array.isArray(value) ? value.join(', ') : String(value)}`).join(' · ')}</p>
            <div className="ev-actions"><button type="button" disabled={disabled} onClick={creation.discardDroppedValues}>Hinweis bestätigen und Werte verwerfen</button>
                <button type="button" disabled={disabled} onClick={creation.resetValues}>Alle Moduleinstellungen auf Vorgaben zurücksetzen</button></div>
        </div>}
        {creation.fields && creation.values && <div className="ev-dev-form"><DevelopmentModuleFields key={creation.fieldsKey} fields={creation.fields} values={creation.values} onChange={creation.setValue} disabled={disabled || !!creation.stale} issues={creation.issues} choices={null} projectId={null} idPrefix="ev-create-field" newFields={creation.newFields} /></div>}
        {creation.deferred && <div className="ev-callout" role="status" id="ev-create-module-deferred">
            <p><strong>Zweistufige Einrichtung.</strong> {entry?.title ?? 'Dieses Modul'} braucht ein Repository, das ein neues Projekt noch nicht hat. Das Projekt wird zunächst allgemein angelegt; das Modul wird nur in diesem Browser <strong>vorgemerkt</strong> (Entwurf, nicht gespeichert und nicht aktiv).</p>
            <p className="ev-muted">Danach führt dich die Einrichtung durch GitHub-Freigabe und Klonen. Erst wenn das Repository gewählt ist, aktivierst du das Modul ausdrücklich mit „Speichern“.</p>
        </div>}
        <p className="ev-dev-mode-hint" id="ev-create-module-hint">{mode && mode !== 'none' ? modeHints[mode] : entry?.summary ?? modeHints.none} Repository und weitere Details legst du anschließend in der Einrichtung fest. Das Modul ändert keine Rechte und installiert nichts.</p>
        {creation.blocker && <p className="ev-dev-invalid" role="status" id="ev-create-module-blocker">{creation.blocker}</p>}
    </div>
}
