import { expect, test } from 'bun:test'
import { AgentCredentialBundleSchema, isCredentialEnvName } from './credentialEnv'

test('only the dedicated project-secret namespace can enter agent environments', () => {
    expect(isCredentialEnvName('PROJECT_SECRET_ODOO_API_KEY')).toBe(true)
    for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'SSLKEYLOGFILE', 'OPENSSL_CONF', 'GCONV_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'HAPI_API_URL', 'EVOLVED_PROJECT_ID', 'PROJECT_SECRET_', 'PROJECT_SECRET_1', 'PROJECT_SECRET_lower', 'PROJECT_SECRET_X;A']) expect(isCredentialEnvName(name)).toBe(false)
})

test('credential bundles reject NUL, oversized totals, excess keys and untrusted extra fields', () => {
    const valid = { revision: 'a'.repeat(64), environment: { PROJECT_SECRET_KEY: 'synthetic' } }
    expect(AgentCredentialBundleSchema.safeParse(valid).success).toBe(true)
    for (const environment of [{ PROJECT_SECRET_KEY: 'bad\0value' }, { PROJECT_SECRET_KEY: 'x'.repeat(65536) }, { NODE_OPTIONS: '--require=evil' }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`PROJECT_SECRET_KEY_${i}`, 'x']))]) expect(AgentCredentialBundleSchema.safeParse({ ...valid, environment }).success).toBe(false)
    expect(AgentCredentialBundleSchema.safeParse({ ...valid, token: 'unexpected' }).success).toBe(false)
})
