import { expect, test } from 'bun:test'
import { connectTarget, createModelEgress, publicAddress } from './egress'
import { connect } from 'node:net'
test('default HTTPS proxy supports ordinary public services including GitHub', () => {
    for (const host of ['github.com', 'api.github.com', 'bggbtac-gbtac20.odoo.com', 'pypi.org', 'files.pythonhosted.org']) {
        expect(connectTarget(`${host}:443`, new Set())).toBe(host)
    }
})
test('explicit proxy host restriction uses exact TLS hosts and public destinations', () => {
    const allow = new Set(['api.openai.com'])
    expect(connectTarget('api.openai.com:443', allow)).toBe('api.openai.com')
    for (const target of ['api.openai.com.evil.test:443', 'api.openai.com:80', '127.0.0.1:443', 'evil.test:443', 'api.openai.com@evil.test:443']) expect(connectTarget(target, allow)).toBeNull()
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.18.0.2', '192.168.2.1', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2002:7f00:1::1', '2001::1', '2001:db8::1', '3fff::1']) expect(publicAddress(address)).toBe(false)
    expect(publicAddress('1.1.1.1')).toBe(true)
    expect(publicAddress('2606:4700::1111')).toBe(true)
})

test('empty environment host lists mean unrestricted HTTPS proxy, while private DNS remains denied', async () => {
    const server = createModelEgress(['', ' ', '\t'], 0)
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve))
    try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing proxy listener')
        const response = await new Promise<string>((resolve, reject) => {
            const client = connect({ host: '127.0.0.1', port: address.port })
            let output = ''
            client.setTimeout(5_000, () => client.destroy(new Error('Proxy test timed out')))
            client.once('connect', () => client.write('CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n'))
            client.on('data', chunk => { output += chunk.toString() })
            client.once('end', () => resolve(output))
            client.once('error', reject)
        })
        // 502 proves the target passed the empty-list check and failed DNS-address
        // validation. A mistakenly allowlisted empty string would return 403.
        expect(response).toStartWith('HTTP/1.1 502 Bad Gateway')
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
})
