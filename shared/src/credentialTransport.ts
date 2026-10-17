import { AgentCredentialBundleSchema, isCredentialEnvName, type AgentCredentialBundle } from './credentialEnv'

// JSON escaping can expand each byte into six characters. Bound before parsing.
const MAX_RESPONSE_BYTES = 6 * 64 * 1024 + 8192
export async function readCredentialResponse(response: Response, projectId: string): Promise<AgentCredentialBundle> {
    try {
        if (!response.ok || !response.body) throw new Error()
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > MAX_RESPONSE_BYTES) throw new Error()
                chunks.push(value)
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        const { projectId: returnedProject, ...bundle } = value as Record<string, unknown>
        if (returnedProject !== projectId) throw new Error()
        if (!bundle.environment || typeof bundle.environment !== 'object' || Array.isArray(bundle.environment)
            || Object.keys(bundle.environment).some(name => !isCredentialEnvName(name))) throw new Error()
        return AgentCredentialBundleSchema.parse(bundle)
    } catch {
        await response.body?.cancel().catch(() => {})
        // Never forward upstream diagnostics or schema input, which may contain credentials.
        throw new Error('Project credential delivery unavailable. Check Project Vault agent access and the project service.')
    }
}
