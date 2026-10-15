import { useState } from 'react'
import type { AgentConfigFieldDescriptor } from '@hapi/protocol'
import { SelectControl } from '@/components/ui/select-control'

export function AgentConfigFieldControl(props: {
    field: AgentConfigFieldDescriptor; label: string; value: string | null;
    options: ReadonlyArray<{ value: string | null; label: string; group?: string; disabled?: boolean }>;
    disabled?: boolean; onChange?: (value: string | null) => void | Promise<void>
}) {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const blocked = pending || props.disabled || !props.onChange || props.field.kind === 'status' || Boolean(props.field.unavailableReason) || props.options.length === 0
    return <label className="flex flex-col gap-1.5 px-3 py-3 text-xs font-medium text-[var(--app-hint)]">
        {props.label}
        <SelectControl aria-label={props.label} value={props.value ?? ''} disabled={blocked}
            className="rounded border border-[var(--app-divider)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-text)] disabled:opacity-50"
            onChange={event => {
                const value = event.target.value || null
                setError(null); setPending(true)
                try { void Promise.resolve(props.onChange?.(value)).catch(reason => setError(String(reason))).finally(() => setPending(false)) }
                catch (reason) { setError(String(reason)); setPending(false) }
            }}>
            {!props.options.some(option => option.value === props.value) ? <option value={props.value ?? ''} disabled>{props.value ?? 'Default'}</option> : null}
            {props.options.filter(option => !option.group).map(option => <option key={option.value ?? ''} value={option.value ?? ''} disabled={option.disabled}>{option.label}</option>)}
            {[...new Set(props.options.map(option => option.group).filter((group): group is string => Boolean(group)))].map(group =>
                <optgroup key={group} label={group}>{props.options.filter(option => option.group === group).map(option => <option key={option.value ?? ''} value={option.value ?? ''} disabled={option.disabled}>{option.label}</option>)}</optgroup>)}
        </SelectControl>
        {error ? <span role="alert">{error}</span> : null}
        {props.field.unavailableReason ? <span role="status">{props.field.unavailableReason}</span> : null}
    </label>
}
