import { z } from 'zod'

export const GithubPrExternalRefSchema = z.object({
    kind: z.literal('github_pr'),
    repo: z.string().max(140).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    url: z.string().max(300),
    role: z.enum(['primary', 'secondary']),
    source: z.enum(['agent', 'user', 'inferred']).optional(),
    linkedAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((ref, ctx) => {
    if (ref.url !== `https://github.com/${ref.repo}/pull/${ref.number}`) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: 'Canonical GitHub PR URL must match repo and number.' })
    }
})
export type GithubPrExternalRef = z.infer<typeof GithubPrExternalRefSchema>
export const ExternalRefsSchema = z.array(GithubPrExternalRefSchema).max(32).superRefine((refs, ctx) => {
    if (refs.filter(ref => ref.role === 'primary').length > 1) ctx.addIssue({ code: 'custom', message: 'At most one primary PR is allowed.' })
    const keys = refs.map(ref => `${ref.repo.toLowerCase()}#${ref.number}`)
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate PR identity.' })
})
export type ExternalRef = GithubPrExternalRef

/** Pure shape validation. Never contacts GitHub or infers identity from titles. */
export function parseGithubPrInput(input: string): GithubPrExternalRef | null {
    if (input.length > 300) return null
    const value = input.trim()
    const shorthand = /^([^\s]+)\s*#([1-9]\d*)$/.exec(value)
    let repo: string, number: number
    if (shorthand) { repo = shorthand[1]!; number = Number(shorthand[2]) }
    else {
        let url: URL
        try { url = new URL(value) } catch { return null }
        if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null
        const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
        if (!match) return null
        repo = match[1]!; number = Number(match[2])
    }
    const parsed = GithubPrExternalRefSchema.safeParse({ kind: 'github_pr', repo, number,
        url: `https://github.com/${repo}/pull/${number}`, role: 'primary' })
    return parsed.success ? parsed.data : null
}

export function getPrimaryGithubPrRef(refs?: readonly ExternalRef[] | null): GithubPrExternalRef | null {
    return refs?.find(ref => ref.role === 'primary') ?? null
}

/** An agent may update its own primary link, but never discard a human choice. */
export function agentLinkedRefs(existing: readonly ExternalRef[], incoming: ExternalRef): ExternalRef[] {
    const primary = getPrimaryGithubPrRef(existing)
    const same = (ref: ExternalRef) => ref.repo.toLowerCase() === incoming.repo.toLowerCase() && ref.number === incoming.number
    if (primary?.source === 'user') {
        if (same(primary)) return [...existing]
        throw new Error('A person linked the primary PR. Unlink it in the browser before replacing it.')
    }
    const refs = [{ ...incoming, role: 'primary' as const, source: 'agent' as const }, ...existing.filter(ref => ref.role === 'secondary' && !same(ref))]
    return ExternalRefsSchema.parse(refs)
}

export function withoutExternalRefs<T>(metadata: T): T {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata
    const copy = { ...metadata } as T & { externalRefs?: unknown }
    delete copy.externalRefs
    return copy
}
