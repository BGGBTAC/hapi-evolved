import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exchangeRunnerLease } from './runner'
import { EvolvedStore, hashToken, randomToken } from './store'

const directories: string[] = [], stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function oldDatabase() {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-runner-migration-')); directories.push(directory)
    const path = join(directory, 'state.db'), now = Date.UTC(2026, 9, 15, 12)
    const db = new Database(path, { create: true }); chmodSync(path, 0o600)
    // The persisted pre-permanent schema, including the original NOT NULL expiry
    // and capabilities' incoming lease FK. Do not create it through EvolvedStore.
    db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE evolved_users(id TEXT PRIMARY KEY,display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,is_admin INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
        CREATE TABLE evolved_teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE evolved_team_members(team_id TEXT NOT NULL REFERENCES evolved_teams(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('viewer','member','admin')),PRIMARY KEY(team_id,user_id));
        CREATE TABLE evolved_projects(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES evolved_teams(id),name TEXT NOT NULL,root_path TEXT NOT NULL DEFAULT '',profile TEXT NOT NULL DEFAULT 'restricted' CHECK(profile IN ('restricted','workspace','extended')),created_at INTEGER NOT NULL,deleting_at INTEGER);
        CREATE TABLE evolved_runner_leases(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES evolved_users(id),project_id TEXT NOT NULL REFERENCES evolved_projects(id),scopes TEXT NOT NULL,action_ids TEXT NOT NULL,profile TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
        CREATE TABLE evolved_capabilities(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES evolved_users(id),project_id TEXT NOT NULL REFERENCES evolved_projects(id),scopes TEXT NOT NULL,action_ids TEXT NOT NULL,profile TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,lease_id TEXT REFERENCES evolved_runner_leases(id));
        CREATE INDEX lease_test_expiry ON evolved_runner_leases(expires_at);
        CREATE TABLE lease_test_updates(lease_id TEXT NOT NULL,at INTEGER);
        CREATE TRIGGER lease_test_update AFTER UPDATE OF expires_at ON evolved_runner_leases BEGIN INSERT INTO lease_test_updates VALUES(NEW.id,NEW.expires_at); END;
        CREATE TABLE lease_test_children(id TEXT PRIMARY KEY,lease_id TEXT NOT NULL REFERENCES evolved_runner_leases(id) ON DELETE CASCADE);
    `)
    db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('admin', 'Admin', 1, now)
    db.prepare('INSERT INTO evolved_teams VALUES(?,?,?)').run('team', 'Team', now)
    db.exec("INSERT INTO evolved_team_members VALUES('team','admin','admin')")
    db.prepare("INSERT INTO evolved_projects VALUES('project','team','Project','','workspace',?,NULL)").run(now)
    const credentials = new Map<string, { lease: string; capability: string }>()
    for (const [id, expiresAt, revokedAt] of [['active', now + 86400_000, null], ['expired', now - 1, null], ['revoked', now + 86400_000, now - 1000]] as const) {
        const lease = randomToken(), capability = randomToken(); credentials.set(id, { lease, capability })
        db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, `${id} runner`, hashToken(lease), 'admin', 'project', '["runner:connect","git:read","git:write"]', '[]', 'workspace', now, expiresAt, revokedAt)
        db.prepare('INSERT INTO evolved_capabilities VALUES(?,?,?,?,?,?,?,?,NULL,?)').run(`cap-${id}`, hashToken(capability), 'admin', 'project', '["runner:connect","git:read","git:write"]', '[]', 'workspace', now + 300_000, id)
        db.prepare('INSERT INTO lease_test_children VALUES(?,?)').run(`child-${id}`, id)
    }
    const rows = db.query('SELECT * FROM evolved_runner_leases ORDER BY id').all()
    const caps = db.query('SELECT * FROM evolved_capabilities ORDER BY id').all()
    const childRows = db.query('SELECT * FROM lease_test_children ORDER BY id').all()
    const indexesAndTriggers = db.query("SELECT name,sql FROM sqlite_schema WHERE tbl_name='evolved_runner_leases' AND type IN ('index','trigger') ORDER BY name").all()
    const incomingForeignKeys = db.query('PRAGMA foreign_key_list(evolved_capabilities)').all()
    db.close()
    return { path, now, credentials, rows, caps, childRows, indexesAndTriggers, incomingForeignKeys }
}

describe('permanent runner schema migration', () => {
    test('preserves old rows, credentials, foreign keys, indexes and triggers and is idempotent', () => {
        const before = oldDatabase()
        const store = new EvolvedStore(before.path, { now: () => before.now }); stores.push(store)
        const db = store.db
        expect(db.query('SELECT * FROM evolved_runner_leases ORDER BY id').all()).toEqual(before.rows)
        expect(db.query('SELECT * FROM evolved_capabilities ORDER BY id').all()).toEqual(before.caps)
        expect(db.query('SELECT * FROM lease_test_children ORDER BY id').all()).toEqual(before.childRows)
        expect(db.query("SELECT name,sql FROM sqlite_schema WHERE tbl_name='evolved_runner_leases' AND type IN ('index','trigger') ORDER BY name").all()).toEqual(before.indexesAndTriggers)
        expect(db.query('PRAGMA foreign_key_list(evolved_capabilities)').all()).toEqual(before.incomingForeignKeys)
        expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
        expect(db.query('SELECT * FROM lease_test_updates').all()).toEqual([])
        expect((db.query('PRAGMA table_info(evolved_runner_leases)').all() as Array<{ name: string; notnull: number }>).find(column => column.name === 'expires_at')?.notnull).toBe(0)
        expect((db.query('PRAGMA table_info(evolved_capabilities)').all() as Array<{ name: string; notnull: number }>).find(column => column.name === 'expires_at')?.notnull).toBe(1)
        expect(store.capability(before.credentials.get('active')!.capability)).not.toBeNull()
        for (const id of ['expired', 'revoked']) {
            expect(store.capability(before.credentials.get(id)!.capability)).toBeNull()
            expect(() => exchangeRunnerLease(store, before.credentials.get(id)!.lease)).toThrow('expired or was revoked')
        }
        expect(exchangeRunnerLease(store, before.credentials.get('active')!.lease).expiresAt).toBe(before.now + 900_000)
        expect(() => db.prepare("UPDATE evolved_capabilities SET lease_id='missing' WHERE id='cap-active'").run()).toThrow('FOREIGN KEY')
        const permanent = randomToken()
        db.prepare("INSERT INTO evolved_runner_leases VALUES('permanent','Permanent runner',?,'admin','project','[\"runner:connect\"]','[]','workspace',?,NULL,NULL)").run(hashToken(permanent), before.now)
        expect(exchangeRunnerLease(store, permanent).leaseExpiresAt).toBeNull()
        db.prepare("UPDATE evolved_runner_leases SET expires_at=? WHERE id='active'").run(before.now + 3600_000)
        expect(db.query('SELECT * FROM lease_test_updates').all()).toEqual([{ lease_id: 'active', at: before.now + 3600_000 }])
        const version = db.query('PRAGMA schema_version').get()
        const repeated = new EvolvedStore(before.path, { now: () => before.now }); stores.push(repeated)
        expect(repeated.db.query('PRAGMA schema_version').get()).toEqual(version)
        expect(repeated.db.query('PRAGMA foreign_key_check').all()).toEqual([])
        expect(exchangeRunnerLease(repeated, permanent).leaseExpiresAt).toBeNull()
    })

    test('unrelated historical foreign-key violations are preserved without blocking the lease migration', () => {
        const before = oldDatabase(), legacy = new Database(before.path)
        legacy.exec(`PRAGMA foreign_keys=OFF;
            CREATE TABLE unrelated_parent(id TEXT PRIMARY KEY);
            CREATE TABLE unrelated_child(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES unrelated_parent(id));
            INSERT INTO unrelated_child VALUES('historical-row','missing-parent');`)
        const violations = legacy.query('PRAGMA foreign_key_check').all()
        expect(violations).toHaveLength(1)
        legacy.close()
        const store = new EvolvedStore(before.path, { now: () => before.now }); stores.push(store)
        expect((store.db.query('PRAGMA table_info(evolved_runner_leases)').all() as Array<{ name: string; notnull: number }>).find(column => column.name === 'expires_at')?.notnull).toBe(0)
        expect(store.db.query('SELECT * FROM evolved_runner_leases ORDER BY id').all()).toEqual(before.rows)
        expect(store.db.query('SELECT * FROM evolved_capabilities ORDER BY id').all()).toEqual(before.caps)
        expect(store.db.query('SELECT * FROM unrelated_child').all()).toEqual([{ id: 'historical-row', parent_id: 'missing-parent' }])
        expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual(violations)
        expect(store.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
        expect(store.capability(before.credentials.get('active')!.capability)).not.toBeNull()
    })

    test('a related integrity failure rolls back the expiry constraint change and preserves the old data', () => {
        const before = oldDatabase(), broken = new Database(before.path)
        broken.exec("PRAGMA foreign_keys=OFF; UPDATE evolved_capabilities SET lease_id='missing' WHERE id='cap-active'")
        const rows = broken.query('SELECT * FROM evolved_runner_leases ORDER BY id').all()
        broken.close()
        expect(() => new EvolvedStore(before.path)).toThrow('integrity check')
        const after = new Database(before.path)
        try {
            expect((after.query('PRAGMA table_info(evolved_runner_leases)').all() as Array<{ name: string; notnull: number }>).find(column => column.name === 'expires_at')?.notnull).toBe(1)
            expect(after.query('SELECT * FROM evolved_runner_leases ORDER BY id').all()).toEqual(rows)
        } finally { after.close() }
    })
})
