/** Only explicit runtime limits are context windows. Model names, account tiers and
 * historic defaults cannot establish the usable budget of a running session. */
function parseCursorWireContextWindow(model: string): number | null {
    const match = model.match(/\[([^\]]+)\]/)
    if (!match) {
        return null
    }
    for (const segment of match[1].split(',')) {
        const part = segment.trim()
        const eq = part.indexOf('=')
        if (eq === -1 || part.slice(0, eq).trim() !== 'context') {
            continue
        }
        const raw = part.slice(eq + 1).trim().toLowerCase()
        const digits = raw.match(/(\d+)/)?.[1]
        if (!digits) {
            return null
        }
        const value = Number.parseInt(digits, 10)
        if (!Number.isFinite(value) || value <= 0) {
            return null
        }
        return raw.endsWith('k') ? value * 1000 : value
    }
    return null
}

export function getContextBudgetTokens(model: string | null | undefined, flavor?: string | null): number | null {
    // Cursor's wire ID explicitly encodes its selected context capability. Claude,
    // Codex and Pi report context through runtime usage instead of fixed defaults.
    return flavor === 'cursor' && model ? parseCursorWireContextWindow(model) : null
}
