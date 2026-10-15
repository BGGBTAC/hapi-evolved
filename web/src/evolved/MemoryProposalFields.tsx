import { Field } from './ui'

export function MemoryProposalFields({ title, body, onTitle, onBody, disabled = false, readOnlyBody = false, onSelection }: {
    title: string
    body: string
    onTitle: (value: string) => void
    onBody: (value: string) => void
    disabled?: boolean
    readOnlyBody?: boolean
    onSelection?: (start: number, end: number) => void
}) {
    return <>
        <Field label="Titel"><input required maxLength={200} value={title} onChange={event => onTitle(event.target.value)} disabled={disabled} /></Field>
        <Field label={readOnlyBody ? 'Gespeicherter Nachrichtentext (nur lesen)' : 'Erkenntnis'}><textarea required rows={5} maxLength={50000} value={body} onChange={event => onBody(event.target.value)} onSelect={event => onSelection?.(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} readOnly={readOnlyBody} disabled={disabled} /></Field>
    </>
}
