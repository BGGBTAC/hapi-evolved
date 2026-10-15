import { expect, test } from 'bun:test'
import { connectTarget, publicAddress } from './egress'
test('GitHub cannot bypass the project broker through provider egress', () => {
    const hosts = new Set(['github.com', 'api.github.com', 'ssh.github.com'])
    for (const host of hosts) expect(connectTarget(`${host}:443`, hosts)).toBeNull()
})
test('model egress admits only exact configured TLS hosts and public destinations', () => {
    const allow = new Set(['api.openai.com'])
    expect(connectTarget('api.openai.com:443', allow)).toBe('api.openai.com')
    for (const target of ['api.openai.com.evil.test:443', 'api.openai.com:80', '127.0.0.1:443', 'evil.test:443', 'api.openai.com@evil.test:443']) expect(connectTarget(target, allow)).toBeNull()
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.18.0.2', '192.168.2.1', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2002:7f00:1::1', '2001::1', '2001:db8::1', '3fff::1']) expect(publicAddress(address)).toBe(false)
    expect(publicAddress('1.1.1.1')).toBe(true)
    expect(publicAddress('2606:4700::1111')).toBe(true)
})
