import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { messageContentBackfillPending, processMessageContentBackfill, scheduleMessageContentBackfill } from './messageContentSearch'
const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function dbOf(store: Store) { return (store as unknown as { db: Database }).db }
function drain(db: Database) { for(let i=0; processMessageContentBackfill(db) && i<1000; i++); expect(messageContentBackfillPending(db)).toBe(false) }
const text = (message: string) => ({ role: 'user', content: { type: 'text', text: message } })
const render = (message: string) => ({ role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'stable-render', message, streamSnapshot: true } } })

describe('bounded durable search backfill', () => {
    it('persists page progress across reopen and advertises incompleteness until finished', () => {
        const dir=mkdtempSync(join(tmpdir(),'evolved-backfill-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
        const path=join(dir,'hub.db');let store=new Store(path)
        const session=store.sessions.getOrCreateSession('history',{},null,'one')
        for(let i=0;i<180;i++)store.messages.addMessage(session.id,text(`Historical keyword ${i}`))
        scheduleMessageContentBackfill(dbOf(store));processMessageContentBackfill(dbOf(store))
        const progress=dbOf(store).prepare('SELECT cursor FROM message_content_backfill').get() as { cursor:number }
        expect(progress.cursor).toBeGreaterThan(0);expect(progress.cursor).toBeLessThanOrEqual(50)
        expect(store.messages.hasPotentiallyIncompleteContent('one','keyword')).toBe(true)
        store.close();store=new Store(path)
        try {
            const resumed=dbOf(store).prepare('SELECT cursor FROM message_content_backfill').get() as { cursor:number }
            expect(resumed.cursor).toBeGreaterThan(progress.cursor)
            drain(dbOf(store))
            expect(store.messages.searchContentInSession('keyword','one',session.id).total).toBe(180)
            expect(store.messages.hasPotentiallyIncompleteContent('one','keyword')).toBe(false)
            expect(store.messages.searchContent('keyword','other')).toEqual([])
        }finally{store.close()}
    })
    it('does not overwrite a newer live snapshot or resurrect deleted messages', () => {
        const store=new Store(':memory:');cleanup.push(()=>store.close());const db=dbOf(store)
        const session=store.sessions.getOrCreateSession('live',{},null,'one')
        const old=store.messages.addMessage(session.id,render('old obsolete version'))
        const removed=store.messages.addMessage(session.id,text('deleted private needle'))
        scheduleMessageContentBackfill(db)
        const live=store.messages.addMessage(session.id,render('new definitive version'))
        db.prepare('DELETE FROM messages WHERE id=?').run(removed.id)
        drain(db)
        expect(store.messages.searchContent('definitive','one')[0]?.messageId).toBe(live.id)
        expect(store.messages.searchContent('obsolete','one')).toEqual([])
        expect(store.messages.searchContent('deleted','one')).toEqual([])
        expect(db.prepare('SELECT 1 FROM messages WHERE id=?').get(old.id)).not.toBeNull()
    })
    it('rolls back failed index pages and resumes after a transient write failure', () => {
        const store=new Store(':memory:');cleanup.push(()=>store.close());const db=dbOf(store)
        const session=store.sessions.getOrCreateSession('retry',{},null,'one')
        store.messages.addMessage(session.id,text('retryable index keyword'))
        scheduleMessageContentBackfill(db);processMessageContentBackfill(db)
        db.exec("CREATE TRIGGER index_failure BEFORE INSERT ON message_content_search_lookup BEGIN SELECT RAISE(ABORT,'synthetic full disk'); END")
        expect(()=>processMessageContentBackfill(db)).toThrow('synthetic full disk')
        expect((db.prepare('SELECT cursor FROM message_content_backfill').get() as {cursor:number}).cursor).toBe(0)
        db.exec('DROP TRIGGER index_failure');drain(db)
        expect(store.messages.searchContent('retryable','one')).toHaveLength(1)
    })
})
