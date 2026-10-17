/**
 * Small static checkers for repository files. They classify content; they never
 * resolve external entities, evaluate expressions or return raw source.
 */

const NAME_START = String.raw`A-Za-z_:À-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}`
const NAME_CHAR = String.raw`${NAME_START}\-.0-9·̀-ͯ‿-⁀`
const XML_NAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*`, 'u')
/** Characters outside the XML 1.0 Char production (controls, lone surrogates, U+FFFE/FFFF). */
const INVALID_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos'])

function validCodePoint(code: number): boolean {
    return code === 0x9 || code === 0xA || code === 0xD || code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF
}

/**
 * Checks every `&` reference. Without a DTD only predefined and character references are defined;
 * with a DOCTYPE, other names may be declared there and are reported as not checked (never resolved).
 */
function references(value: string, doctype: boolean): 'ok' | 'unchecked' | string {
    let unchecked = false
    for (let index = value.indexOf('&'); index >= 0; index = value.indexOf('&', index + 1)) {
        const end = value.indexOf(';', index)
        const body = end < 0 ? '' : value.slice(index + 1, end)
        if (!body || end - index > 64) return 'Unmaskiertes & (als &amp; schreiben)'
        if (body.startsWith('#')) {
            const code = /^#x[0-9a-fA-F]+$/.test(body) ? Number.parseInt(body.slice(2), 16) : /^#[0-9]+$/.test(body) ? Number.parseInt(body.slice(1), 10) : NaN
            if (!validCodePoint(code)) return `Ungültige Zeichenreferenz &${body.slice(0, 12)};`
        } else if (!XML_NAME.test(body) || XML_NAME.exec(body)![0] !== body) return 'Unmaskiertes & (als &amp; schreiben)'
        else if (!PREDEFINED.has(body)) { if (!doctype) return `Nicht deklarierte Entität &${body.slice(0, 40)};`; unchecked = true }
    }
    return unchecked ? 'unchecked' : 'ok'
}

/**
 * Bounded XML 1.0 well-formedness check: elements, attributes, comments, PIs, CDATA, character and
 * entity references, legal characters. No DTD processing or entity expansion; a document with a
 * DOCTYPE that references non-predefined entities gets `wellFormed: null` (not checkable here).
 * Namespaces and schema validity (e.g. Odoo RNG) are out of scope.
 */
export function inspectXml(text: string): { wellFormed: boolean | null; root: string | null; doctype: boolean; reason?: string } {
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0, root: string | null = null, doctype = false, closedRoot = false, unchecked = false
    const stack: string[] = []
    const fail = (reason: string) => ({ wellFormed: false, root, doctype, reason })
    const name = (from: number) => XML_NAME.exec(text.slice(from, from + 256))?.[0] ?? null
    if (INVALID_CHAR.test(text)) return fail('Unzulässiges Zeichen im Dokument')
    const content = (value: string): string | null => {
        if (value.includes(']]>')) return ']]> außerhalb eines CDATA-Abschnitts'
        const result = references(value, doctype)
        if (result === 'unchecked') { unchecked = true; return null }
        return result === 'ok' ? null : result
    }
    while (index < text.length) {
        const lt = text.indexOf('<', index)
        const chunk = text.slice(index, lt < 0 ? text.length : lt)
        if (!stack.length && chunk.trim() !== '') return fail('Text außerhalb des Wurzelelements')
        if (stack.length) { const problem = content(chunk); if (problem) return fail(problem) }
        if (lt < 0) break
        index = lt
        if (text.startsWith('<?', index)) {
            const end = text.indexOf('?>', index + 2)
            if (end < 0) return fail('Unvollständige Verarbeitungsanweisung')
            const target = name(index + 2)
            if (!target) return fail('Verarbeitungsanweisung ohne Ziel')
            if (target.toLowerCase() === 'xml' && (index !== (text.charCodeAt(0) === 0xfeff ? 1 : 0) || target !== 'xml')) return fail('XML-Deklaration nicht am Dokumentanfang')
            index = end + 2
        } else if (text.startsWith('<!--', index)) {
            const end = text.indexOf('-->', index + 4)
            if (end < 0) return fail('Unvollständiger Kommentar')
            const body = text.slice(index + 4, end)
            if (body.includes('--') || body.endsWith('-')) return fail('„--“ ist in Kommentaren nicht erlaubt')
            index = end + 3
        } else if (text.startsWith('<![CDATA[', index)) {
            if (!stack.length) return fail('CDATA außerhalb des Wurzelelements')
            const end = text.indexOf(']]>', index + 9)
            if (end < 0) return fail('Unvollständiger CDATA-Abschnitt')
            index = end + 3
        } else if (text.startsWith('<!DOCTYPE', index)) {
            if (root || doctype) return fail('DOCTYPE an unzulässiger Stelle')
            doctype = true
            // An internal subset can declare entities; it is reported, never processed.
            let depth = 0, cursor = index + 9, quote = ''
            for (; cursor < text.length; cursor++) {
                const char = text[cursor]
                if (quote) { if (char === quote) quote = ''; continue }
                if (char === '"' || char === "'") quote = char
                else if (char === '[') depth++
                else if (char === ']') depth--
                else if (char === '>' && depth <= 0) break
            }
            if (cursor >= text.length) return fail('Unvollständiges DOCTYPE')
            index = cursor + 1
        } else if (text.startsWith('<!', index)) {
            return fail('Unzulässige Markup-Deklaration')
        } else if (text.startsWith('</', index)) {
            const tag = name(index + 2)
            if (!tag) return fail('Ungültiges End-Tag')
            const end = text.indexOf('>', index + 2 + tag.length)
            if (end < 0 || text.slice(index + 2 + tag.length, end).trim() !== '') return fail('Ungültiges End-Tag')
            if (stack.pop() !== tag) return fail(`End-Tag </${tag.slice(0, 40)}> passt nicht`)
            if (!stack.length) closedRoot = true
            index = end + 1
        } else {
            const tag = name(index + 1)
            if (!tag) return fail('Ungültiges Start-Tag')
            if (closedRoot) return fail('Mehrere Wurzelelemente')
            let cursor = index + 1 + tag.length
            const seen = new Set<string>()
            for (;;) {
                const spaced = /[ \t\r\n]/.test(text[cursor] ?? '')
                while (/[ \t\r\n]/.test(text[cursor] ?? '')) cursor++
                const char = text[cursor]
                if (char === undefined) return fail('Unvollständiges Start-Tag')
                if (char === '>' || text.startsWith('/>', cursor)) break
                const attribute = name(cursor)
                if (!attribute || !spaced) return fail('Ungültiges Attribut')
                if (seen.has(attribute)) return fail('Doppeltes Attribut')
                seen.add(attribute)
                cursor += attribute.length
                while (/[ \t\r\n]/.test(text[cursor] ?? '')) cursor++
                if (text[cursor] !== '=') return fail('Attribut ohne Wert')
                cursor++
                while (/[ \t\r\n]/.test(text[cursor] ?? '')) cursor++
                const quote = text[cursor]
                if (quote !== '"' && quote !== "'") return fail('Attributwert ohne Anführungszeichen')
                const close = text.indexOf(quote, cursor + 1)
                const value = close < 0 ? '' : text.slice(cursor + 1, close)
                if (close < 0 || value.includes('<')) return fail('Ungültiger Attributwert')
                const problem = references(value, doctype)
                if (problem === 'unchecked') unchecked = true
                else if (problem !== 'ok') return fail(problem)
                cursor = close + 1
            }
            if (!root) root = tag
            if (text.startsWith('/>', cursor)) {
                if (!stack.length) closedRoot = true
                index = cursor + 2
            } else {
                stack.push(tag)
                if (stack.length > 256) return fail('XML ist zu tief verschachtelt')
                index = cursor + 1
            }
        }
    }
    if (stack.length) return fail('Nicht geschlossene Elemente')
    if (!root) return fail('Kein Wurzelelement')
    return unchecked ? { wellFormed: null, root, doctype, reason: 'DOCTYPE-Entitäten werden nicht ausgewertet' } : { wellFormed: true, root, doctype }
}

/** Minimal RFC 4180 reader for headers and row counts of security CSV files. */
export function inspectCsv(text: string, maxRows = 100_000): { header: string[]; rows: number; valid: boolean; invalidValues: (column: number, accept: (value: string) => boolean) => boolean } {
    const rows: string[][] = []
    let row: string[] = [], field = '', quoted = false, index = text.charCodeAt(0) === 0xfeff ? 1 : 0
    for (; index < text.length; index++) {
        const char = text[index]
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') { field += '"'; index++ }
            else if (char === '"') quoted = false
            else field += char
            continue
        }
        if (char === '"' && field === '') quoted = true
        else if (char === ',') { row.push(field); field = '' }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') index++
            row.push(field); field = ''
            if (row.some(value => value !== '')) rows.push(row)
            row = []
            if (rows.length > maxRows) break
        } else field += char
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(value => value !== '')) rows.push(row) }
    const header = (rows[0] ?? []).map(value => value.trim())
    return {
        header, rows: Math.max(0, rows.length - 1), valid: !quoted && rows.slice(1).every(values => values.length === header.length),
        /** True when a column exists and any row has a value the predicate rejects; values are never returned. */
        invalidValues: (column: number, accept: (value: string) => boolean) => column >= 0 && rows.slice(1).some(values => !accept((values[column] ?? '').trim())),
    }
}
