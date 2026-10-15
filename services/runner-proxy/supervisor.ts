import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'

type Authority = { projectId: string; profile: string; rootPath: string; expiresAt: number }
export function validateAuthority(value: unknown, expected: { projectId: string; profile: string; rootPath: string }, now = Date.now()): value is Authority {
    if (!value || typeof value !== 'object') return false
    const actual = value as Authority
    return actual.projectId === expected.projectId && actual.profile === expected.profile && actual.rootPath === expected.rootPath
        && typeof actual.expiresAt === 'number' && Number.isFinite(actual.expiresAt) && actual.expiresAt > now
        && ['restricted', 'workspace', 'extended'].includes(actual.profile)
}
export function workspaceReadOnly(root: string, mountinfo: string): boolean {
    const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    const mounts = mountinfo.trim().split('\n').map(line => line.split(' '))
        .filter(fields => fields.length > 6 && (root === decode(fields[4]) || root.startsWith(decode(fields[4]).replace(/\/$/, '') + '/')))
        .sort((a, b) => b[4].length - a[4].length)
    return mounts.length > 0 && mounts[0][5].split(',').includes('ro')
}
export function droppedPrivileges(status: string, uid: number, gid: number): boolean {
    const fields = new Map(status.split('\n').map(line => { const offset = line.indexOf(':'); return [line.slice(0, offset), line.slice(offset + 1).trim()] }))
    return fields.get('Uid')?.split(/\s+/).every(value => Number(value) === uid) === true
        && fields.get('Gid')?.split(/\s+/).every(value => Number(value) === gid) === true
        && fields.get('Groups') === ''
        && ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every(name => /^0+$/.test(fields.get(name) ?? ''))
}
async function main() {
    if (process.pid !== 1 || process.getuid?.() !== 0) throw new Error('Runner supervisor must be the container root PID 1')
    const expected = { projectId: process.env.EVOLVED_PROJECT_ID ?? '', profile: process.env.EVOLVED_RUNNER_PROFILE ?? '', rootPath: realpathSync(process.env.EVOLVED_RUNNER_ROOT ?? '/invalid') }
    const uid = Number(process.env.EVOLVED_RUNNER_UID), gid = Number(process.env.EVOLVED_RUNNER_GID)
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) throw new Error('Unprivileged runner UID/GID required')
    if (expected.profile === 'restricted' && !workspaceReadOnly(expected.rootPath, readFileSync('/proc/self/mountinfo', 'utf8'))) throw new Error('Restricted runner requires a read-only workspace mount')
    const check = async () => {
        const response = await fetch('http://runner-proxy:3010/evolved-runner-authority', { redirect: 'error', signal: AbortSignal.timeout(2000) })
        if (!response.ok || !validateAuthority(await response.json(), expected)) throw new Error('Runner authorization missing, expired or changed')
    }
    await check()
    // Explicit Linux privilege dropping does not depend on Bun's spawn uid/gid.
    // The unprivileged subreaper collects orphaned agent descendants.
    const child = spawn('/usr/bin/setpriv', ['--reuid', String(uid), '--regid', String(gid), '--clear-groups',
        '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
        '/usr/bin/tini', '-s', '--', 'bun', '/app/cli/src/index.ts', 'runner', 'start-sync', '--workspace-root', expected.rootPath], {
        stdio: 'inherit', env: { ...process.env, HAPI_RUNNER_SUPERVISED: '1', USER: 'runner', HOME: '/runner' }
    })
    child.on('error', error => { console.error('Runner process could not start:', (error as NodeJS.ErrnoException).code ?? 'unknown'); process.exit(1) })
    child.on('exit', code => process.exit(code ?? 1))
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0))
    let dropped = false
    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (child.pid && droppedPrivileges(readFileSync(`/proc/${child.pid}/status`, 'utf8'), uid, gid)) { dropped = true; break }
    }
    if (!dropped) throw new Error('Runner privileges were not dropped')
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        try { await check() } catch { console.error('Runner authorization lost; stopping container and all agent processes'); process.exit(1) }
    }
}
if (import.meta.main) void main().catch(() => { console.error('Runner startup refused: check lease, profile and workspace mount'); process.exit(1) })
