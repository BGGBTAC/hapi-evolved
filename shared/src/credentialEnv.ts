import { z } from 'zod'

/** A dedicated namespace cannot alter agent loaders, proxy settings or provider login. */
export function isCredentialEnvName(name: string): boolean {
    return /^PROJECT_SECRET_[A-Z][A-Z0-9_]{0,64}$/.test(name)
}

export const MAX_AGENT_CREDENTIALS = 32
export const MAX_AGENT_CREDENTIAL_BYTES = 64 * 1024

export const AgentCredentialBundleSchema = z.object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    environment: z.record(z.string().refine(isCredentialEnvName), z.string().refine(value => !value.includes('\0')))
        .refine(value => Object.keys(value).length <= MAX_AGENT_CREDENTIALS)
        .refine(value => Object.entries(value).reduce((size, [name, secret]) => size + new TextEncoder().encode(name + secret).length + 2, 0) <= MAX_AGENT_CREDENTIAL_BYTES),
}).strict()
export type AgentCredentialBundle = z.infer<typeof AgentCredentialBundleSchema>
