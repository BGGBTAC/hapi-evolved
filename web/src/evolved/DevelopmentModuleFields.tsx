import { useId, useState, type ReactNode } from 'react'
import type { DevelopmentModuleField } from '@hapi/protocol/developmentModules'
import type { RepositoryChoices } from './repositoryCatalog'
import { WorkspaceLink } from './workspaceNavigation'
import './development.css'

/**
 * Generic settings form for modules whose catalog form is `{ kind: 'fields' }`.
 * Everything shown comes from the module definition; no field id or module id
 * is interpreted here. Values are kept exactly as typed (including `false`, `0`
 * and empty optional values as `null`) and validated by the shared validator.
 */

export type ModuleFieldValues = Readonly<Record<string, unknown>>
export const moduleFieldDomId = (prefix: string, fieldId: string) => `${prefix}-${fieldId}`

export function DevelopmentModuleFields({ fields, values, onChange, disabled, issues, choices, projectId, idPrefix, newFields }: {
    fields: readonly DevelopmentModuleField[]
    values: ModuleFieldValues
    onChange: (fieldId: string, value: unknown) => void
    disabled: boolean
    /** German message per field id (client validation or authoritative server issue). */
    issues: Readonly<Record<string, string>>
    /** Granted repositories of the project; absent while creating a project (nothing granted yet). */
    choices: RepositoryChoices | null
    /** Project for links to vault/GitHub; absent while creating a project. */
    projectId: string | null
    /** DOM id prefix; field controls get `${idPrefix}-${field.id}` so a parent can focus the first invalid one. */
    idPrefix: string
    /** Fields that are new in an adopted revision (prefilled with their default, not yet saved). */
    newFields?: ReadonlySet<string>
}) {
    if (!fields.length) return <p className="ev-muted ev-dev-wide">Dieses Modul hat keine Einstellungen.</p>
    return <>{fields.map(field => <FieldControl key={field.id} field={field} value={Object.hasOwn(values, field.id) ? values[field.id] : field.default} onChange={value => onChange(field.id, value)}
        disabled={disabled} issue={issues[field.id] ?? null} choices={choices} projectId={projectId} id={moduleFieldDomId(idPrefix, field.id)} isNew={!!newFields?.has(field.id)} />)}</>
}

function FieldControl({ field, value, onChange, disabled, issue, choices, projectId, id, isNew }: {
    field: DevelopmentModuleField; value: unknown; onChange: (value: unknown) => void; disabled: boolean; issue: string | null
    choices: RepositoryChoices | null; projectId: string | null; id: string; isNew: boolean
}) {
    const helpId = field.help ? `${id}-help` : undefined
    const errorId = issue ? `${id}-error` : undefined
    const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined
    const common = { id, disabled, 'aria-invalid': issue ? true : undefined, 'aria-describedby': describedBy, 'aria-required': field.required && field.kind !== 'boolean' ? true : undefined }
    const label = <>{field.label}{!field.required && field.kind !== 'boolean' ? <span className="ev-dev-optional">(optional)</span> : null}{isNew && <span className="ev-dev-pill" data-tone="accent">Neu in dieser Fassung</span>}</>
    const footer = <>{field.help && <small id={helpId}>{field.help}</small>}{issue && <p id={errorId} className="ev-dev-invalid ev-dev-field-error">{issue}</p>}</>
    const text = (input: string) => input === '' || !input.trim() ? null : input
    const wide = field.kind === 'text_list' || field.kind === 'multi_select' || (field.kind === 'text' && field.maxLength > 200)

    if (field.kind === 'boolean') return <div className="ev-dev-module-field">
        <label className="ev-check"><input type="checkbox" {...common} checked={value === true} onChange={event => onChange(event.target.checked)} />{label}</label>{footer}
    </div>
    if (field.kind === 'multi_select') {
        const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
        const unknown = selected.filter(item => !field.options.some(option => option.value === item))
        const toggle = (item: string, on: boolean) => onChange(on ? [...selected, item] : selected.filter(entry => entry !== item))
        return <fieldset className="ev-dev-module-field ev-dev-wide ev-dev-choices" id={id} aria-describedby={describedBy} aria-invalid={issue ? true : undefined}>
            <legend>{label}</legend>
            {field.options.map(option => <label key={option.value} className="ev-check"><input type="checkbox" disabled={disabled} checked={selected.includes(option.value)} onChange={event => toggle(option.value, event.target.checked)} />{option.label}</label>)}
            {unknown.map(item => <label key={`unknown:${item}`} className="ev-check"><input type="checkbox" disabled={disabled} checked onChange={() => toggle(item, false)} />{item} (in dieser Fassung nicht mehr vorhanden)</label>)}
            {footer}
        </fieldset>
    }
    let control: ReactNode
    switch (field.kind) {
        case 'number': {
            const display = typeof value === 'number' ? String(value) : ''
            control = <input type="number" inputMode="numeric" step={1} min={field.min} max={field.max} {...common} value={display}
                onChange={event => onChange(event.target.value === '' ? (event.target.validity?.badInput ? event.target.value || 'ungültig' : null) : Number(event.target.value))} />
            break
        }
        case 'select': {
            const current = typeof value === 'string' ? value : ''
            const unknown = current && !field.options.some(option => option.value === current)
            control = <select {...common} value={current} onChange={event => onChange(event.target.value || null)}>
                <option value="" disabled={field.required && current !== ''}>{field.required ? 'Bitte wählen …' : 'Keine Auswahl'}</option>
                {unknown && <option value={current}>{current} (in dieser Fassung nicht mehr vorhanden)</option>}
                {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            break
        }
        case 'text_list':
            control = <ListInput key={id} common={common} value={Array.isArray(value) ? value.map(String) : []} onChange={onChange} maxLength={field.maxItems * (field.maxLength + 1)} />
            break
        case 'repository': {
            const current = typeof value === 'string' ? value : ''
            const repositories = choices?.current?.repositories ?? []
            const known = repositories.some(item => item.id === current)
            control = <select {...common} disabled={disabled || !choices || choices.isFetching} value={current} onChange={event => onChange(event.target.value || null)}>
                <option value="" disabled={field.required && current !== ''}>{!choices ? 'Nach dem Anlegen wählbar' : field.required ? 'Repository wählen …' : 'Keines'}</option>
                {current && !known && <option value={current}>{choices?.isFetching ? `Repository ${current} · wird geprüft` : `Repository ${current} · nicht verfügbar`}</option>}
                {repositories.map(item => <option key={item.id} value={item.id}>{item.fullName}</option>)}
            </select>
            break
        }
        default: {
            const maxLength = field.kind === 'text' ? field.maxLength : field.kind === 'https_url' ? 500 : field.kind === 'resource' ? 128 : 255
            const placeholder = field.kind === 'repo_path' ? '.' : field.kind === 'https_url' ? 'https://…' : undefined
            control = <input type={field.kind === 'https_url' ? 'url' : 'text'} {...common} value={typeof value === 'string' ? value : ''} maxLength={maxLength} placeholder={placeholder}
                spellCheck={field.kind === 'text' && field.format === 'plain'} autoCapitalize="off" autoCorrect="off" onChange={event => onChange(text(event.target.value))} />
        }
    }
    return <div className={`ev-dev-module-field${wide ? ' ev-dev-wide' : ''}`}>
        <label className="ev-field" htmlFor={id}><span>{label}</span>{control}</label>
        {field.kind === 'resource' && <small>Nur die ID einer vorhandenen Ressource, nie ein Geheimnis.{projectId && <> <WorkspaceLink tab="vault" projectId={projectId}>Tresor</WorkspaceLink> · <WorkspaceLink tab="mcp" projectId={projectId}>MCP-Shop</WorkspaceLink></>}</small>}
        {field.kind === 'repository' && !choices && <small>Ein neues Projekt hat noch keine Repository-Freigaben; wähle das Repository nach dem Anlegen unter „Entwicklung“.</small>}
        {field.kind === 'repository' && choices && projectId && !choices.current?.repositories.length && !choices.isFetching && <small>Noch kein Repository freigegeben. <WorkspaceLink tab="github" projectId={projectId}>Repositorys freigeben</WorkspaceLink></small>}
        {footer}
    </div>
}

/** One entry per line; keeps the raw text while typing and reports the trimmed, non-empty lines. */
function ListInput({ common, value, onChange, maxLength }: { common: Record<string, unknown>; value: string[]; onChange: (value: string[]) => void; maxLength: number }) {
    const [text, setText] = useState(value.join('\n'))
    return <textarea {...common} rows={Math.min(6, Math.max(2, value.length + 1))} value={text} maxLength={maxLength} spellCheck={false} autoCapitalize="off"
        onChange={event => { setText(event.target.value); onChange(event.target.value.split('\n').map(item => item.trim()).filter(Boolean)) }} />
}

export type ModulePickerOption = { id: string | null; title: string; detail: string; badge?: string; tone?: 'warn' | 'accent'; disabled?: boolean }

/**
 * Compact, searchable single choice of the primary module. Native radios keep keyboard,
 * form and screen-reader semantics; the current choice never disappears from a filtered list.
 */
export function DevelopmentModulePicker({ options, value, onChange, disabled, describedBy }: {
    options: readonly ModulePickerOption[]; value: string | null; onChange: (id: string | null) => void; disabled: boolean; describedBy?: string
}) {
    const name = useId()
    const [search, setSearch] = useState('')
    const term = search.trim().toLocaleLowerCase()
    const visible = term ? options.filter(option => option.id === value || `${option.title} ${option.detail}`.toLocaleLowerCase().includes(term)) : options
    return <fieldset className="ev-dev-picker" aria-describedby={describedBy}>
        <legend>Entwicklungsmodul</legend>
        {options.length > 5 && <label className="ev-field ev-dev-picker-search"><span>Module durchsuchen</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, Plugin oder Beschreibung" /></label>}
        {term && <p className="ev-muted" role="status">{visible.length} von {options.length} Einträgen</p>}
        <div className="ev-dev-picker-list">{visible.map((option, index) => {
            // Short accessible name (title); origin, revision and state are announced as description.
            const key = `${name}-${options.indexOf(option) >= 0 ? options.indexOf(option) : index}`
            return <label key={option.id ?? 'none'} className="ev-dev-picker-row" data-disabled={option.disabled || undefined}>
                <input type="radio" name={name} value={option.id ?? ''} checked={value === option.id} disabled={disabled || option.disabled} onChange={() => onChange(option.id)}
                    aria-labelledby={`${key}-title`} aria-describedby={option.badge ? `${key}-detail ${key}-badge` : `${key}-detail`} />
                <span className="ev-dev-picker-text"><strong id={`${key}-title`}>{option.title}</strong><small id={`${key}-detail`}>{option.detail}</small></span>
                {option.badge && <span className="ev-dev-pill" id={`${key}-badge`} data-tone={option.tone}>{option.badge}</span>}
            </label>
        })}</div>
    </fieldset>
}
