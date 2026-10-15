import type { Context } from 'hono'
import { authenticateEvolvedRequest, cookieToken, requireFreshPasskey, requireHuman } from './security'
import { EvolvedError, hashToken, type EvolvedStore } from './store'

/** Re-evaluate on every call, including after external awaits. */
export async function extensionHuman(context: Context, store: EvolvedStore, administration = false) {
    const principal = await authenticateEvolvedRequest(context.req.raw, store)
    if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
    requireHuman(principal)
    if (administration) {
        if (!principal.user.isAdmin) throw new EvolvedError('installation_admin_required', 'Only the installation administrator can manage global extensions.', 403)
        requireFreshPasskey(context, store, principal)
    }
    return principal
}
export function extensionSessionHash(context: Context): string {
    const token = cookieToken(context.req.raw)
    if (!token) throw new EvolvedError('unauthorized', 'Human session required.', 401)
    return hashToken(token)
}
/** Use within synchronous write transactions after the asynchronous request guard. */
export function extensionAdministrationNow(context: Context, store: EvolvedStore) {
    const token = cookieToken(context.req.raw), principal = token ? store.session(token) : null
    if (!principal) throw new EvolvedError('unauthorized', 'Session expired or was revoked.', 401)
    if (!principal.user.isAdmin) throw new EvolvedError('installation_admin_required', 'Installation administrator required.', 403)
    requireFreshPasskey(context, store, principal)
    return principal
}
