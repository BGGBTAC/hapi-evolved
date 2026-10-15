import { lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Claude can relocate a known native transcript when entering a worktree. Never discover unrelated IDs. */
export async function findClaudeSessionFile(projectDir: string, sessionId: string): Promise<string> {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error('Invalid Claude transcript ID')
    const preferred = join(projectDir, `${sessionId}.jsonl`)
    const projects = dirname(projectDir)
    const candidates = new Set([preferred])
    try {
        const directories = await readdir(projects, { withFileTypes: true })
        for (const directory of directories.slice(0, 4096)) {
            if (directory.isDirectory() && !directory.isSymbolicLink()) candidates.add(join(projects, directory.name, `${sessionId}.jsonl`))
        }
    } catch { return preferred }
    let newest = preferred
    let timestamp = -1
    for (const candidate of candidates) {
        try {
            const info = await lstat(candidate)
            if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs > timestamp) {
                newest = candidate
                timestamp = info.mtimeMs
            }
        } catch { /* A transcript can move while directories are enumerated. */ }
    }
    return newest
}
