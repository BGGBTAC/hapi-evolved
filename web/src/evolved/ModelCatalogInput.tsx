import { useEffect, useId, useRef, useState } from 'react'
import { SelectControl } from '@/components/ui/select-control'
import { useProviderModels, type ModelProvider, type ProviderModelsState } from './useProviderModels'

export function ModelCatalogInput(props: {
    provider: ModelProvider
    projectId?: string | null
    value: string
    onChange: (value: string) => void | Promise<void>
    disabled?: boolean
    label?: string
    defaultValue?: string
    catalog?: ProviderModelsState
}) {
    const fetched = useProviderModels({ provider: props.provider, projectId: props.projectId, enabled: !props.catalog })
    const catalog = props.catalog ?? fetched
    const id = useId()
    const defaultValue = props.defaultValue ?? 'auto'
    const [manual, setManual] = useState(false)
    const [draft, setDraft] = useState('')
    const [pending, setPending] = useState(false), [changeError, setChangeError] = useState<string | null>(null)
    const generation = useRef(0), changing = useRef(false)
    useEffect(() => {
        generation.current++; changing.current = false; setManual(false); setDraft(''); setPending(false); setChangeError(null)
        return () => { generation.current++ }
    }, [props.provider, props.projectId])
    const change = async (value: string) => {
        if (changing.current || props.disabled) return
        const current = generation.current
        changing.current = true; setPending(true); setChangeError(null)
        try { await props.onChange(value); if (generation.current === current) setManual(false) }
        catch (error) { if (generation.current === current) setChangeError(error instanceof Error ? error.message : 'Modell konnte nicht geändert werden.') }
        finally { if (generation.current === current) { changing.current = false; setPending(false) } }
    }
    const disabled = props.disabled || pending
    const data = catalog.data
    const models = data?.status === 'ready' ? data.models : []
    const outsideCatalog = props.value !== defaultValue && !models.some(model => model.id === props.value)
    return <div lang="de" className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={id} className="min-w-0 flex-1 basis-24 text-xs font-medium text-[var(--app-hint)]">{props.label ?? 'Modell'}</label>
            {catalog.canRefresh && <button type="button" className="min-h-11 shrink-0 whitespace-nowrap px-2 text-xs text-[var(--app-link)]" disabled={catalog.isLoading} onClick={() => void catalog.refresh()}>{catalog.isLoading ? 'Wird geprüft …' : 'Liste aktualisieren'}</button>}
        </div>
        <SelectControl style={{ paddingRight: 40, textOverflow: 'ellipsis' }} id={id} aria-describedby={`${id}-status`} value={props.value} disabled={disabled}
            className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-text)]"
            onChange={event => void change(event.target.value)}>
            <option value={defaultValue}>Standard des Anbieters</option>
            {outsideCatalog && <option value={props.value}>{props.value} (eigene / bisherige Auswahl)</option>}
            {models.filter(model => model.id !== defaultValue).map(model => <option key={model.id} value={model.id}>{model.label}{model.resolvedModel && model.resolvedModel !== model.id ? ` · ${model.resolvedModel}` : ''}</option>)}
        </SelectControl>
        <p id={`${id}-status`} role="status" className="text-xs text-[var(--app-hint)]">
            {!catalog.enabled ? 'Projektmitglieder können den Anbieter-Katalog ihres Projekts lesen.'
                : catalog.error && !data ? `Modellliste nicht verfügbar: ${catalog.error}`
                : data?.status === 'disconnected' ? 'Anbieter noch nicht angemeldet. Verbinde ihn unter „Abos verbinden“.'
                : data?.status === 'unavailable' ? data.message ?? (catalog.canRefresh ? 'Noch kein Katalog verfügbar. Klicke auf „Liste aktualisieren“.' : 'Noch kein Katalog verfügbar. Ein Projektadministrator kann ihn aktualisieren.')
                : catalog.isLoading && !data ? 'Nativer Anbieter-Katalog wird abgefragt …'
                : data?.status === 'ready' ? `Vom angemeldeten ${props.provider === 'codex' ? 'Codex' : 'Claude'}-CLI gemeldet, eventuell zwischengespeichert${data.checkedAt ? ` · geprüft ${new Date(data.checkedAt).toLocaleTimeString()}` : ''}${data.stale ? ' · veraltet' : ''}. Zugriff wird beim Start geprüft.`
                : 'Noch keine Modellliste verfügbar.'}
        </p>
        {catalog.error && data && <p role="alert" className="text-xs text-[var(--app-hint)]">Aktualisierung fehlgeschlagen: {catalog.error} Angezeigt wird der zuletzt geprüfte Stand.</p>}
        {changeError && <p role="alert" className="text-xs text-red-600">{changeError}</p>}
        <p className="text-xs text-[var(--app-hint)]">Katalog des verwalteten Projektdienstes. Ein anderer, manuell verbundener Runner kann andere Modelle und eine andere Anmeldung haben.</p>
        {data?.method === 'api-key' && <p className="text-xs text-[var(--app-hint)]">Der Runner verwendet einen API-Schlüssel, kein Anbieterabo.</p>}
        <button type="button" className="min-h-11 self-start text-xs text-[var(--app-link)]" aria-expanded={manual} disabled={disabled} onClick={() => { setManual(value => !value); setDraft(outsideCatalog ? props.value : '') }}>Eigene Modell-ID</button>
        {manual && <div className="flex min-w-0 flex-wrap gap-2">
            <label className="min-w-0 flex-1 text-xs">Modell-ID<input aria-label="Eigene Modell-ID" className="mt-1 min-h-11 w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] p-2 text-base" value={draft} maxLength={100} autoComplete="off" disabled={disabled} onChange={event => setDraft(event.target.value)} /></label>
            <button type="button" className="min-h-11 self-end px-2" disabled={disabled || !draft.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,99}$/.test(draft.trim())} onClick={() => void change(draft.trim())}>Übernehmen</button>
            <p className="w-full text-xs text-[var(--app-hint)]">Für eine neue oder besondere Modell-ID. Kein Verfügbarkeitsnachweis; ungültige oder nicht freigegebene IDs meldet der Anbieter als Fehler.</p>
        </div>}
    </div>
}
