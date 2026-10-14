import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatePasskey, createPasskey, decodeBase64url, encodeBase64url } from './webauthn'

afterEach(() => vi.unstubAllGlobals())
function installCredentials(credentials: Partial<CredentialsContainer>) {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PublicKeyCredential', class {})
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: credentials })
}
describe('passkey transport', () => {
    it('preserves arbitrary binary credentials with URL-safe base64', () => {
        const bytes = Uint8Array.from([0, 255, 254, 253, 128, 7]).buffer
        const encoded = encodeBase64url(bytes)
        expect(encoded).not.toMatch(/[+/=]/)
        expect(new Uint8Array(decodeBase64url(encoded))).toEqual(new Uint8Array(bytes))
    })
    it('decodes registration challenges and excludes IDs, then serializes attestation', async () => {
        const create = vi.fn().mockResolvedValue({ id: 'credential', rawId: new Uint8Array([1, 2]).buffer, type: 'public-key', authenticatorAttachment: 'platform', getClientExtensionResults: () => ({ credProps: { rk: true } }), response: { attestationObject: new Uint8Array([254]).buffer, clientDataJSON: new Uint8Array([255]).buffer, getTransports: () => ['internal'] } })
        installCredentials({ create })
        const result = await createPasskey({ challenge: 'AQI', rp: { name: 'Test', id: 'localhost' }, user: { id: 'AwQ', name: 'test', displayName: 'Test' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: 'BQY' }], authenticatorSelection: { userVerification: 'required' } })
        const options = create.mock.calls[0][0].publicKey
        expect(new Uint8Array(options.challenge)).toEqual(new Uint8Array([1, 2]))
        expect(new Uint8Array(options.user.id)).toEqual(new Uint8Array([3, 4]))
        expect(new Uint8Array(options.excludeCredentials[0].id)).toEqual(new Uint8Array([5, 6]))
        expect(options.authenticatorSelection.userVerification).toBe('required')
        expect(result).toMatchObject({ rawId: 'AQI', response: { attestationObject: '_g', clientDataJSON: '_w', transports: ['internal'] } })
    })
    it('preserves assertion signature and optional user handle without encoding null', async () => {
        const get = vi.fn().mockResolvedValue({ id: 'credential', rawId: new Uint8Array([1]).buffer, type: 'public-key', getClientExtensionResults: () => ({}), response: { authenticatorData: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null } })
        installCredentials({ get })
        const result = await authenticatePasskey({ challenge: 'BQ', rpId: 'localhost', userVerification: 'required' })
        expect(get.mock.calls[0][0].publicKey.userVerification).toBe('required')
        expect(result).toMatchObject({ response: { authenticatorData: 'Ag', clientDataJSON: 'Aw', signature: 'BA', userHandle: undefined } })
    })
    it('fails before creating credentials on an insecure origin', async () => {
        const get = vi.fn()
        installCredentials({ get })
        vi.stubGlobal('isSecureContext', false)
        await expect(authenticatePasskey({ challenge: 'AQ' })).rejects.toThrow('HTTPS')
        expect(get).not.toHaveBeenCalled()
    })
})
