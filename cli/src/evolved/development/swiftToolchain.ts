import { lstatSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type SwiftBinary = { ok: true; binary: string; target: string } | { ok: false; reason: 'missing' | 'unsafe' | 'escape' | 'broken' | 'not_executable' }

/**
 * Locates `<version>/usr/bin/swift` of a project-installed toolchain by reading file metadata only.
 * The official Linux tarball ships `usr/bin/swift` as a relative symlink to `swift-driver`; such an
 * internal link is accepted when it resolves to an executable regular file inside the same version
 * tree. Links leaving the tree, broken links and non-executable targets are rejected. Callers must
 * run `binary` (not `target`): swift-driver selects its mode from argv[0].
 */
export function resolveSwiftBinary(versionDirectory: string): SwiftBinary {
    const lstat = (path: string) => { try { return lstatSync(path) } catch { return null } }
    const root = lstat(versionDirectory)
    if (!root) return { ok: false, reason: 'missing' }
    if (root.isSymbolicLink() || !root.isDirectory()) return { ok: false, reason: 'unsafe' }
    for (const directory of ['usr', 'usr/bin']) {
        const info = lstat(join(versionDirectory, directory))
        if (!info) return { ok: false, reason: 'missing' }
        if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, reason: 'unsafe' }
    }
    const binary = join(versionDirectory, 'usr/bin/swift')
    const info = lstat(binary)
    if (!info) return { ok: false, reason: 'missing' }
    if (!info.isFile() && !info.isSymbolicLink()) return { ok: false, reason: 'unsafe' }
    let realRoot: string, target: string
    try { realRoot = realpathSync(versionDirectory); target = realpathSync(binary) } catch { return { ok: false, reason: 'broken' } }
    if (!target.startsWith(`${realRoot}/`)) return { ok: false, reason: 'escape' }
    let resolved
    try { resolved = statSync(target) } catch { return { ok: false, reason: 'broken' } }
    if (!resolved.isFile()) return { ok: false, reason: 'unsafe' }
    if ((resolved.mode & 0o111) === 0) return { ok: false, reason: 'not_executable' }
    return { ok: true, binary, target }
}

export const SWIFT_BINARY_PROBLEM: Record<Exclude<SwiftBinary, { ok: true }>['reason'], string> = {
    missing: 'usr/bin/swift fehlt',
    unsafe: 'usr/bin/swift oder ein Elternordner ist keine reguläre Datei bzw. ein Verzeichnislink',
    escape: 'usr/bin/swift verweist aus dem Versionsordner heraus',
    broken: 'usr/bin/swift ist eine defekte Verknüpfung',
    not_executable: 'das Ziel von usr/bin/swift ist nicht ausführbar',
}
