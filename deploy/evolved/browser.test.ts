import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
type Service = { profiles?: string[]; image?: string; networks: string[]; volumes?: Array<string | { source: string; target: string; read_only?: boolean; bind?: { create_host_path?: boolean } }>
    environment?: Record<string, string>; read_only: boolean; cap_drop: string[]; security_opt: string[]; depends_on?: string[]; mem_limit?: string; user?: string }
const compose = Bun.YAML.parse(source('./runner.compose.yml')) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean; external?: boolean }> }
const browserServices = ['browser-gateway', 'browser', 'browser-egress']

describe('optional project browser topology', () => {
    test('browser services exist only under the browser profile; core services are untouched', () => {
        for (const name of browserServices) expect(compose.services[name]!.profiles).toEqual(['browser'])
        for (const name of ['runner', 'runner-proxy', 'egress']) expect(compose.services[name]!.profiles).toBeUndefined()
        expect(compose.services.runner!.networks).toEqual(['project', 'provider-egress'])
        expect(compose.services['runner-proxy']!.networks).toEqual(['project', 'backend'])
        expect(compose.services.egress!.networks).toEqual(['project', 'provider-egress'])
        expect(compose.services.runner!.depends_on).toEqual(['runner-proxy', 'egress'])
    })
    test('separate internal control/outbound networks; the browser has no project, backend or provider route', () => {
        expect(compose.networks['browser-control']).toEqual({ internal: true })
        expect(compose.networks['browser-outbound']).toEqual({ internal: true })
        expect(compose.networks['browser-internet']!.internal).toBeUndefined()
        expect(compose.services.browser!.networks).toEqual(['browser-control', 'browser-outbound'])
        expect(compose.services['browser-gateway']!.networks).toEqual(['project', 'browser-control'])
        expect(compose.services['browser-egress']!.networks).toEqual(['browser-outbound', 'browser-internet'])
        const members = (network: string) => Object.entries(compose.services).filter(([, service]) => service.networks.includes(network)).map(([name]) => name).sort()
        expect(members('browser-control')).toEqual(['browser', 'browser-gateway'])
        expect(members('browser-outbound')).toEqual(['browser', 'browser-egress'])
        expect(members('browser-internet')).toEqual(['browser-egress'])
    })
    test('the access key is mounted read-only into exactly the gateway and the browser, never auto-created', () => {
        const holders = Object.entries(compose.services).filter(([, service]) => (service.volumes ?? []).some(volume => typeof volume === 'object' && volume.target === '/credentials/browser-key')).map(([name]) => name).sort()
        expect(holders).toEqual(['browser', 'browser-gateway'])
        for (const name of holders) {
            const mount = compose.services[name]!.volumes!.find(volume => typeof volume === 'object' && volume.target === '/credentials/browser-key') as { read_only: boolean; bind: { create_host_path: boolean }; source: string }
            expect(mount.read_only).toBe(true); expect(mount.bind.create_host_path).toBe(false)
            expect(mount.source).toBe('${EVOLVED_BROWSER_KEY_FILE:-/nonexistent/hapi-evolved-browser.key}')
        }
        expect(JSON.stringify(compose.services.runner)).not.toContain('BROWSER')
        expect(JSON.stringify(compose.services['runner-proxy'])).not.toContain('BROWSER')
    })
    test('hardened runtime: no telemetry, plugins off, production, mandatory key file, nonroot read-only', () => {
        const browser = compose.services.browser!
        expect(browser.image).toBe('hapi-evolved-browser:0.1.0')
        expect(browser.read_only).toBe(true); expect(browser.cap_drop).toEqual(['ALL']); expect(browser.security_opt).toEqual(['no-new-privileges:true'])
        expect(browser.user).toBe('${EVOLVED_UID:-1000}:${EVOLVED_GID:-1000}')
        expect(browser.environment).toMatchObject({ NODE_ENV: 'production', CAMOFOX_CRASH_REPORT_ENABLED: 'false', SENTRY_DSN: '', CAMOFOX_DISABLE_DEFAULT_ADDONS: '1',
            PROMETHEUS_ENABLED: 'false', ENABLE_VNC: 'false', CAMOFOX_ACCESS_KEY_FILE: '/credentials/browser-key', HAPI_BROWSER_EGRESS_PROXY: 'http://browser-egress:3128' })
        for (const key of ['CAMOFOX_ACCESS_KEY', 'CAMOFOX_API_KEY', 'CAMOFOX_ADMIN_KEY', 'PROXY_HOST', 'PROXY_USERNAME', 'PROXY_PASSWORD']) expect(browser.environment![key]).toBeUndefined()
        const config = JSON.parse(source('./browser/camofox.config.json'))
        expect(config.plugins).toEqual({ youtube: { enabled: false }, persistence: { enabled: false }, vnc: { enabled: false }, 'hapi-egress': { enabled: true } })
    })
    test('image build pins upstream source, Camoufox assets, base image and lock fixes', () => {
        const dockerfile = source('./Browser.Dockerfile'), sums = source('./browser/SHA256SUMS')
        expect(dockerfile).toContain('node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d')
        expect(dockerfile).toContain('https://registry.npmjs.org/@askjo/camofox-browser/-/camofox-browser-1.18.1.tgz')
        expect(dockerfile).toContain('JLxRXtsCnAyaewFf/jWteZUJLW0x4m+WhZNNRa7iVOWa21R/7/GHH7x6g83DPi7fJ4aIGeq9+RZlHduGiOMOAg==')
        expect(dockerfile).toContain('v152.0.4-beta.30/$asset')
        expect(dockerfile).toMatch(/amd64\) asset=camoufox-152\.0\.4-beta\.30-lin\.x86_64\.zip; size=663467670/)
        expect(dockerfile).toMatch(/arm64\) asset=camoufox-152\.0\.4-beta\.30-lin\.arm64\.zip; size=653870625/)
        expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts')
        expect(dockerfile).toContain('USER 1000:1000')
        // camoufox-js exports camoufoxPath/installedVerStr (not Version); optional native deps (impit) must stay installed.
        expect(dockerfile).toContain("camoufoxPath(false); launchPath(); if (installedVerStr() !== '152.0.4-beta.30')")
        expect(dockerfile).not.toContain('import { Version }')
        expect(dockerfile).not.toContain('--omit=optional')
        expect(dockerfile).not.toMatch(/\|\|\s*true/)
        expect(dockerfile).not.toMatch(/beta\.(?:28|36)/)
        expect(sums).toContain('5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672  camoufox-152.0.4-beta.30-lin.x86_64.zip')
        expect(sums).toContain('60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124  camoufox-152.0.4-beta.30-lin.arm64.zip')
        expect(sums).toContain('b89badde10eaf3df0327c850cdc880560ea445d88bd6502314716a7123df3d66  camofox-browser-1.18.1.tgz')
        const lock = JSON.parse(source('./browser/package-lock.json')).packages as Record<string, { version: string; dev?: boolean }>
        expect(lock['node_modules/@modelcontextprotocol/sdk']!.version).toBe('1.32.0')
        expect(lock['node_modules/hono']!.version).toBe('4.13.11')
        expect(lock['node_modules/proxy-addr']!.version).toBe('2.0.8')
        expect(lock['']).toMatchObject({ name: '@askjo/camofox-browser', version: '1.18.1' })
    })
    test('the upstream patch is exact and the entrypoint refuses unsafe configuration', () => {
        expect(source('./browser/patch-upstream.mjs')).toContain("['        geoip: !!launchProxy,\\n        locale:', '        geoip: false,\\n        locale:']")
        expect(source('./browser/patch-upstream.mjs')).toContain("if (!loadedPlugins.includes('hapi-egress')) throw")
        const entry = source('./browser/hapi-entry.mjs')
        for (const fragment of ["process.env.CAMOFOX_CRASH_REPORT_ENABLED !== 'false'", "process.env.NODE_ENV !== 'production'", 'O_NOFOLLOW', 'process.exit(78)', 'delete process.env.CAMOFOX_ACCESS_KEY;']) expect(entry).toContain(fragment)
        expect(source('./browser/plugins/hapi-egress/index.js')).toContain("'network.proxy.allow_hijacking_localhost': true")
    })
})
