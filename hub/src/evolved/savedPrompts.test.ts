import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { EvolvedStore } from './store'
import { createEvolvedRoutes } from './api'
import { SESSION_COOKIE } from './security'

const stores: EvolvedStore[] = []
type PromptBody = { prompt: { id: string; text: string }; prompts: { id: string; text: string }[] }
type PromptResponse = Omit<Response, 'json'> & { json: () => Promise<PromptBody> }
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup() {
    const store = new EvolvedStore(':memory:'); stores.push(store)
    const users = [randomUUID(), randomUUID()]
    for (const [index, id] of users.entries()) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(id, `User ${index}`, Date.now())
    const tokens = users.map(id => store.createSession(id)), origin = 'https://evolved.test'
    const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store, origin, vault: { request: async () => ({}) } }))
    const call = async (path = '', method = 'GET', body?: unknown, user = 0, bearer?: string): Promise<PromptResponse> => await app.request(`${origin}/api/evolved/saved-prompts${path}`, {
        method, headers: { origin, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `${SESSION_COOKIE}=${tokens[user]}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as PromptResponse
    return { store, users, call }
}
describe('personal saved prompts', () => {
    test('persists exact multiline text, updates, orders and deletes across requests', async () => {
        const s = setup(), text = '  Review this:\n\n$HOME and `code`\n'
        const a = await (await s.call('', 'POST', { title: 'Review', text })).json()
        const b = await (await s.call('', 'POST', { text: 'Second' })).json()
        expect(a.prompt.text).toBe(text)
        expect((await s.call(`/${a.prompt.id}`, 'PUT', { title: 'Renamed', text })).status).toBe(200)
        const reordered = await (await s.call('/order', 'PUT', { ids: [b.prompt.id, a.prompt.id] })).json()
        expect(reordered.prompts.map((p: { id: string }) => p.id)).toEqual([b.prompt.id, a.prompt.id])
        expect((await s.call(`/${a.prompt.id}`, 'DELETE')).status).toBe(200)
        expect((await (await s.call()).json()).prompts).toHaveLength(1)
    })
    test('cross-user read, edit, delete and ordering cannot expose or mutate a prompt', async () => {
        const s = setup(), { prompt } = await (await s.call('', 'POST', { text: 'private' })).json()
        expect((await (await s.call('', 'GET', undefined, 1)).json()).prompts).toEqual([])
        expect((await s.call(`/${prompt.id}`, 'PUT', { text: 'changed' }, 1)).status).toBe(404)
        expect((await s.call(`/${prompt.id}`, 'DELETE', undefined, 1)).status).toBe(404)
        expect((await s.call('/order', 'PUT', { ids: [prompt.id] }, 1)).status).toBe(409)
        expect((await (await s.call()).json()).prompts[0].text).toBe('private')
    })
    test('rejects runner capabilities and malformed or oversized input', async () => {
        const s = setup(), team = s.store.createTeam(s.users[0], 'Team'), project = s.store.createProject(s.users[0], team.id, 'Project')
        const capability = s.store.issueCapability(s.users[0], project.id, ['memory:read'], [], 300)
        expect((await s.call('', 'GET', undefined, 0, capability.token)).status).toBe(403)
        for (const body of [{ text: ' ' }, { text: 'x'.repeat(32_769) }, { text: 'ok', userId: s.users[1] }]) expect((await s.call('', 'POST', body)).status).toBe(400)
    })
    test('stale reorder and duplicate ids leave existing ordering intact', async () => {
        const s = setup(), { prompt } = await (await s.call('', 'POST', { text: 'First' })).json()
        await s.call('', 'POST', { text: 'Second' })
        expect((await s.call('/order', 'PUT', { ids: [prompt.id] })).status).toBe(409)
        expect((await s.call('/order', 'PUT', { ids: [prompt.id, prompt.id] })).status).toBe(409)
        expect((await (await s.call()).json()).prompts.map((p: { text: string }) => p.text)).toEqual(['First', 'Second'])
    })
})
