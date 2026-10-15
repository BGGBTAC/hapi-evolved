import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { githubPrEnabled, linkGithubPr, registerGithubPrTool } from './githubPr'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
test('Evolved PR discovery and self-targeted MCP use capability transport without legacy token exchange', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pr-cli-')), tokenFile = join(directory, 'cap')
    writeFileSync(tokenFile, 'a'.repeat(43), { mode: 0o600 })
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    let enabled = false
    const calls: Array<{ path: string; body: unknown }> = []
    const server = createServer(async (req, res) => {
        try {
            expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(43)}`)
            const path = new URL(req.url!, 'http://localhost').pathname
            res.setHeader('Content-Type', 'application/json')
            if (path === '/api/evolved/github-pr/features') { res.end(JSON.stringify({ enabled })); return }
            let body = ''
            for await (const chunk of req) body += chunk.toString()
            calls.push({ path, body: JSON.parse(body) })
            res.statusCode = enabled ? 200 : 403
            res.end(JSON.stringify(enabled ? { ok: true } : { error: 'PR links disabled' }))
        } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
    const port = (server.address() as AddressInfo).port
    const overrides = { HAPI_EVOLVED_PROXY: '', HAPI_EVOLVED_CAPABILITY_FILE: tokenFile, HAPI_EVOLVED_URL: `http://127.0.0.1:${port}`, EVOLVED_PROJECT_ID: 'project', HAPI_SESSION_ID: 'current-session' }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    cleanup.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
    expect(await githubPrEnabled()).toBe(false)
    enabled = true; expect(await githubPrEnabled()).toBe(true)
    let handler!: (args: { pr: string }) => Promise<unknown>
    registerGithubPrTool({ registerTool(name: string, definition: { inputSchema: object }, callback: typeof handler) {
        expect(name).toBe('link_pr'); expect(Object.keys(definition.inputSchema)).toEqual(['pr']); handler = callback
    } } as unknown as McpServer)
    expect(await handler({ pr: 'owner/repo#42' })).not.toHaveProperty('isError')
    expect(calls).toEqual([{ path: '/api/evolved/github-pr/link', body: { sessionId: 'current-session', pr: 'https://github.com/owner/repo/pull/42' } }])
    enabled = false
    expect(await handler({ pr: 'owner/repo#43' })).toHaveProperty('isError', true)
    const before = calls.length
    await expect(linkGithubPr('https://evil.example/owner/repo/pull/42')).rejects.toThrow('github.com')
    expect(calls).toHaveLength(before)
})
