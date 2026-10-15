import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export type ControlAction = 'status' | 'prepare' | 'start' | 'get' | 'code' | 'cancel' | 'logout' | 'authority'
export type ControlRequest = {
    action: ControlAction; projectId: string; userId: string; sessionHash: string
    profile: 'restricted' | 'workspace' | 'extended'; rootPath: string; leaseId: string
    provider?: 'codex' | 'claude'; operationId?: string; code?: string; leaseToken?: string
}
type Envelope = { payload: string; signature: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const actions: ControlAction[] = ['status', 'prepare', 'start', 'get', 'code', 'cancel', 'logout', 'authority']
export function validControlRequest(value: unknown): value is ControlRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const r = value as ControlRequest
    const allowed = ['action','projectId','userId','sessionHash','profile','rootPath','leaseId','provider','operationId','code','leaseToken']
    return Object.keys(r).every(k => allowed.includes(k)) && actions.includes(r.action)
        && [r.projectId,r.userId,r.leaseId].every(id => typeof id === 'string' && uuid.test(id))
        && /^[a-f0-9]{64}$/.test(r.sessionHash) && ['restricted','workspace','extended'].includes(r.profile)
        && typeof r.rootPath === 'string' && (r.rootPath === `/managed-workspaces/${r.projectId}` || /^\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.rootPath))
        && (r.provider === undefined || ['codex','claude'].includes(r.provider))
        && (r.operationId === undefined || (typeof r.operationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.operationId)))
        && (r.code === undefined || (typeof r.code === 'string' && /^[A-Za-z0-9_.~+#/-]{1,4096}$/.test(r.code)))
        && (r.leaseToken === undefined || (r.action === 'prepare' && /^[A-Za-z0-9_-]{43}$/.test(r.leaseToken)))
        && (!['start','get','code','cancel','logout'].includes(r.action) || r.provider !== undefined)
        && (!['get','code','cancel'].includes(r.action) || r.operationId !== undefined)
        && (r.action !== 'code' || r.code !== undefined)
}
export function signControl(key: Uint8Array, request: ControlRequest, direction: 'operator' | 'hub', now = Date.now()): Envelope {
    const payload = Buffer.from(JSON.stringify({ version: 1, issuedAt: now, expiresAt: now + 30_000, nonce: randomUUID(), request })).toString('base64url')
    return { payload, signature: createHmac('sha256', key).update(`hapi-runner-control:${direction}:${payload}`).digest('base64url') }
}
/** Short-lived, direction-bound messages. Nonces are consumed before any operation. */
export function verifyControl(key: Uint8Array, envelope: unknown, direction: 'operator' | 'hub', seen: Map<string, number>, now = Date.now()): ControlRequest {
    const fail = () => { throw new Error('Invalid control authorization') }
    if (!envelope || typeof envelope !== 'object') return fail()
    const { payload, signature } = envelope as Envelope
    if (typeof payload !== 'string' || payload.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(payload) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return fail()
    const expected = createHmac('sha256', key).update(`hapi-runner-control:${direction}:${payload}`).digest()
    const supplied = Buffer.from(signature, 'base64url')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return fail()
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (decoded.version !== 1 || !Number.isSafeInteger(decoded.issuedAt) || !Number.isSafeInteger(decoded.expiresAt)
        || decoded.issuedAt > now + 2000 || decoded.expiresAt <= now || decoded.expiresAt - decoded.issuedAt !== 30_000
        || typeof decoded.nonce !== 'string' || !uuid.test(decoded.nonce) || !validControlRequest(decoded.request)) return fail()
    for (const [nonce, expiry] of seen) if (expiry <= now) seen.delete(nonce)
    if (seen.has(decoded.nonce) || seen.size >= 10_000) return fail()
    seen.set(decoded.nonce, decoded.expiresAt)
    return decoded.request
}
