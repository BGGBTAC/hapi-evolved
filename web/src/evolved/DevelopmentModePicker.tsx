import { useId, type CSSProperties } from 'react'
import './development.css'

export type SegmentOption<T extends string> = { id: T; label: string; disabled?: boolean }

// A compact native radio group: arrow keys, form semantics and screen readers
// work without a custom listbox. Options always come from the shared catalog.
export function SegmentedChoice<T extends string>({ legend, options, value, onChange, disabled = false, variant = 'segment', describedBy }: {
    legend: string; options: readonly SegmentOption<T>[]; value: T; onChange: (value: T) => void
    disabled?: boolean; variant?: 'modes' | 'segment'; describedBy?: string
}) {
    const name = useId()
    const style = variant === 'modes' ? { '--ev-dev-mode-count': options.length } as CSSProperties : undefined
    return <fieldset className={variant === 'modes' ? 'ev-dev-modes' : 'ev-dev-segment'} style={style} aria-describedby={describedBy}>
        <legend>{legend}</legend>
        {options.map(option => <label key={option.id} className="ev-dev-mode">
            <input type="radio" name={name} value={option.id} checked={value === option.id} disabled={disabled || option.disabled} onChange={() => onChange(option.id)} />
            {option.label}
        </label>)}
    </fieldset>
}
