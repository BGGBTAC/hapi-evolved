import { describe, expect, it } from 'bun:test'
import {
    SESSION_REFERENCE_STEER_SUFFIX,
    buildSessionCitationSteerInstruction,
    extractSessionCitationIds,
    normalizeSessionIdPrefix,
} from './sessionCitation'

const UUID = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'

describe('extractSessionCitationIds', () => {
    it('extracts id from Copy-reference prose (tiann/hapi#1144)', () => {
        const text = `See session "Coding" (/sessions/${UUID}) for context`
        expect(extractSessionCitationIds(text)).toEqual([UUID])
    })

    it('extracts id from Copy-reference prose with steer suffix', () => {
        const text =
            `See session "Coding" (/sessions/${UUID}) for context.${SESSION_REFERENCE_STEER_SUFFIX}`
        expect(extractSessionCitationIds(text)).toEqual([UUID])
    })

    it('extracts id from empty-title Copy-reference form', () => {
        expect(extractSessionCitationIds(`See HAPI session /sessions/${UUID} for context`)).toEqual([
            UUID,
        ])
    })

    it('extracts id from markdown composer chip form', () => {
        expect(extractSessionCitationIds(`[Coding](/sessions/${UUID})`)).toEqual([UUID])
    })

    it('extracts id from bare /sessions/<id>', () => {
        expect(extractSessionCitationIds(`please read /sessions/${UUID}`)).toEqual([UUID])
    })

    it('strips trailing prose punctuation from bare citations', () => {
        expect(extractSessionCitationIds(`see /sessions/${UUID}.`)).toEqual([UUID])
        expect(extractSessionCitationIds(`see /sessions/${UUID}, then continue`)).toEqual([UUID])
    })

    it('rejects dotted tails that look like source paths', () => {
        expect(extractSessionCitationIds('see web/src/routes/sessions/chat.tsx')).toEqual([])
        expect(extractSessionCitationIds('/sessions/chat.tsx')).toEqual([])
    })

    it('dedupes while preserving first-seen order', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const text = `[A](/sessions/${UUID}) and See session "B" (/sessions/${other}) then /sessions/${UUID}`
        expect(extractSessionCitationIds(text)).toEqual([UUID, other])
    })

    it('accepts BASE_URL-prefixed session paths', () => {
        expect(extractSessionCitationIds(`(/hapi/sessions/${UUID})`)).toEqual([UUID])
    })
})

describe('normalizeSessionIdPrefix', () => {
    it('returns a bare prefix unchanged', () => {
        expect(normalizeSessionIdPrefix('7ee03698')).toBe('7ee03698')
        expect(normalizeSessionIdPrefix(`  ${UUID}  `)).toBe(UUID)
    })

    it('pulls the id out of a pasted Copy-reference blob', () => {
        expect(
            normalizeSessionIdPrefix(`See session "Coding" (/sessions/${UUID}) for context`)
        ).toBe(UUID)
    })

    it('prefers the parenthesized Copy-reference path over /sessions/ inside the title', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const text =
            `See session ${JSON.stringify(`Review /sessions/${other}`)} (/sessions/${UUID}) for context.${SESSION_REFERENCE_STEER_SUFFIX}`
        expect(normalizeSessionIdPrefix(text)).toBe(UUID)
    })

    it('pulls the id out of a markdown citation', () => {
        expect(normalizeSessionIdPrefix(`[Coding](/sessions/${UUID})`)).toBe(UUID)
    })

    it('fails closed on ambiguous multi-citation blobs', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(
            normalizeSessionIdPrefix(
                `[A](/sessions/${UUID}) and See session "B" (/sessions/${other}) for context`
            )
        ).toBe('')
    })

    it('fails closed when a Copy-reference is followed by a second citation', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(
            normalizeSessionIdPrefix(
                `See session "A" (/sessions/${UUID}) for context and [B](/sessions/${other})`
            )
        ).toBe('')
    })
})

/** The former production regex; quadratic, so only used as the semantic reference. */
const SESSION_PATH_IN_TEXT_RE =
    /(?:^|[^A-Za-z0-9_-])(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#\s)\]"']+)/g

describe('extractSessionCitationIds linear scanner', () => {
    /** The original global-regex extraction, kept as the semantic reference. */
    function referenceIds(text: string): string[] {
        const re = new RegExp(SESSION_PATH_IN_TEXT_RE.source, 'g')
        const seen = new Set<string>()
        const ids: string[] = []
        let match: RegExpExecArray | null
        while ((match = re.exec(text)) !== null) {
            let id: string
            try { id = decodeURIComponent(match[1] ?? '').replace(/[.,;:!?]+$/u, '') } catch { continue }
            if (!id || id.includes('.') || seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
        return ids
    }

    it('matches the regex semantics on tricky citations', () => {
        const cases = [
            'x/sessions/a/sessions/b',
            '/a.sessions/x/sessions/y',
            'see /sessions/abc, and ./base/sessions/def!',
            'mysessions/nope a.sessions/yes //sessions/z ./sessions/w',
            '/sessions/sessions/abc',
            'web/src/routes/sessions/chat.tsx',
            '[t](/sessions/%41b) (/sessions/c?x=1) "/sessions/d"',
            'sessions/first then sessions/ empty',
        ]
        for (const text of cases) expect(extractSessionCitationIds(text)).toEqual(referenceIds(text))
    })

    it('agrees with the regex on random malformed paths', () => {
        const parts = ['sessions/', '/sessions/', 's', '/', '.', '-', 'a', '_', ' ', ',', ')', '?', '#', '"', '%41', '%', '!', './', '//']
        let seed = 1
        const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
        for (let iteration = 0; iteration < 5000; iteration += 1) {
            let text = ''
            const length = 1 + Math.floor(next() * 24)
            for (let index = 0; index < length; index += 1) text += parts[Math.floor(next() * parts.length)]
            expect(extractSessionCitationIds(text)).toEqual(referenceIds(text))
        }
    })

    it('stays linear on long dotted, slashed and punctuated input', () => {
        const inputs = [
            ',' + '.-'.repeat(100_000),
            'a/'.repeat(100_000),
            '/sessions/' + '.'.repeat(200_000) + 'x',
        ]
        for (const text of inputs) {
            const startedAt = performance.now()
            extractSessionCitationIds(text)
            expect(performance.now() - startedAt).toBeLessThan(500)
        }
        expect(normalizeSessionIdPrefix('a/'.repeat(100_000) + 'sessions/abc')).toBe('abc')
    })
})

describe('buildSessionCitationSteerInstruction', () => {
    it('mentions both citation forms and forbids local FS search', () => {
        const text = buildSessionCitationSteerInstruction({
            inspectTool: 'mcp__hapi__inspect_peer',
            pingTool: 'mcp__hapi__ping_peer',
            listPeersTool: 'mcp__hapi__list_peers',
        })
        expect(text).toContain('[title](/sessions/<id>)')
        expect(text).toContain('See session')
        expect(text).toContain('/sessions/<id>')
        expect(text).toContain('mcp__hapi__inspect_peer')
        expect(text).toContain('mcp__hapi__ping_peer')
        expect(text).toContain('mcp__hapi__list_peers')
        expect(text.toLowerCase()).toMatch(/not.*(grep|glob|filesystem|local file)/i)
    })

    it('mentions search_peers when provided', () => {
        const text = buildSessionCitationSteerInstruction({
            inspectTool: 'mcp__hapi__inspect_peer',
            pingTool: 'mcp__hapi__ping_peer',
            listPeersTool: 'mcp__hapi__list_peers',
            searchPeersTool: 'mcp__hapi__search_peers',
        })
        expect(text).toContain('mcp__hapi__search_peers')
        expect(text).toContain('hapi search-peers')
    })
})
