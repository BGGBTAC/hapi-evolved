import { useId } from 'react'
import { Field } from './ui'

const TITLE_MAX_LENGTH = 200

/** Counts UTF-16 code units (`value.length`) like the native `maxLength`, so the hint matches what the input accepts. */
function titleHint(length: number): string {
    const remaining = TITLE_MAX_LENGTH - length
    if (remaining > 0) return `Noch ${remaining} von ${TITLE_MAX_LENGTH} Zeichen frei`
    if (remaining === 0) return `Höchstlänge von ${TITLE_MAX_LENGTH} Zeichen erreicht`
    return `${-remaining} Zeichen über der Höchstlänge von ${TITLE_MAX_LENGTH}`
}

export function MemoryProposalFields({ title, body, onTitle, onBody, disabled = false, readOnlyBody = false, onSelection }: {
    title: string
    body: string
    onTitle: (value: string) => void
    onBody: (value: string) => void
    disabled?: boolean
    readOnlyBody?: boolean
    onSelection?: (start: number, end: number) => void
}) {
    const id = useId(), titleId = `${id}-title`, hintId = `${id}-title-hint`
    // The hint stays outside the <label> so the input's accessible name remains "Titel"; it is a description read on
    // focus, not a live region, so typing does not announce every keystroke.
    return <>
        <div className="ev-field">
            <label htmlFor={titleId}>Titel</label>
            <input id={titleId} required maxLength={TITLE_MAX_LENGTH} aria-describedby={hintId} value={title} onChange={event => onTitle(event.target.value)} disabled={disabled} />
            <small id={hintId}>{titleHint(title.length)}</small>
        </div>
        <Field label={readOnlyBody ? 'Gespeicherter Nachrichtentext (nur lesen)' : 'Erkenntnis'}><textarea required rows={5} maxLength={50000} value={body} onChange={event => onBody(event.target.value)} onSelect={event => onSelection?.(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} readOnly={readOnlyBody} disabled={disabled} /></Field>
    </>
}
