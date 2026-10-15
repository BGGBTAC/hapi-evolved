import { describe, expect, it } from 'bun:test'
import { containsCredential, excludedSourcePath, isSafeSourcePath } from './evolvedSourcePolicy'

describe('canonical source paths', () => {
    it.each([
        'README.md', 'src/main.ts', '.github/workflows/test.yml', 'docs/hello world.md',
        'src/foo..bar.ts', 'src/Größe.ts', 'docs/😀.md', '-option.txt', 'src/a:b.ts',
        'literal/:(glob)file.txt', 'literal/%2e%2e.txt',
    ])('preserves the exact permitted filename %s', path => {
        expect(isSafeSourcePath(path)).toBe(true)
    })

    it.each([
        '', '/', '/etc/passwd', '../a', 'a/../b', './a', 'a/./b', 'a//b', 'a/',
        'C:/file', 'C:file', '\\\\server\\share', 'src\\main.ts',
        'line\nbreak', 'tab\tname', 'nul\0name', 'delete\x7fname',
        'zero\u200bwidth', 'bidi\u202ename', 'variation\ufe0fname', 'bad\ud800name',
    ])('rejects traversal, ambiguous or invisible paths %s', path => {
        expect(isSafeSourcePath(path)).toBe(false)
        expect(excludedSourcePath(path)).toBe(true)
    })

    it('bounds UTF-8 bytes of both individual names and the full relative path', () => {
        expect(isSafeSourcePath('a'.repeat(255))).toBe(true)
        expect(isSafeSourcePath('a'.repeat(256))).toBe(false)
        expect(isSafeSourcePath('é'.repeat(127))).toBe(true)
        expect(isSafeSourcePath('é'.repeat(128))).toBe(false)
        const prefix = `${'a'.repeat(255)}/`.repeat(15)
        expect(isSafeSourcePath(prefix + 'b'.repeat(255))).toBe(true)
        expect(isSafeSourcePath(prefix + 'bb/bb')).toBe(true)
        expect(isSafeSourcePath(`${'a'.repeat(255)}/`.repeat(16) + 'b')).toBe(false)
    })
})

describe('excluded source paths', () => {
    it.each([
        '.env', '.env.example', '.ENV.production', 'project/.envrc', 'src/.environment',
        '.npmrc', 'nested/.NPMRC.backup', '.netrc', 'private/.NETRC', '.pypirc',
        '.git-credentials', '.docker/config.json', '.kube/config', 'kubeconfig-prod',
        '.ssh/config', '.AWS/config', '.gnupg/pubring.kbx', '.git/config',
        '.codegraph/index.json', '.codegraph-cache/data.json', 'node_modules/tool/main.js',
        'id_rsa', 'nested/ID_ED25519', 'id_ecdsa.pub', 'id_dsa.backup', 'id_rsa-old',
        'cert/server.pem', 'cert/server.KEY', 'cert/client.p12', 'cert/client.PFX',
        'cert/client.keystore', 'data.sqlite', 'data.DB', 'key.pem.backup',
        'keys.jks', 'passwords.kdbx', 'backup.age', 'key.asc', 'key.gpg',
        'state.tfstate', 'vars.tfvars', 'prod.env', 'backup.enc.json', 'id_rsaCOPY',
        'src/secretary.ts',
        'secrets/config.json', 'SECRETS.yaml', 'mysecrets.json', 'secret.json',
        'config/client-secret.toml', 'credentials.json', 'credential.txt',
        'backup/VAULT.json', 'vault-master', '.sops.yaml', 'config.sops.json',
    ])('excludes %s for every caller', path => {
        expect(isSafeSourcePath(path)).toBe(true)
        expect(excludedSourcePath(path)).toBe(true)
    })

    it.each([
        'src/index.ts', 'README.md', '.github/workflows/test.yml', 'package.json',
        'src/publicKey.ts', 'docs/environment.md',
        'src/config.test.ts', 'docs/keyboards.md',
    ])('does not turn unrelated source names into exclusions: %s', path => {
        expect(excludedSourcePath(path)).toBe(false)
    })
})

describe('credential content classification', () => {
    const marker = 'SyntheticCredential1234567890'
    it.each([
        '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----',
        '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----',
        `ghp_${marker}`, `gho_${marker}`, `ghu_${marker}`, `ghs_${marker}`, `ghr_${marker}`,
        `github_pat_${marker}`, `sk-${marker}`, `sk-ant-${marker}`, 'AKIAABCDEFGHIJKLMNOP',
        `password=${marker}`, `"api_key": "${marker}"`, `CLIENT_SECRET: ${marker}`,
        `access-token='${marker}'`, `passwd = ${marker}`,
        `-const apiKey = '${marker}';`, `+const clientSecret = '${marker}';`,
    ])('detects credential-shaped source and diff content', text => {
        expect(containsCredential(text)).toBe(true)
    })

    it.each([
        'Use the vault for passwords.', 'The secret is that this is ordinary documentation.',
        'Credentials belong outside the repository.', 'function getSecret() { return process.env.API_KEY }',
        'api_key=${ENVIRONMENT_VARIABLE}', 'password: ""', 'publicKey = "not-an-authentication-secret"',
        '-----BEGIN PUBLIC KEY-----', 'const secretName = "public documentation";',
    ])('permits ordinary discussion and references without treating every secret word as a value', text => {
        expect(containsCredential(text)).toBe(false)
    })

    it('uses a stable boolean classification across repeated calls', () => {
        for (let i = 0; i < 3; i++) {
            expect(containsCredential(`sk-${marker}`)).toBe(true)
            expect(containsCredential('ordinary text')).toBe(false)
        }
    })
})
