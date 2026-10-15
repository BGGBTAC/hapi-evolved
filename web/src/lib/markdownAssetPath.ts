/** Resolve an embedded file against its document, never above the session workspace. */
export function resolveMarkdownAssetPath(documentPath: string, reference: string, rootPath: string): string | null {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\|#)/i.test(reference)) return null
    let decoded: string
    try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]!) } catch { return null }
    if (!decoded || /[\0\r\n]/.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(decoded)) return null
    const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
    const doc = documentPath.replace(/\\/g, '/')
    const base = doc.startsWith('/') || /^[A-Za-z]:\//.test(doc) ? doc : `${root}/${doc}`
    const parts: string[] = []
    for (const part of (decoded.startsWith('/') ? [''] : base.split('/').slice(0, -1))) {
        if (part === '..') parts.pop()
        else if (part !== '.') parts.push(part)
    }
    for (const part of decoded.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue
        if (part === '..') parts.pop()
        else parts.push(part)
    }
    const resolved = parts.join('/')
    return resolved.startsWith(`${root}/`) ? resolved : null
}
