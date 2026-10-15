/**
 * Shared, conservative source policy for repository views and memory proposals.
 * These patterns detect common credential formats; they are not a guarantee that
 * arbitrary secrets can be recognized. Callers must also enforce authority,
 * filesystem identity, content-size limits and safe text rendering.
 */

const unsafeCharacters = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\uD800-\uDFFF]/u
const utf8 = new TextEncoder()

/** A canonical relative POSIX path; never normalize an untrusted path into access. */
export function isSafeSourcePath(path: string): boolean {
    if (!path || path.length > 4096 || path.startsWith('/') || path.includes('\\')
        || /^[A-Za-z]:/.test(path) || unsafeCharacters.test(path)
        || utf8.encode(path).byteLength > 4096) return false
    return path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
        && utf8.encode(part).byteLength <= 255)
}

/** Excluded paths may be named in a listing, but their contents must not be returned. */
export function excludedSourcePath(path: string): boolean {
    if (!isSafeSourcePath(path)) return true
    return path.normalize('NFC').split('/').some(part => {
        if (/^(?:\.env.*|\.ssh|\.aws|\.gnupg|\.git|\.codegraph.*|node_modules)$/i.test(part)) return true
        if (/^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.docker|\.kube)(?:\..*)?$/i.test(part)) return true
        if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|kubeconfig)/i.test(part)) return true
        if (/(?:secret|credential|vault|sops)/i.test(part)) return true
        return /\.(?:pem|p12|pfx|key|keystore|jks|kdbx|age|asc|gpg|tfstate|tfvars|sqlite|db|env|enc)(?:\..*)?$/i.test(part)
    })
}

/** Return only a classification; callers must never include a match in an error. */
export function containsCredential(text: string): boolean {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
        || /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\b["']?\s*[:=]\s*["']?[^\s"'${}]{12,}/i.test(text)
}
