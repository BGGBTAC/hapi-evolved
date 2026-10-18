import { useState } from 'react'
import { defaultAndroidSettings, defaultIosSettings, defaultOdooSettings, ODOO_MAJORS, type OdooMajor } from '@hapi/protocol/evolvedDevelopment'
import {
    DEVELOPMENT_MODULE_CONTRACT_VERSION, developmentModuleDefaults, modeForBuiltinModuleId, validateDevelopmentModuleValues,
    type DevelopmentModuleField, type DevelopmentModuleSettingsInput,
} from '@hapi/protocol/developmentModules'
import type { EvolvedSession } from './auth'
import { SegmentedChoice } from './DevelopmentModePicker'
import { DevelopmentModuleFields, DevelopmentModulePicker, type ModulePickerOption } from './DevelopmentModuleFields'
import { describeDevelopmentError, describeFieldIssue, modeHints, modeLabels, moduleStateLabels, useGlobalDevelopmentCatalog, useGlobalDevelopmentModuleDetail } from './developmentApi'

/** Contract-v2 `development` field of POST /projects (`DevelopmentModuleCreationSchema`). */
type Creation = { contractVersion: typeof DEVELOPMENT_MODULE_CONTRACT_VERSION; settings: DevelopmentModuleSettingsInput }

/**
 * Module choice while creating a project, from the project-independent catalog. Builtins keep their
 * reviewed sections (Odoo version choice); plugin modules use their generic fields with the defaults
 * of exactly the revision shown. A new project has no repository grants, so repository fields stay empty.
 */
export function useDevelopmentCreation(evolved: Pick<EvolvedSession, 'api' | 'me'>) {
    const catalog = useGlobalDevelopmentCatalog(evolved)
    const [moduleId, setModuleId] = useState<string | null>(null)
    const [odooMajor, setOdooMajor] = useState<OdooMajor>(20)
    const [values, setValues] = useState<Record<string, unknown> | null>(null)
    const [serverIssues, setServerIssues] = useState<Record<string, string>>({})
    const entry = moduleId ? catalog.current?.modules.find(item => item.id === moduleId) ?? null : null
    const fieldsForm = entry?.form.kind === 'fields'
    const detail = useGlobalDevelopmentModuleDetail(evolved, fieldsForm ? moduleId : null, fieldsForm ? entry!.digest : null)
    const fields: readonly DevelopmentModuleField[] | null = detail.current?.form.kind === 'fields' ? detail.current.form.fields : null
    const shown = fields ? values ?? developmentModuleDefaults(fields) : null

    const issues: Record<string, string> = { ...serverIssues }
    let general: string | null = null
    if (fields && shown) {
        const result = validateDevelopmentModuleValues(fields, shown)
        if (!result.ok) for (const issue of result.issues) {
            if (issue.field) issues[issue.field] ??= describeFieldIssue(issue.message)
            else general = describeFieldIssue(issue.message)
        }
    }
    const needsRepository = fields?.some(field => field.kind === 'repository' && field.required) ?? false
    const blocker = !moduleId ? null
        : !entry ? 'Dieses Modul ist nicht mehr im Katalog.'
            : entry.state !== 'ready' ? `${entry.title}: ${moduleStateLabels[entry.state]}.`
                : !fieldsForm ? null
                    : detail.error ? `Moduldetails nicht geladen: ${describeDevelopmentError(detail.error)}`
                        : detail.changed ? 'Das Modul wurde gerade geändert. Wähle es erneut.'
                            : !fields ? 'Moduldetails werden geladen …'
                                : needsRepository ? 'Dieses Modul braucht ein Repository, das ein neues Projekt noch nicht hat. Lege das Projekt allgemein an und wähle das Modul danach unter „Entwicklung“.'
                                    : general ?? (Object.keys(issues).length ? `Ungültige Moduleinstellungen: ${fields.filter(field => issues[field.id]).map(field => field.label).join(', ')}.` : null)

    const choose = (id: string | null) => { setModuleId(id); setValues(null); setServerIssues({}) }
    const setValue = (fieldId: string, value: unknown) => {
        if (!shown) return
        setServerIssues(current => { const next = { ...current }; delete next[fieldId]; return next })
        setValues({ ...shown, [fieldId]: value })
    }
    /** Contract-v2 creation body, or undefined for a general project. */
    const development = (): Creation | undefined => {
        if (!moduleId) return undefined
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
    const reset = () => { setModuleId(null); setOdooMajor(20); setValues(null); setServerIssues({}) }
    return { catalog, moduleId, entry, choose, odooMajor, setOdooMajor, fields, values: shown, setValue, issues, blocker, development, showServerIssues, reset, refetchDetail: () => void detail.refetch() }
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
        {creation.fields && creation.values && <div className="ev-dev-form"><DevelopmentModuleFields fields={creation.fields} values={creation.values} onChange={creation.setValue} disabled={disabled} issues={creation.issues} choices={null} projectId={null} idPrefix="ev-create-field" /></div>}
        <p className="ev-dev-mode-hint" id="ev-create-module-hint">{mode && mode !== 'none' ? modeHints[mode] : entry?.summary ?? modeHints.none} Repository und weitere Details legst du später unter „Entwicklung“ fest. Das Modul ändert keine Rechte und installiert nichts.</p>
        {creation.blocker && <p className="ev-dev-invalid" role="status" id="ev-create-module-blocker">{creation.blocker}</p>}
    </div>
}
