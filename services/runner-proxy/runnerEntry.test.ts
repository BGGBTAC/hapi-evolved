import { afterEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireRunnerHome, currentRunnerNamespace, parseInitStartTime } from './runnerEntry'
import type { RunnerNamespace } from './runnerEntry'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const previous: RunnerNamespace = { version: 2, bootId: '11111111-1111-4111-8111-111111111111', pidNamespace: '4:100', initStartTime: '1000' }
const next: RunnerNamespace = { ...previous, pidNamespace: '4:101' }
function fixture(marker: RunnerNamespace | { version: 1; bootId: string; pidNamespace: string } | null = previous) {
    const home = mkdtempSync(join(tmpdir(), 'hapi-runner-namespace-')); directories.push(home)
    const state = join(home, 'hapi'); mkdirSync(state, { mode: 0o700 })
    if (marker) writeFileSync(join(state, '.runner-namespace.json'), JSON.stringify(marker), { mode: 0o600 })
    writeFileSync(join(state, 'runner.state.json'), JSON.stringify({ pid: process.pid, machineId: 'synthetic' }))
    writeFileSync(join(state, 'runner.state.json.lock'), String(process.pid))
    for (const name of ['settings.json', 'runner.state.json.resume-processes.json', 'runner.state.json.verified-exits.json']) writeFileSync(join(state, name), 'preserve-synthetic-record')
    return { home, state }
}
test('new PID namespace or Linux boot resets only the two stale transient files', () => {
    for (const scope of [next, { ...previous, bootId: '22222222-2222-4222-8222-222222222222' }]) {
        const { home, state } = fixture(), guard = acquireRunnerHome(home)
        try {
            expect(guard.prepare(scope, false)).toEqual({ reset: true })
            expect(() => lstatSync(join(state, 'runner.state.json'))).toThrow()
            expect(() => lstatSync(join(state, 'runner.state.json.lock'))).toThrow()
            for (const name of ['settings.json', 'runner.state.json.resume-processes.json', 'runner.state.json.verified-exits.json']) expect(readFileSync(join(state, name), 'utf8')).toBe('preserve-synthetic-record')
            expect(JSON.parse(readFileSync(join(state, '.runner-namespace.json'), 'utf8'))).toEqual(scope)
        } finally { guard.close() }
    }
})
test('same namespace preserves live PID-only lock; missing legacy marker needs verified entry', () => {
    const current = fixture(), currentGuard = acquireRunnerHome(current.home)
    try {
        expect(currentGuard.prepare(previous, false)).toEqual({ reset: false })
        expect(readFileSync(join(current.state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
    } finally { currentGuard.close() }
    const legacy = fixture(null), guard = acquireRunnerHome(legacy.home)
    try {
        expect(() => guard.prepare(next, false)).toThrow('Legacy')
        expect(readFileSync(join(legacy.state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
        expect(guard.prepare(next, true)).toEqual({ reset: true })
    } finally { guard.close() }
})
test('kernel lock excludes a second owner; release keeps its inode and cannot unlink a replacement', () => {
    const { home, state } = fixture(), first = acquireRunnerHome(home)
    const before = lstatSync(join(home, '.supervisor.lock'))
    try {
        expect(() => acquireRunnerHome(home)).toThrow('already supervised')
        expect(readFileSync(join(state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
    } finally { first.close() }
    expect(lstatSync(join(home, '.supervisor.lock')).ino).toBe(before.ino)
    const second = acquireRunnerHome(home)
    renameSync(join(home, '.supervisor.lock'), join(home, 'old-lock'))
    writeFileSync(join(home, '.supervisor.lock'), 'replacement', { mode: 0o600 })
    expect(() => second.prepare(next, true)).toThrow('changed')
    second.close(); second.close()
    expect(readFileSync(join(home, '.supervisor.lock'), 'utf8')).toBe('replacement')
})
test('symlink, corrupt marker and unsafe directory fail before any transient deletion', () => {
    for (const target of ['runner.state.json.lock', '.runner-namespace.json']) {
        const { home, state } = fixture(), guard = acquireRunnerHome(home)
        rmSync(join(state, target)); symlinkSync(join(state, 'settings.json'), join(state, target))
        try { expect(() => guard.prepare(next, true)).toThrow('Unsafe'); expect(readFileSync(join(state, 'runner.state.json'), 'utf8')).toContain('synthetic') }
        finally { guard.close() }
    }
    const { home, state } = fixture(), guard = acquireRunnerHome(home)
    writeFileSync(join(state, '.runner-namespace.json'), '{invalid')
    try { expect(() => guard.prepare(next, true)).toThrow(); expect(readFileSync(join(state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid)) }
    finally { guard.close() }
    chmodSync(home, 0o755)
    expect(() => acquireRunnerHome(home)).toThrow('private directory')
})
test('Linux identity includes boot and actual PID namespace without ps', () => {
    const identity = currentRunnerNamespace()
    expect(identity.bootId).toMatch(/^[0-9a-f-]{36}$/)
    expect(identity.pidNamespace).toMatch(/^\d+:\d+$/)
    expect(identity.version).toBe(2)
    expect(identity.initStartTime).toMatch(/^\d+$/)
    expect(identity.initStartTime).toBe(parseInitStartTime(readFileSync('/proc/1/stat', 'utf8')))
})
test('native child does not inherit the supervisor kernel-lock descriptor', () => {
    const { home } = fixture(), guard = acquireRunnerHome(home)
    try {
        const info = lstatSync(join(home, '.supervisor.lock'))
        const script = `const fs=require('node:fs');let inherited=false;for(const name of fs.readdirSync('/proc/self/fd')){try{const s=fs.statSync('/proc/self/fd/'+name);if(s.ino===${info.ino}&&s.dev===${info.dev})inherited=true}catch{}}process.exit(inherited?1:0)`
        const child = spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 })
        expect(child.status).toBe(0)
    } finally { guard.close() }
})
test('real owner-process death releases the kernel lock without deleting any file', async () => {
    const { home } = fixture()
    const script = `import {acquireRunnerHome} from ${JSON.stringify(join(import.meta.dir, 'runnerEntry.ts'))}; const guard=acquireRunnerHome(${JSON.stringify(home)}); console.log('ready'); setInterval(()=>{},1000);`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    try {
        const reader = child.stdout.getReader()
        const output = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('owner startup timeout')), 5000))])
        expect(new TextDecoder().decode(output.value)).toContain('ready')
        reader.releaseLock()
        expect(() => acquireRunnerHome(home)).toThrow('already supervised')
    } finally { child.kill('SIGKILL'); await child.exited }
    const inode = lstatSync(join(home, '.supervisor.lock')).ino, guard = acquireRunnerHome(home)
    guard.close()
    expect(lstatSync(join(home, '.supervisor.lock')).ino).toBe(inode)
}, 10_000)

test('recycled namespace inode with a different PID1 start time resets stale PID files', () => {
    const { home, state } = fixture(), guard = acquireRunnerHome(home)
    const restarted = { ...previous, initStartTime: '1001' }
    try {
        expect(guard.prepare(restarted, false)).toEqual({ reset: true })
        expect(() => lstatSync(join(state, 'runner.state.json'))).toThrow()
        expect(() => lstatSync(join(state, 'runner.state.json.lock'))).toThrow()
        expect(readFileSync(join(state, 'settings.json'), 'utf8')).toBe('preserve-synthetic-record')
        expect(JSON.parse(readFileSync(join(state, '.runner-namespace.json'), 'utf8'))).toEqual(restarted)
        // A second entry in the exact same generation must not erase a live lock.
        writeFileSync(join(state, 'runner.state.json.lock'), String(process.pid))
        expect(guard.prepare(restarted, false)).toEqual({ reset: false })
        expect(readFileSync(join(state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
    } finally { guard.close() }
})

test('old v1 marker migrates only through verified supervised entry even when its inode matches', () => {
    const { home, state } = fixture({ version: 1, bootId: previous.bootId, pidNamespace: previous.pidNamespace })
    const guard = acquireRunnerHome(home)
    try {
        expect(() => guard.prepare(previous, false)).toThrow('Legacy')
        expect(readFileSync(join(state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
        expect(guard.prepare(previous, true)).toEqual({ reset: true })
        expect(() => lstatSync(join(state, 'runner.state.json.lock'))).toThrow()
        expect(JSON.parse(readFileSync(join(state, '.runner-namespace.json'), 'utf8'))).toEqual(previous)
        for (const name of ['settings.json', 'runner.state.json.resume-processes.json', 'runner.state.json.verified-exits.json']) expect(readFileSync(join(state, name), 'utf8')).toBe('preserve-synthetic-record')
    } finally { guard.close() }
})

const procStat = (start: string, comm = 'name with (nested) parentheses)') => `1 (${comm}) S ${Array(18).fill('0').join(' ')} ${start} 0 0\n`
test('PID1 stat parsing handles spaces and closing parentheses without rounding uint64 ticks', () => {
    expect(parseInitStartTime(procStat('18446744073709551615'))).toBe('18446744073709551615')
    expect(parseInitStartTime(procStat('0', 'init'))).toBe('0')
    expect(parseInitStartTime(procStat('9007199254740993', 'a\n)b c'))).toBe('9007199254740993')
    for (const invalid of [procStat('-1'), procStat('01'), procStat('1.2'), procStat('18446744073709551616'), procStat('3').replace(/^1 /, '2 '), '1 (truncated) S 0', procStat('3', 'x'.repeat(8192)), '1 missing-brackets S 0']) {
        expect(() => parseInitStartTime(invalid)).toThrow('PID1')
    }
})

test('invalid v2 start identity fails closed before transient deletion', () => {
    for (const initStartTime of [undefined, 1000, '', '01', '-1', '18446744073709551616']) {
        const { home, state } = fixture(), guard = acquireRunnerHome(home)
        writeFileSync(join(state, '.runner-namespace.json'), JSON.stringify({ ...previous, initStartTime }))
        try {
            expect(() => guard.prepare(next, true)).toThrow('Invalid runner start identity')
            expect(readFileSync(join(state, 'runner.state.json.lock'), 'utf8')).toBe(String(process.pid))
        } finally { guard.close() }
    }
})
