import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { allocateWorkspace, assertWorkspaceMountIsolation, existingWorkspace, openManagedWorkspaceRoot, workspaceBindingsOverlap } from './workspaces'
export { canonicalWorkspace } from './workspaces'

export type ProjectRole = 'viewer' | 'member' | 'admin'
export type AgentProfile = 'restricted' | 'workspace' | 'extended'
export type EvolvedUser = { id: string; displayName: string; isAdmin: boolean }
export type EvolvedProject = { id: string; teamId: string; name: string; rootPath: string; root: string; namespace: string; profile: AgentProfile; role: ProjectRole }
export type EvolvedPrincipal = { user: EvolvedUser; accessibleProjects: EvolvedProject[]; capability?: { id: string; projectId: string; scopes: string[]; actionIds: string[]; expiresAt: number; leaseId?: string } }
export class EvolvedError extends Error {
    constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'EvolvedError' }
}
export function hashToken(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function randomToken(): string { return randomBytes(32).toString('base64url') }
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, admin: 2 }

/** These files are operator credentials. Refuse links and permissive files, rather than silently changing ownership. */
export function privateFile(path: string, initial?: Uint8Array | string): Buffer {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (initial !== undefined) {
        try {
            const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try { writeFileSync(fd, initial) } finally { closeSync(fd) }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || (process.getuid && st.uid !== process.getuid())) {
            throw new EvolvedError('insecure_file', 'Private credential file must be owned by this service and have mode 0600.', 500)
        }
        if (st.size > 4096) throw new EvolvedError('invalid_file', 'Private credential file is too large.', 500)
        return readFileSync(fd)
    } finally { closeSync(fd) }
}

type UserRow = { id: string; display_name: string; is_admin: number }
type Enrollment = { token_hash: string; user_id: string; display_name: string; is_admin: number; team_id: string | null; role: ProjectRole; expires_at: number; consumed_at: number | null }
type Challenge = { id: string; challenge: string; kind: string; user_id: string | null; enrollment_hash: string | null; binding_hash: string; expires_at: number }
export type PasskeyRow = { id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string }

export class EvolvedStore {
    readonly db: Database
    readonly bootstrapFile?: string
    readonly managedWorkspaceRoot: string
    private readonly ephemeralWorkspaces: string[] | null
    constructor(dbPath: string, options: { bootstrapFile?: string; now?: () => number; managedWorkspaceRoot?: string } = {}) {
        this.now = options.now ?? Date.now
        this.bootstrapFile = options.bootstrapFile
        this.ephemeralWorkspaces = dbPath === ':memory:' && !options.managedWorkspaceRoot ? [] : null
        this.managedWorkspaceRoot = options.managedWorkspaceRoot ?? (dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'evolved-workspaces-')) : join(dirname(resolve(dbPath)), 'project-workspaces'))
        if (dbPath !== ':memory:') {
            mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
            const fd = openSync(dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
            const info = fstatSync(fd)
            closeSync(fd)
            if (!info.isFile() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
                throw new EvolvedError('insecure_database', 'Evolved database requires a private regular file.', 500)
            }
        }
        this.db = new Database(dbPath, { create: true, strict: true })
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS evolved_users(id TEXT PRIMARY KEY,display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,is_admin INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS evolved_passkeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,public_key BLOB NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS evolved_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,strength TEXT NOT NULL DEFAULT 'passkey');
            CREATE TABLE IF NOT EXISTS evolved_recovery_codes(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,used_at INTEGER);
            CREATE TABLE IF NOT EXISTS evolved_enrollments(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,display_name TEXT NOT NULL,is_admin INTEGER NOT NULL,team_id TEXT,role TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER);
            CREATE TABLE IF NOT EXISTS evolved_setup(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,consumed_at INTEGER);
            CREATE TABLE IF NOT EXISTS evolved_challenges(id TEXT PRIMARY KEY,challenge TEXT NOT NULL,kind TEXT NOT NULL,user_id TEXT,enrollment_hash TEXT,binding_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS evolved_teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS evolved_team_members(team_id TEXT NOT NULL REFERENCES evolved_teams(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('viewer','member','admin')),PRIMARY KEY(team_id,user_id));
            CREATE TABLE IF NOT EXISTS evolved_projects(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES evolved_teams(id),name TEXT NOT NULL,root_path TEXT NOT NULL DEFAULT '',profile TEXT NOT NULL DEFAULT 'restricted' CHECK(profile IN ('restricted','workspace','extended')),created_at INTEGER NOT NULL,deleting_at INTEGER);
            CREATE TABLE IF NOT EXISTS evolved_project_roles(project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('viewer','member','admin')),PRIMARY KEY(project_id,user_id));
            CREATE TABLE IF NOT EXISTS evolved_runner_leases(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES evolved_users(id),project_id TEXT NOT NULL REFERENCES evolved_projects(id),scopes TEXT NOT NULL,action_ids TEXT NOT NULL,profile TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
            CREATE TABLE IF NOT EXISTS evolved_capabilities(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES evolved_users(id),project_id TEXT NOT NULL REFERENCES evolved_projects(id),scopes TEXT NOT NULL,action_ids TEXT NOT NULL,profile TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,lease_id TEXT REFERENCES evolved_runner_leases(id));
            CREATE TABLE IF NOT EXISTS evolved_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,project_id TEXT,action TEXT NOT NULL,target_id TEXT,created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS evolved_sessions_expiry ON evolved_sessions(expires_at);
            CREATE INDEX IF NOT EXISTS evolved_challenges_expiry ON evolved_challenges(expires_at);
        `)
        if (options.bootstrapFile && !this.initialized()) this.ensureBootstrap(options.bootstrapFile)
    }
    readonly now: () => number
    close(): void {
        this.db.close()
        // In-memory stores have no persistent project records. Remove only their empty test folders.
        if (this.ephemeralWorkspaces) {
            for (const path of [...this.ephemeralWorkspaces, this.managedWorkspaceRoot]) { try { rmdirSync(path) } catch { /* Never remove contents. */ } }
        }
    }
    initialized(): boolean { return !!this.db.prepare('SELECT 1 FROM evolved_users LIMIT 1').get() }
    private ensureBootstrap(path: string): void {
        const raw = privateFile(path, randomToken()).toString('utf8').trim()
        if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new EvolvedError('invalid_bootstrap_file', 'Invalid bootstrap credential file.', 500)
        this.db.prepare('INSERT OR IGNORE INTO evolved_setup VALUES(?,?,NULL)').run(hashToken(raw), this.now() + 24 * 3600_000)
    }
    audit(userId: string | null, projectId: string | null, action: string, targetId: string | null = null): void {
        this.db.prepare('INSERT INTO evolved_audit(user_id,project_id,action,target_id,created_at) VALUES(?,?,?,?,?)').run(userId, projectId, action, targetId, this.now())
    }
    user(id: string): EvolvedUser | null {
        const row = this.db.prepare('SELECT * FROM evolved_users WHERE id=?').get(id) as UserRow | null
        return row ? { id: row.id, displayName: row.display_name, isAdmin: !!row.is_admin } : null
    }
    userByName(name: string): EvolvedUser | null {
        const row = this.db.prepare('SELECT id FROM evolved_users WHERE display_name=? COLLATE NOCASE').get(name) as { id: string } | null
        return row ? this.user(row.id) : null
    }
    getPrincipal(userId: string): EvolvedPrincipal | null {
        const user = this.user(userId)
        return user ? { user, accessibleProjects: this.listProjects(userId) } : null
    }
    listProjects(userId: string, includeDeleting = false): EvolvedProject[] {
        const rows = this.db.prepare(`SELECT p.*,COALESCE(r.role,m.role) AS role FROM evolved_projects p
            JOIN evolved_team_members m ON m.team_id=p.team_id AND m.user_id=?
            LEFT JOIN evolved_project_roles r ON r.project_id=p.id AND r.user_id=m.user_id WHERE (?=1 OR p.deleting_at IS NULL) ORDER BY p.name,p.id`).all(userId, includeDeleting ? 1 : 0) as Array<{ id: string; team_id: string; name: string; root_path: string; profile: AgentProfile; role: ProjectRole }>
        return rows.map(r => ({ id: r.id, teamId: r.team_id, name: r.name, rootPath: r.root_path, root: r.root_path, namespace: `evolved-${r.id}`, profile: r.profile, role: r.role }))
    }
    listProjectsForService(): Array<Omit<EvolvedProject, 'role'>> {
        return (this.db.prepare('SELECT * FROM evolved_projects WHERE deleting_at IS NULL').all() as Array<{ id: string; team_id: string; name: string; root_path: string; profile: AgentProfile }>).map(r => ({ id: r.id, teamId: r.team_id, name: r.name, rootPath: r.root_path, root: r.root_path, namespace: `evolved-${r.id}`, profile: r.profile }))
    }
    requireProject(userId: string, projectId: string, minRole: ProjectRole = 'viewer'): EvolvedProject {
        const project = this.listProjects(userId).find(p => p.id === projectId)
        if (!project || ROLE_RANK[project.role] < ROLE_RANK[minRole]) throw new EvolvedError('forbidden', 'Project access denied.', 403)
        return project
    }
    requireTeam(userId: string, teamId: string, minRole: ProjectRole = 'viewer'): ProjectRole {
        const row = this.db.prepare('SELECT role FROM evolved_team_members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: ProjectRole } | null
        if (!row || ROLE_RANK[row.role] < ROLE_RANK[minRole]) throw new EvolvedError('forbidden', 'Team access denied.', 403)
        return row.role
    }
    listTeams(userId: string): Array<{ id: string; name: string; role: ProjectRole }> {
        return this.db.prepare('SELECT t.id,t.name,m.role FROM evolved_teams t JOIN evolved_team_members m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.name').all(userId) as Array<{ id: string; name: string; role: ProjectRole }>
    }
    createTeam(userId: string, name: string): { id: string; name: string; role: ProjectRole } {
        if (!this.user(userId)) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        return this.db.transaction(() => {
            const id = randomUUID()
            this.db.prepare('INSERT INTO evolved_teams VALUES(?,?,?)').run(id, name, this.now())
            this.db.prepare('INSERT INTO evolved_team_members VALUES(?,?,?)').run(id, userId, 'admin')
            this.audit(userId, null, 'team.created', id)
            return { id, name, role: 'admin' as const }
        })()
    }
    setMember(actor: string, teamId: string, userId: string, role: ProjectRole | null): void {
        this.db.transaction(() => {
            this.requireTeam(actor, teamId, 'admin')
            if (!this.user(userId)) throw new EvolvedError('not_found', 'User not found.', 404)
            const prior = this.db.prepare('SELECT role FROM evolved_team_members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: ProjectRole } | null
            if (prior?.role === 'admin' && role !== 'admin') {
                const admins = this.db.prepare("SELECT COUNT(*) AS n FROM evolved_team_members WHERE team_id=? AND role='admin'").get(teamId) as { n: number }
                if (admins.n < 2) throw new EvolvedError('last_admin', 'A team must retain an administrator.', 409)
            }
            if (role === null) {
                this.db.prepare('DELETE FROM evolved_team_members WHERE team_id=? AND user_id=?').run(teamId, userId)
                // A later invitation must not resurrect privileges from a removed membership.
                this.db.prepare('DELETE FROM evolved_project_roles WHERE user_id=? AND project_id IN (SELECT id FROM evolved_projects WHERE team_id=?)').run(userId, teamId)
            }
            else this.db.prepare('INSERT INTO evolved_team_members VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role').run(teamId, userId, role)
            const orphan = this.db.prepare(`SELECT p.id FROM evolved_projects p WHERE p.team_id=? AND NOT EXISTS (
                SELECT 1 FROM evolved_team_members m LEFT JOIN evolved_project_roles r ON r.project_id=p.id AND r.user_id=m.user_id
                WHERE m.team_id=p.team_id AND COALESCE(r.role,m.role)='admin') LIMIT 1`).get(teamId)
            if (orphan) throw new EvolvedError('last_admin', 'Every project must retain an administrator.', 409)
            this.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE user_id=? AND project_id IN (SELECT id FROM evolved_projects WHERE team_id=?)').run(this.now(), userId, teamId)
            this.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND project_id IN (SELECT id FROM evolved_projects WHERE team_id=?)').run(this.now(), userId, teamId)
            this.audit(actor, null, role === null ? 'member.removed' : 'member.updated', userId)
        })()
    }
    createProject(userId: string, teamId: string, name: string, rootPath = ''): EvolvedProject {
        this.requireTeam(userId, teamId, 'admin')
        if (rootPath && !this.user(userId)?.isAdmin) throw new EvolvedError('workspace_admin_required', 'Only the installation administrator can attach a workspace.', 403)
        const id = randomUUID()
        const managed = rootPath ? null : openManagedWorkspaceRoot(this.managedWorkspaceRoot)
        let allocated: ReturnType<typeof allocateWorkspace> | undefined
        try {
            return this.db.transaction(() => {
                this.requireTeam(userId, teamId, 'admin')
                if (rootPath) {
                    rootPath = existingWorkspace(rootPath)
                    assertWorkspaceMountIsolation(rootPath)
                    if (workspaceBindingsOverlap(rootPath, resolve(this.managedWorkspaceRoot))) throw new EvolvedError('workspace_conflict', 'Managed project directories cannot be attached manually.', 409)
                } else {
                    allocated = allocateWorkspace(managed!, id)
                    rootPath = allocated.path
                }
                // Include deleting projects until their purge commits. Serialize competing binds.
                const existing = this.db.prepare("SELECT root_path FROM evolved_projects WHERE root_path<>''").all() as Array<{ root_path: string }>
                if (existing.some(row => workspaceBindingsOverlap(rootPath, row.root_path))) throw new EvolvedError('workspace_conflict', 'Workspace overlaps an existing project.', 409)
                this.db.prepare('INSERT INTO evolved_projects(id,team_id,name,root_path,created_at) VALUES(?,?,?,?,?)').run(id, teamId, name, rootPath, this.now())
                this.audit(userId, id, 'project.created', id)
                const project = this.requireProject(userId, id)
                if (allocated) this.ephemeralWorkspaces?.push(allocated.path)
                return project
            }).immediate()
        } catch (error) { allocated?.rollback(); throw error }
        finally { if (managed) closeSync(managed.fd) }
    }
    setProfile(userId: string, projectId: string, profile: AgentProfile): EvolvedProject {
        this.requireProject(userId, projectId, 'admin')
        this.db.transaction(() => {
            this.db.prepare('UPDATE evolved_projects SET profile=? WHERE id=?').run(profile, projectId)
            this.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE project_id=?').run(this.now(), projectId)
            this.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE project_id=?').run(this.now(), projectId)
            this.audit(userId, projectId, 'profile.changed', projectId)
        })()
        return this.requireProject(userId, projectId)
    }
    issueInvitation(actor: string, teamId: string, name: string, role: ProjectRole): { token: string; expiresAt: number } {
        this.requireTeam(actor, teamId, 'admin')
        if (this.userByName(name)) throw new EvolvedError('name_taken', 'Account name is already in use.', 409)
        const token = randomToken(), expiresAt = this.now() + 24 * 3600_000
        this.db.prepare('INSERT INTO evolved_enrollments VALUES(?,?,?,?,?,?,?,NULL)').run(hashToken(token), randomUUID(), name, 0, teamId, role, expiresAt)
        this.audit(actor, null, 'invitation.created', teamId)
        return { token, expiresAt }
    }
    exchangeEnrollment(token: string, name: string): string {
        return this.db.transaction(() => {
            const digest = hashToken(token)
            const invite = this.db.prepare('SELECT * FROM evolved_enrollments WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').get(digest, this.now()) as Enrollment | null
            const enrollmentToken = randomToken()
            if (invite) {
                this.db.prepare('UPDATE evolved_enrollments SET consumed_at=? WHERE token_hash=?').run(this.now(), digest)
                this.db.prepare('INSERT INTO evolved_enrollments VALUES(?,?,?,?,?,?,?,NULL)').run(hashToken(enrollmentToken), invite.user_id, invite.display_name, 0, invite.team_id, invite.role, this.now() + 10 * 60_000)
                return enrollmentToken
            }
            if (this.initialized()) throw new EvolvedError('invalid_enrollment', 'Invalid or expired enrollment credential.', 401)
            const consumed = this.db.prepare('UPDATE evolved_setup SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').run(this.now(), digest, this.now())
            if (consumed.changes !== 1) throw new EvolvedError('invalid_enrollment', 'Invalid or expired enrollment credential.', 401)
            this.db.prepare('INSERT INTO evolved_enrollments VALUES(?,?,?,?,NULL,?,?,NULL)').run(hashToken(enrollmentToken), randomUUID(), name, 1, 'admin', this.now() + 10 * 60_000)
            return enrollmentToken
        })()
    }
    enrollment(token: string): Enrollment | null {
        return this.db.prepare('SELECT * FROM evolved_enrollments WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').get(hashToken(token), this.now()) as Enrollment | null
    }
    saveChallenge(challenge: string, kind: string, binding: string, userId: string | null, enrollmentHash: string | null): string {
        this.db.prepare('DELETE FROM evolved_challenges WHERE expires_at<=?').run(this.now())
        const id = randomToken()
        this.db.prepare('INSERT INTO evolved_challenges VALUES(?,?,?,?,?,?,?)').run(id, challenge, kind, userId, enrollmentHash, hashToken(binding), this.now() + 5 * 60_000)
        return id
    }
    consumeChallenge(id: string, kind: string, binding: string): Challenge {
        const row = this.db.prepare('DELETE FROM evolved_challenges WHERE id=? AND kind=? AND binding_hash=? AND expires_at>? RETURNING *').get(id, kind, hashToken(binding), this.now()) as Challenge | null
        if (!row) throw new EvolvedError('invalid_challenge', 'Challenge expired or already used.', 401)
        return row
    }
    passkeys(userId: string): PasskeyRow[] { return this.db.prepare('SELECT * FROM evolved_passkeys WHERE user_id=?').all(userId) as PasskeyRow[] }
    passkey(id: string): PasskeyRow | null { return this.db.prepare('SELECT * FROM evolved_passkeys WHERE id=?').get(id) as PasskeyRow | null }
    finishRegistration(input: { userId: string; enrollmentHash: string | null; credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } }): { userId: string; recoveryCodes?: string[] } {
        return this.db.transaction(() => {
            let newUser = false
            if (input.enrollmentHash) {
                const enrollment = this.db.prepare('DELETE FROM evolved_enrollments WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING *').get(input.enrollmentHash, this.now()) as Enrollment | null
                if (!enrollment || enrollment.user_id !== input.userId || (enrollment.is_admin && this.initialized())) throw new EvolvedError('invalid_enrollment', 'Enrollment is no longer valid.', 401)
                this.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(input.userId, enrollment.display_name, enrollment.is_admin, this.now())
                if (enrollment.team_id) this.db.prepare('INSERT INTO evolved_team_members VALUES(?,?,?)').run(enrollment.team_id, input.userId, enrollment.role)
                newUser = true
            } else if (!this.user(input.userId)) throw new EvolvedError('unauthorized', 'Account unavailable.', 401)
            const key = input.credential
            this.db.prepare('INSERT INTO evolved_passkeys VALUES(?,?,?,?,?,?)').run(key.id, input.userId, key.publicKey, key.counter, JSON.stringify(key.transports ?? []), this.now())
            this.audit(input.userId, null, 'passkey.registered', key.id)
            return { userId: input.userId, ...(newUser ? { recoveryCodes: this.rotateRecoveryCodes(input.userId) } : {}) }
        })()
    }
    createSession(userId: string, strength: 'passkey' | 'recovery' = 'passkey'): string {
        const token = randomToken()
        this.db.prepare('DELETE FROM evolved_sessions WHERE expires_at<=?').run(this.now())
        this.db.prepare('INSERT INTO evolved_sessions VALUES(?,?,?,?,?)').run(hashToken(token), userId, this.now(), this.now() + 12 * 3600_000, strength)
        return token
    }
    session(token: string): EvolvedPrincipal | null {
        return this.getSessionByHash(hashToken(token))
    }
    getSessionByHash(digest: string): EvolvedPrincipal | null {
        const row = this.db.prepare('SELECT user_id FROM evolved_sessions WHERE token_hash=? AND expires_at>?').get(digest, this.now()) as { user_id: string } | null
        return row ? this.getPrincipal(row.user_id) : null
    }
    isFreshPasskey(token: string): boolean {
        return !!this.db.prepare("SELECT 1 FROM evolved_sessions WHERE token_hash=? AND strength='passkey' AND created_at>? AND expires_at>?").get(hashToken(token), this.now() - 5 * 60_000, this.now())
    }
    canEnrollPasskey(token: string): boolean {
        return this.isFreshPasskey(token) || !!this.db.prepare("SELECT 1 FROM evolved_sessions WHERE token_hash=? AND strength='recovery' AND created_at>? AND expires_at>?").get(hashToken(token), this.now() - 10 * 60_000, this.now())
    }
    revokeSession(token: string): void { this.db.prepare('DELETE FROM evolved_sessions WHERE token_hash=?').run(hashToken(token)) }
    rotateRecoveryCodes(userId: string): string[] {
        return this.db.transaction(() => {
            this.db.prepare('DELETE FROM evolved_recovery_codes WHERE user_id=?').run(userId)
            const codes = Array.from({ length: 10 }, () => randomBytes(20).toString('hex').match(/.{1,8}/g)!.join('-'))
            for (const code of codes) this.db.prepare('INSERT INTO evolved_recovery_codes VALUES(?,?,NULL)').run(hashToken(code), userId)
            this.audit(userId, null, 'recovery_codes.rotated')
            return codes
        })()
    }
    recover(name: string, code: string): EvolvedUser {
        return this.db.transaction(() => {
            const user = this.userByName(name)
            const row = user && this.db.prepare('UPDATE evolved_recovery_codes SET used_at=? WHERE code_hash=? AND user_id=? AND used_at IS NULL').run(this.now(), hashToken(code.trim().toLowerCase()), user.id)
            if (!user || !row || row.changes !== 1) throw new EvolvedError('invalid_recovery', 'Invalid recovery credential.', 401)
            this.db.prepare('DELETE FROM evolved_sessions WHERE user_id=?').run(user.id)
            this.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE user_id=?').run(this.now(), user.id)
            this.db.prepare('UPDATE evolved_runner_leases SET revoked_at=? WHERE user_id=?').run(this.now(), user.id)
            this.audit(user.id, null, 'account.recovered')
            return user
        })()
    }
    issueCapability(userId: string, projectId: string, scopes: string[], actionIds: string[], ttl: number, leaseId: string | null = null): { id: string; token: string; expiresAt: number } {
        const project = this.requireProject(userId, projectId, 'admin')
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 900) throw new EvolvedError('invalid_lifetime', 'Capability lifetime must not exceed 15 minutes.')
        this.db.prepare('DELETE FROM evolved_capabilities WHERE expires_at<=?').run(this.now())
        const id = randomUUID(), token = randomToken(), expiresAt = this.now() + ttl * 1000
        this.db.prepare('INSERT INTO evolved_capabilities VALUES(?,?,?,?,?,?,?,?,NULL,?)').run(id, hashToken(token), userId, projectId, JSON.stringify(scopes), JSON.stringify(actionIds), project.profile, expiresAt, leaseId)
        this.audit(userId, projectId, 'capability.created', id)
        return { id, token, expiresAt }
    }
    capability(token: string): EvolvedPrincipal | null {
        const row = this.db.prepare('SELECT * FROM evolved_capabilities WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hashToken(token), this.now()) as { id: string; user_id: string; project_id: string; scopes: string; action_ids: string; profile: string; expires_at: number; lease_id: string | null } | null
        if (!row) return null
        const principal = this.getPrincipal(row.user_id)
        const project = principal?.accessibleProjects.find(p => p.id === row.project_id)
        if (!principal || !project || project.profile !== row.profile || project.role !== 'admin') return null
        if (row.lease_id) {
            const lease = this.db.prepare('SELECT 1 FROM evolved_runner_leases WHERE id=? AND user_id=? AND project_id=? AND profile=? AND revoked_at IS NULL AND expires_at>?').get(row.lease_id, row.user_id, row.project_id, row.profile, this.now())
            if (!lease || project.role !== 'admin') return null
        }
        return { user: principal.user, accessibleProjects: [project], capability: { id: row.id, projectId: row.project_id, scopes: JSON.parse(row.scopes), actionIds: JSON.parse(row.action_ids), expiresAt: row.expires_at, ...(row.lease_id ? { leaseId: row.lease_id } : {}) } }
    }
}
