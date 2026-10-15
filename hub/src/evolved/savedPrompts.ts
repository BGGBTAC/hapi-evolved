import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { EvolvedError, type EvolvedStore } from './store'
import { parseBody, requireHuman, type EvolvedEnv } from './security'

type SavedPrompt = { id: string; title: string; text: string; position: number; createdAt: number; updatedAt: number }
const content = z.object({ title: z.string().trim().max(120).default(''), text: z.string().min(1).max(32_768).refine(value => value.trim().length > 0) }).strict()

/** Personal, authenticated prompt text. Runner capabilities never inherit access. */
export function createSavedPromptRoutes(store: EvolvedStore): Hono<EvolvedEnv> {
    store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_saved_prompts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS evolved_saved_prompts_owner ON evolved_saved_prompts(user_id,position);`)
    const app = new Hono<EvolvedEnv>()
    app.use('*', async (c, next) => { requireHuman(c.get('principal')); return next() })
    const list = (userId: string) => store.db.prepare('SELECT id,title,text,position,created_at AS createdAt,updated_at AS updatedAt FROM evolved_saved_prompts WHERE user_id=? ORDER BY position,created_at,id').all(userId) as SavedPrompt[]
    app.get('/', c => c.json({ prompts: list(c.get('principal').user.id) }))
    app.post('/', async c => {
        const body = await parseBody(c, content), userId = c.get('principal').user.id
        const prompt = store.db.transaction(() => {
            const existing = list(userId)
            if (existing.length >= 100) throw new EvolvedError('prompt_limit', 'At most 100 saved prompts are allowed.', 409)
            const now = store.now(), id = randomUUID(), position = (existing.at(-1)?.position ?? -1) + 1
            store.db.prepare('INSERT INTO evolved_saved_prompts VALUES(?,?,?,?,?,?,?)').run(id, userId, body.title, body.text, position, now, now)
            return { id, ...body, position, createdAt: now, updatedAt: now }
        })()
        return c.json({ prompt }, 201)
    })
    app.put('/order', async c => {
        const body = await parseBody(c, z.object({ ids: z.array(z.string().uuid()).max(100) }).strict()), userId = c.get('principal').user.id
        store.db.transaction(() => {
            const current = list(userId), ids = new Set(body.ids)
            if (ids.size !== body.ids.length || current.length !== ids.size || current.some(item => !ids.has(item.id))) {
                throw new EvolvedError('prompt_order_conflict', 'Prompt list changed. Reload before reordering.', 409)
            }
            const update = store.db.prepare('UPDATE evolved_saved_prompts SET position=?,updated_at=? WHERE id=? AND user_id=?')
            body.ids.forEach((id, index) => update.run(index, store.now(), id, userId))
        })()
        return c.json({ prompts: list(userId) })
    })
    app.put('/:id', async c => {
        const body = await parseBody(c, content), userId = c.get('principal').user.id
        const result = store.db.prepare('UPDATE evolved_saved_prompts SET title=?,text=?,updated_at=? WHERE id=? AND user_id=?').run(body.title, body.text, store.now(), c.req.param('id'), userId)
        if (!result.changes) throw new EvolvedError('not_found', 'Saved prompt not found.', 404)
        return c.json({ prompts: list(userId) })
    })
    app.delete('/:id', c => {
        const result = store.db.prepare('DELETE FROM evolved_saved_prompts WHERE id=? AND user_id=?').run(c.req.param('id'), c.get('principal').user.id)
        if (!result.changes) throw new EvolvedError('not_found', 'Saved prompt not found.', 404)
        return c.json({ ok: true })
    })
    return app
}
