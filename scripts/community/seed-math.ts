// Fixed offline chat-rendering probe, restricted to this harness's private state.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { EvolvedStore } from '../../hub/src/evolved/store'
// Reuse the Web workspace's existing dependency, without adding a root package.
const { io } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client')

const [requestedState, origin] = process.argv.slice(2)
// Reconstruct under the fixed fixture parent; arguments cannot select an
// arbitrary filesystem root, traversal path or nested directory.
const state = join('/tmp', basename(requestedState ?? ''))
if (state !== requestedState || !/^hapi-evolved-ui-community-[A-Za-z0-9]{6}$/.test(basename(state))) throw new Error('Private demo state required')
const url = new URL(origin)
if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !/^\d+$/.test(url.port) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Own loopback origin required')
const stateFd = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
try {
    const info = fstatSync(stateFd)
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(state) !== state) throw new Error('Demo state boundary rejected')
    const anchoredState = `/proc/${process.pid}/fd/${stateFd}`
    const fixtureFd = openSync(join(anchoredState, 'workflow-ready.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let fixture: { projectId: string; sessionId: string }
    try {
        const file = fstatSync(fixtureFd)
        if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 16384) throw new Error('Private demo fixture required')
        const bytes = Buffer.alloc(16385)
        const length = readSync(fixtureFd, bytes, 0, bytes.length, 0)
        if (length > 16384) throw new Error('Demo fixture exceeds limit')
        fixture = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
        if (!uuid.test(fixture.projectId) || !uuid.test(fixture.sessionId)) throw new Error('Synthetic fixture identity required')
    } finally { closeSync(fixtureFd) }
    const store = new EvolvedStore(join(anchoredState, 'evolved.db'), { managedWorkspaceRoot: join(state, 'managed-workspaces') })
    try {
        const user = store.db.query('SELECT id FROM evolved_users WHERE is_admin=1').get() as { id: string }
        const project = store.requireProject(user.id, fixture.projectId, 'admin')
        if (!project.rootPath.startsWith(state + '/')) throw new Error('Synthetic project required')
        const capability = store.issueCapability(user.id, project.id, ['runner:connect'], [], 60)
        const socket = io(`${url.origin}/cli`, { transports: ['websocket'], reconnection: false, auth: { clientType: 'session-scoped', sessionId: fixture.sessionId, token: capability.token } })
        try {
            await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Math probe connection timeout')), 5000); socket.once('connect', () => { clearTimeout(timer); resolve() }); socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Math probe denied')) }) })
            socket.emit('message', { sid: fixture.sessionId, message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Synthetic rendering check — no model output.\n\n\\[\\frac{1}{2} + \\frac{1}{2} = 1\\]' } } }, createdAt: Date.now() })
            await new Promise(resolve => setTimeout(resolve, 750))
        } finally { socket.disconnect() }
    } finally { store.close() }
} finally { closeSync(stateFd) }
