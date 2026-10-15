// WebAuthn buffers never pass through JSON unchanged. Decode the server's
// base64url challenge/credential IDs and serialize the authenticator response.
export function decodeBase64url(value: string): ArrayBuffer {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    return bytes.buffer
}
export function encodeBase64url(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value)
    let result = ''
    for (const byte of bytes) result += String.fromCharCode(byte)
    return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

type CredentialDescriptorJSON = Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string }
export type RegistrationOptionsJSON = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
    challenge: string
    user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }
    excludeCredentials?: CredentialDescriptorJSON[]
}
export type AuthenticationOptionsJSON = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
    challenge: string
    allowCredentials?: CredentialDescriptorJSON[]
}

function requireWebAuthn(): void {
    if (!window.isSecureContext) throw new Error('Passkeys benötigen HTTPS oder localhost.')
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Dieser Browser unterstützt keine Passkeys. Verwende einen aktuellen Browser oder einen Wiederherstellungscode.')
}

export async function createPasskey(options: RegistrationOptionsJSON): Promise<unknown> {
    requireWebAuthn()
    const credential = await navigator.credentials.create({
        publicKey: {
            ...options,
            challenge: decodeBase64url(options.challenge),
            user: { ...options.user, id: decodeBase64url(options.user.id) },
            excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: decodeBase64url(item.id) })),
        },
    }) as PublicKeyCredential | null
    if (!credential) throw new Error('Es wurde kein Passkey erstellt.')
    const response = credential.response as AuthenticatorAttestationResponse
    return {
        id: credential.id,
        rawId: encodeBase64url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
            attestationObject: encodeBase64url(response.attestationObject),
            clientDataJSON: encodeBase64url(response.clientDataJSON),
            transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
    }
}

export async function authenticatePasskey(options: AuthenticationOptionsJSON): Promise<unknown> {
    requireWebAuthn()
    const credential = await navigator.credentials.get({
        publicKey: {
            ...options,
            challenge: decodeBase64url(options.challenge),
            allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: decodeBase64url(item.id) })),
        },
    }) as PublicKeyCredential | null
    if (!credential) throw new Error('Die Passkey-Anmeldung wurde abgebrochen.')
    const response = credential.response as AuthenticatorAssertionResponse
    return {
        id: credential.id,
        rawId: encodeBase64url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
            authenticatorData: encodeBase64url(response.authenticatorData),
            clientDataJSON: encodeBase64url(response.clientDataJSON),
            signature: encodeBase64url(response.signature),
            userHandle: response.userHandle ? encodeBase64url(response.userHandle) : undefined,
        },
    }
}
