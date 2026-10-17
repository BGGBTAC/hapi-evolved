/**
 * Strict parser for the Python literal subset accepted by `ast.literal_eval`
 * (Odoo loads `__manifest__.py` the same way). It never evaluates, imports or
 * executes anything: names other than True/False/None, calls, operators except
 * unary +/- on numbers, comprehensions, f-strings and attribute access are
 * rejected. Input size and nesting are bounded by the caller and here.
 */

export type PythonLiteral = string | number | boolean | null | PythonLiteral[] | { readonly kind: 'tuple'; items: PythonLiteral[] } | PythonDict
export type PythonDict = { readonly kind: 'dict'; entries: Array<[PythonLiteral, PythonLiteral]> }

export class PythonLiteralError extends Error {
    constructor(message: string, readonly offset: number) { super(message); this.name = 'PythonLiteralError' }
}

const MAX_DEPTH = 32
const MAX_ITEMS = 20_000

export function isDict(value: PythonLiteral): value is PythonDict {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'dict'
}
export function isTuple(value: PythonLiteral): value is { kind: 'tuple'; items: PythonLiteral[] } {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'tuple'
}
/** Lists and tuples are both sequences in manifests. */
export function sequence(value: PythonLiteral | undefined): PythonLiteral[] | null {
    if (Array.isArray(value)) return value
    if (value !== undefined && isTuple(value)) return value.items
    return null
}

export function parsePythonLiteral(source: string): PythonLiteral {
    const parser = new Parser(source)
    const value = parser.expression(0)
    parser.skipTrivia(true)
    if (!parser.done()) parser.fail('Unexpected content after the literal')
    return value
}

class Parser {
    private index = 0
    private items = 0
    /** Bracket depth: inside brackets newlines are insignificant, as in Python. */
    private brackets = 0
    constructor(private readonly text: string) {
        if (text.charCodeAt(0) === 0xfeff) this.index = 1
    }
    done() { return this.index >= this.text.length }
    fail(message: string): never { throw new PythonLiteralError(message, this.index) }

    skipTrivia(allowNewlines = this.brackets > 0) {
        while (this.index < this.text.length) {
            const char = this.text[this.index]
            if (char === ' ' || char === '\t' || char === '\f') { this.index++; continue }
            if (char === '\\' && (this.text[this.index + 1] === '\n' || this.text.startsWith('\r\n', this.index + 1))) {
                this.index += this.text[this.index + 1] === '\n' ? 2 : 3
                continue
            }
            if ((char === '\n' || char === '\r') && allowNewlines) { this.index++; continue }
            if (char === '#') {
                while (this.index < this.text.length && this.text[this.index] !== '\n' && this.text[this.index] !== '\r') this.index++
                continue
            }
            return
        }
    }

    private count() { if (++this.items > MAX_ITEMS) this.fail('Literal has too many elements') }

    expression(depth: number): PythonLiteral {
        if (depth > MAX_DEPTH) this.fail('Literal is nested too deeply')
        this.skipTrivia(depth === 0 ? true : undefined)
        const char = this.text[this.index]
        if (char === undefined) this.fail('Unexpected end of input')
        if (char === '{') return this.braces(depth)
        if (char === '[') return this.list(depth)
        if (char === '(') return this.parenthesized(depth)
        if (char === '+' || char === '-') {
            this.index++
            this.skipTrivia()
            const value = this.number()
            return char === '-' ? -value : value
        }
        if (/[0-9.]/.test(char) && /[0-9]/.test(this.text[this.index + (char === '.' ? 1 : 0)] ?? '')) return this.number()
        if (this.stringStart()) return this.strings()
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index, this.index + 64))?.[0]
        if (name === 'True' || name === 'False' || name === 'None') {
            this.index += name.length
            return name === 'True' ? true : name === 'False' ? false : null
        }
        // Never echo source text (names may be anything); report the class of problem only.
        this.fail(name ? 'Names, calls and expressions are not literals' : 'Unsupported syntax')
    }

    /** Python 3 numeric literal grammar (PEP 515 underscores, no leading zeros, no imaginary). */
    private number(): number {
        const rest = this.text.slice(this.index, this.index + 400)
        const digits = '[0-9](?:_?[0-9])*'
        const exponent = `[eE][+-]?${digits}`
        const grammar = new RegExp(`^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+`
            + `|(?:${digits})?\\.${digits}(?:${exponent})?|${digits}\\.(?:${exponent})?|${digits}${exponent}`
            + `|[1-9](?:_?[0-9])*|0(?:_?0)*)`)
        const raw = grammar.exec(rest)?.[0] ?? ''
        if (!raw) this.fail('Unsupported number')
        // A following digit, letter, underscore or dot means the literal is malformed (e.g. 01, 1__2, 1_, 1j).
        if (/^[0-9A-Za-z_.]/.test(rest.slice(raw.length))) this.fail('Unsupported number')
        this.index += raw.length
        const clean = raw.replace(/_/g, '')
        const value = /^0[xX]/.test(clean) ? Number.parseInt(clean.slice(2), 16)
            : /^0[oO]/.test(clean) ? Number.parseInt(clean.slice(2), 8)
            : /^0[bB]/.test(clean) ? Number.parseInt(clean.slice(2), 2)
            : Number(clean)
        if (!Number.isFinite(value)) this.fail('Unsupported number')
        return value
    }

    private stringStart(): boolean {
        const prefix = /^(?:[rRuU]|[bB][rR]?|[rR][bB])?(['"])/.exec(this.text.slice(this.index, this.index + 4))
        return !!prefix
    }

    /** Adjacent string literals concatenate (implicit concatenation is valid in literal_eval). */
    private strings(): string {
        let value = '', kind: 'str' | 'bytes' | undefined
        do {
            const literal = this.string()
            if (kind && kind !== literal.kind) this.fail('Cannot mix bytes and str literals')
            kind = literal.kind
            value += literal.value
            if (value.length > 1_000_000) this.fail('String literal too long')
            this.skipTrivia()
        } while (this.index < this.text.length && this.stringStart())
        if (kind === 'bytes') this.fail('Bytes literals are not supported in manifests')
        return value
    }

    private string(): { value: string; kind: 'str' | 'bytes' } {
        const prefix = /^(?:[rRuU]|[bB][rR]?|[rR][bB])?/.exec(this.text.slice(this.index, this.index + 2))![0]
        const raw = /[rR]/.test(prefix), bytes = /[bB]/.test(prefix)
        this.index += prefix.length
        const quote = this.text[this.index]
        const triple = this.text.startsWith(quote.repeat(3), this.index)
        this.index += triple ? 3 : 1
        let value = ''
        for (;;) {
            if (this.index >= this.text.length) this.fail('Unterminated string literal')
            const char = this.text[this.index]
            if (triple ? this.text.startsWith(quote.repeat(3), this.index) : char === quote) {
                this.index += triple ? 3 : 1
                return { value, kind: bytes ? 'bytes' : 'str' }
            }
            if (!triple && (char === '\n' || char === '\r')) this.fail('Unterminated string literal')
            if (char === '\\') {
                const next = this.text[this.index + 1]
                if (next === undefined) this.fail('Unterminated string literal')
                if (raw) { value += char + next; this.index += 2; continue }
                this.index += 2
                value += this.escape(next)
                continue
            }
            value += char
            this.index++
        }
    }

    private escape(next: string): string {
        const simple: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\n': '' }
        if (Object.hasOwn(simple, next)) return simple[next]
        if (next === '\r') { if (this.text[this.index] === '\n') this.index++; return '' }
        const hex = (length: number) => {
            const digits = this.text.slice(this.index, this.index + length)
            if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) this.fail('Invalid escape sequence')
            this.index += length
            const code = Number.parseInt(digits, 16)
            if (code > 0x10ffff) this.fail('Invalid escape sequence')
            return String.fromCodePoint(code)
        }
        if (next === 'x') return hex(2)
        if (next === 'u') return hex(4)
        if (next === 'U') return hex(8)
        if (/[0-7]/.test(next)) {
            let digits = next
            while (digits.length < 3 && /[0-7]/.test(this.text[this.index] ?? '')) digits += this.text[this.index++]
            return String.fromCharCode(Number.parseInt(digits, 8))
        }
        if (next === 'N') this.fail('Named unicode escapes are not supported')
        // Python keeps unknown escapes verbatim (with a warning).
        return `\\${next}`
    }

    private open() { this.index++; this.brackets++ }
    private close() { this.index++; this.brackets-- }

    private list(depth: number): PythonLiteral[] {
        this.open()
        const items = this.elements(']', depth)
        this.close()
        return items
    }

    private parenthesized(depth: number): PythonLiteral {
        this.open()
        this.skipTrivia()
        if (this.text[this.index] === ')') { this.close(); return { kind: 'tuple', items: [] } }
        const first = this.expression(depth + 1)
        this.skipTrivia()
        if (this.text[this.index] === ')') { this.close(); return first }
        if (this.text[this.index] !== ',') this.fail('Expected , or )')
        this.index++
        const rest = this.elements(')', depth)
        this.close()
        return { kind: 'tuple', items: [first, ...rest] }
    }

    private elements(end: string, depth: number): PythonLiteral[] {
        const items: PythonLiteral[] = []
        for (;;) {
            this.skipTrivia()
            if (this.text[this.index] === end) return items
            items.push(this.expression(depth + 1))
            this.count()
            this.skipTrivia()
            if (this.text[this.index] === ',') { this.index++; continue }
            if (this.text[this.index] !== end) this.fail(`Expected , or ${end}`)
        }
    }

    private braces(depth: number): PythonLiteral {
        this.open()
        this.skipTrivia()
        if (this.text[this.index] === '}') { this.close(); return { kind: 'dict', entries: [] } }
        const first = this.expression(depth + 1)
        this.skipTrivia()
        if (this.text[this.index] !== ':') {
            // Non-empty set literal: valid for literal_eval, never meaningful in manifests.
            this.fail('Set literals are not supported in manifests')
        }
        const entries: Array<[PythonLiteral, PythonLiteral]> = []
        let key = first
        for (;;) {
            this.index++ // ':'
            const value = this.expression(depth + 1)
            this.count()
            if (typeof key === 'object' && key !== null) this.fail('Unhashable dictionary key')
            entries.push([key, value])
            this.skipTrivia()
            if (this.text[this.index] === ',') {
                this.index++
                this.skipTrivia()
                if (this.text[this.index] === '}') break
                key = this.expression(depth + 1)
                this.skipTrivia()
                if (this.text[this.index] !== ':') this.fail('Expected :')
                continue
            }
            if (this.text[this.index] === '}') break
            this.fail('Expected , or }')
        }
        this.close()
        return { kind: 'dict', entries }
    }
}

/** Python dict semantics: the last duplicate key wins. Only string keys are looked up. */
export function dictGet(dict: PythonDict, key: string): PythonLiteral | undefined {
    for (let index = dict.entries.length - 1; index >= 0; index--) if (dict.entries[index][0] === key) return dict.entries[index][1]
    return undefined
}
