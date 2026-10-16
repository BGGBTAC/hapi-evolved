// Fixed offline chat-rendering probe, restricted to this harness's private state.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EvolvedStore } from '../../hub/src/evolved/store'
// Reuse the Web workspace's existing dependency, without adding a root package.
const { io } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client')

const [state, origin] = process.argv.slice(2)
if (!/^\/tmp\/hapi-evolved-ui-community-[A-Za-z0-9]+$/.test(state ?? '')) throw new Error('Private demo state required')
const info = lstatSync(state)
if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(state) !== state) throw new Error('Demo state boundary rejected')
const url = new URL(origin)
if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !/^\d+$/.test(url.port) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Own loopback origin required')
const fixture = JSON.parse(readFileSync(join(state, 'workflow-ready.json'), 'utf8'))
const store = new EvolvedStore(join(state, 'evolved.db'), { managedWorkspaceRoot: join(state, 'managed-workspaces') })
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
