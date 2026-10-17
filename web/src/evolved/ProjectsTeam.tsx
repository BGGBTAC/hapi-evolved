import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved, enrollPasskey, RecoveryCodes } from './auth'
import { isProjectAdmin, projectPath, type ExecutionProfile, type ProjectRole, type Team, type TeamMember } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'
import { CapacityPanel } from './Capacity'
import { defaultDevelopmentSettings, DEVELOPMENT_MODES, ODOO_MAJORS, type DevelopmentMode, type OdooMajor } from '@hapi/protocol/evolvedDevelopment'
import { SegmentedChoice } from './DevelopmentModePicker'
import { DevelopmentOverviewCard } from './ProjectDevelopment'
import { modeHints, modeLabels } from './developmentApi'

const profiles: { id: ExecutionProfile; label: string; description: string }[] = [
    { id: 'restricted', label: 'Eingeschränkt', description: 'Schreib- und Ausführungsrechte bleiben eng begrenzt.' },
    { id: 'workspace', label: 'Arbeitsbereich', description: 'Projektbezogene Arbeit mit Freigaben für zusätzliche Rechte.' },
    { id: 'extended', label: 'Erweitert', description: 'Erweiterte Ausführung. Nur für ausdrücklich freigegebene Projekte.' },
]
const roles: ProjectRole[] = ['admin', 'member', 'viewer']
const roleNames: Record<string, string> = { admin: 'Administrator', member: 'Mitglied', viewer: 'Lesend' }

type WorkspaceFolder = { path: string; name: string; selectable: boolean }
type WorkspaceListing = { roots: WorkspaceFolder[]; path: string | null; directories: WorkspaceFolder[]; hasMore: boolean; nextOffset?: number }

function WorkspacePicker({ disabled, onChoose }: { disabled: boolean; onChoose: (path: string) => void }) {
    const { api, me } = useEvolved()
    const [history, setHistory] = useState<(string | null)[]>([null])
    const [pages, setPages] = useState([0])
    const path = history[history.length - 1]
    const offset = pages[pages.length - 1]
    const listing = useQuery({
        queryKey: ['evolved', 'workspaces', api.baseUrl, me.user.id, path, offset],
        enabled: me.user.isAdmin,
        retry: false,
        gcTime: 0,
        queryFn: ({ signal }) => api.request<WorkspaceListing>(path === null ? '/workspaces' : `/workspaces?${new URLSearchParams({ path, limit: '50', offset: String(offset) })}`, { signal }),
    })
    // Do not display a cached listing while rechecking access, or after a denied refresh.
    const data = !listing.error && !listing.isFetching ? listing.data : undefined
    const folders = data?.path === null ? data.roots : data?.directories
    const busy = disabled || listing.isFetching
    return <div className="ev-workspace-picker" role="group" aria-label="Ordner auf dem Server auswählen">
        <p className="ev-muted">Wähle ein vorhandenes, freigegebenes Verzeichnis auf dem Server.</p>
        <div className="ev-actions">
            {history.length > 1 && <button type="button" disabled={busy} onClick={() => { setHistory(previous => previous.slice(0, -1)); setPages([0]) }}>Zurück</button>}
            <button type="button" disabled={busy} onClick={() => void listing.refetch()}>Ordnerliste aktualisieren</button>
        </div>
        {path && !listing.error && <p className="ev-workspace-path"><code>{path}</code></p>}
        <ErrorNotice error={listing.error} />
        {listing.error && <button type="button" disabled={busy} onClick={() => void listing.refetch()}>Erneut versuchen</button>}
        {listing.isFetching && <Loading />}
        {data && <>
            {!folders?.length && <Empty>{path === null ? 'Keine manuell auswählbaren Ordner freigegeben. Du kannst das Projekt automatisch anlegen.' : 'Keine auswählbaren Unterordner auf dieser Seite.'}</Empty>}
            <div className="ev-list">{folders?.map(folder => <div className="ev-row" key={folder.path}>
                <div><strong>{folder.name}</strong><small>{folder.path}</small>{!folder.selectable && <small>Nur zum Durchsuchen.</small>}</div>
                <div className="ev-actions">
                    <button type="button" aria-label={`${folder.name} öffnen`} disabled={busy} onClick={() => { setHistory(previous => [...previous, folder.path]); setPages([0]) }}>Öffnen</button>
                    <button type="button" aria-label={`${folder.name} verwenden`} disabled={busy || !folder.selectable} onClick={() => onChoose(folder.path)}>Verwenden</button>
                </div>
            </div>)}</div>
            <div className="ev-actions">
                {pages.length > 1 && <button type="button" disabled={busy} onClick={() => setPages(previous => previous.slice(0, -1))}>Vorherige Seite</button>}
                {data.hasMore && data.nextOffset !== undefined && <button type="button" disabled={busy} onClick={() => setPages(previous => [...previous, data.nextOffset!])}>Weitere Ordner</button>}
            </div>
        </>}
    </div>
}

export function ProjectsPanel({ onSelectProject }: { onSelectProject?: (id: string) => void } = {}) {
    const { api, me } = useEvolved()
    // A changed account or installation-admin role must discard drafts and directory listings.
    return <ProjectsForUser key={`${api.baseUrl}:${me.user.id}:${me.user.isAdmin}`} onSelectProject={onSelectProject} />
}

function ProjectsForUser({ onSelectProject }: { onSelectProject?: (id: string) => void }) {
    const { api, me, project, selectProject, refresh } = useEvolved()
    const teams = useQuery({ queryKey: ['evolved', 'teams', api.baseUrl, me.user.id], queryFn: ({ signal }) => api.request<{ teams: Team[] }>('/teams', { signal }) })
    const [name, setName] = useState('')
    const [rootPath, setRootPath] = useState('')
    const [manual, setManual] = useState(false)
    const [showPicker, setShowPicker] = useState(false)
    const [teamId, setTeamId] = useState('')
    const [projectFilter, setProjectFilter] = useState('')
    const [developmentMode, setDevelopmentMode] = useState<DevelopmentMode>('none')
    const [odooMajor, setOdooMajor] = useState<OdooMajor>(20)
    const creating = useRef(false)
    const creation = useRef<AbortController | null>(null)
    useEffect(() => () => creation.current?.abort(), [])
    const action = useAction()
    const adminTeams = teams.data?.teams.filter(team => isProjectAdmin(team.role)) ?? []
    const selectedTeam = adminTeams.find(team => team.id === teamId)?.id ?? adminTeams[0]?.id
    const useManualPath = me.user.isAdmin && manual
    const canFilter = me.accessibleProjects.length > 4
    const visibleProjects = canFilter && projectFilter.trim()
        ? me.accessibleProjects.filter(item => item.name.toLocaleLowerCase().includes(projectFilter.trim().toLocaleLowerCase()))
        : me.accessibleProjects
    const createProject = () => {
        if (creating.current || action.busy) return
        creating.current = true
        const controller = new AbortController()
        creation.current = controller
        void action.run(async () => {
            if (!name.trim() || !selectedTeam || teams.error) throw new Error('Bitte Projektname und ein verwaltbares Team wählen.')
            if (useManualPath && !rootPath.trim()) throw new Error('Bitte einen Projektordner angeben oder die manuelle Auswahl ausschalten.')
            // Creation mode is validated by the hub before the project exists; repositories are bound later.
            const settings = defaultDevelopmentSettings(developmentMode)
            if (settings.odoo) settings.odoo = { ...settings.odoo, major: odooMajor }
            await api.request('/projects', { method: 'POST', body: { name: name.trim(), teamId: selectedTeam, ...(useManualPath ? { rootPath: rootPath.trim() } : {}), ...(developmentMode !== 'none' ? { development: { settings } } : {}) }, signal: controller.signal })
            controller.signal.throwIfAborted()
            setName(''); setRootPath(''); setManual(false); setShowPicker(false); setTeamId(''); setDevelopmentMode('none'); setOdooMajor(20)
            await refresh()
        }, 'Projekt angelegt.').finally(() => { creating.current = false; if (creation.current === controller) creation.current = null })
    }
    return <div className="ev-stack ew-projects"><Panel title="Deine Projekte" description="Jedes Projekt hat eigene Zugriffsrechte, einen Tresor und ein Gedächtnis.">
        {canFilter && <div className="ew-project-filter"><Field label="Projekte durchsuchen"><input type="search" value={projectFilter} onChange={event => setProjectFilter(event.target.value)} placeholder="Projektname" /></Field><span className="ew-caption" role="status">{visibleProjects.length} von {me.accessibleProjects.length} Projekten</span>{projectFilter && <button onClick={() => setProjectFilter('')}>Filter zurücksetzen</button>}</div>}
        {me.accessibleProjects.length === 0 ? <Empty>Lege zuerst ein Team und anschließend ein Projekt an.</Empty> : !visibleProjects.length ? <Empty>Kein Projekt passt zu deiner Suche. Setze den Filter zurück, um alle Projekte anzuzeigen.</Empty> : <div className="ev-project-grid">{visibleProjects.map(item => <button key={item.id} className={`ev-project-card ${project?.id === item.id ? 'ev-selected' : ''}`} onClick={() => (onSelectProject ?? selectProject)(item.id)} aria-pressed={project?.id === item.id} aria-label={`${item.name} ${roleNames[item.role] ?? item.role} · ${profiles.find(profile => profile.id === item.profile)?.label ?? item.profile}`}>
            <span className="ew-project-card-top"><span className="ew-project-initial" aria-hidden="true">{item.name.slice(0, 1).toLocaleUpperCase()}</span><span className="ew-caption">{project?.id === item.id ? 'Aktives Projekt' : 'Projekt öffnen'}</span></span><strong>{item.name}</strong><span>{roleNames[item.role] ?? item.role} · {profiles.find(profile => profile.id === item.profile)?.label ?? item.profile}</span>{item.rootPath && <small>{item.rootPath}</small>}
        </button>)}</div>}
    </Panel>
    {project && me.accessibleProjects.some(item => item.id === project.id) && <CapacityPanel compact />}
    {project && <Panel title="Ausführungsprofil" description="Das Profil gilt für das gesamte Projekt. Ein Wechsel verändert die Schreib- und Ausführungsrechte und macht alle bisherigen Runner-Zugänge ungültig. Stelle danach neue Zugänge aus und richte die Runner mit dem passenden Profil ein. Gespeicherte GitHub-Repository-Freigaben bleiben erhalten; Push benötigt zusätzlich ein schreibfähiges Profil, Runner-Schreibrechte und passende GitHub-Tokenrechte. Nur Projektadministratoren können das Profil ändern."><div className="ev-profile-grid">{profiles.map(profile => <button key={profile.id} className={`ev-profile ${project.profile === profile.id ? 'ev-selected' : ''}`} aria-pressed={project.profile === profile.id} disabled={!isProjectAdmin(project.role) || action.busy || project.profile === profile.id} onClick={() => void action.run(async () => {
        await api.request(`${projectPath(project.id)}/profile`, { method: 'PUT', body: { profile: profile.id } }); await refresh()
    }, 'Profil gespeichert.')}><strong>{profile.label}</strong><small>{profile.description}</small></button>)}</div></Panel>}
    {project && me.accessibleProjects.some(item => item.id === project.id) && <DevelopmentOverviewCard key={`${project.id}:${project.role}:${project.profile}`} />}
    <ErrorNotice error={teams.error} />
    {teams.isPending ? <Loading /> : !teams.error && adminTeams.length > 0 && <Panel title="Projekt anlegen"><form className="ev-form-grid" onSubmit={submit(createProject)}>
        <Field label="Projektname"><input value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={action.busy} /></Field>
        <Field label="Team"><select value={selectedTeam} onChange={event => setTeamId(event.target.value)} disabled={action.busy}>{adminTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field>
        <div className="ev-form-wide"><span className="ev-dev-field-label">Entwicklungsmodus</span>
            <SegmentedChoice legend="Entwicklungsmodus" variant="modes" options={DEVELOPMENT_MODES.map(mode => ({ id: mode, label: modeLabels[mode] }))} value={developmentMode} disabled={action.busy} onChange={setDevelopmentMode} />
            {developmentMode === 'odoo' && <div style={{ marginTop: 10 }}><span className="ev-dev-field-label">Odoo-Version</span><SegmentedChoice legend="Odoo-Version" options={ODOO_MAJORS.map(major => ({ id: String(major) as `${OdooMajor}`, label: `${major}.0` }))} value={String(odooMajor) as `${OdooMajor}`} disabled={action.busy} onChange={major => setOdooMajor(Number(major) as OdooMajor)} /></div>}
            <p className="ev-dev-mode-hint">{modeHints[developmentMode]} Repository und Details legst du später unter „Entwicklung“ fest. Der Modus ändert keine Rechte und installiert nichts.</p>
        </div>
        <p className="ev-muted ev-form-wide">Für jedes neue Projekt wird automatisch ein eigener Ordner angelegt.</p>
        {me.user.isAdmin && <div className="ev-form-wide">
            <label className="ev-check"><input type="checkbox" checked={manual} disabled={action.busy} onChange={event => { setManual(event.target.checked); setRootPath(''); setShowPicker(false); action.clear() }} />Ordner manuell festlegen oder wählen</label>
            {manual && <div className="ev-manual-workspace">
                <Field label="Projektordner auf dem Server" hint="Absoluter, freigegebener Pfad. Das Verknüpfen verlangt eine aktuelle Passkey-Anmeldung."><input value={rootPath} onChange={event => setRootPath(event.target.value)} placeholder="/workspaces/projekt" required disabled={action.busy} /></Field>
                <button type="button" aria-expanded={showPicker} disabled={action.busy} onClick={() => setShowPicker(value => !value)}>{showPicker ? 'Ordnerauswahl schließen' : 'Ordner auf dem Server auswählen'}</button>
                {showPicker && <WorkspacePicker disabled={action.busy} onChoose={path => { setRootPath(path); setShowPicker(false) }} />}
            </div>}
        </div>}
        <div className="ev-actions ev-form-wide"><button className="ev-primary" disabled={action.busy || !name.trim() || !selectedTeam || (useManualPath && !rootPath.trim())}>Projekt anlegen</button></div>
    </form></Panel>}
    <ActionStatus action={action} /></div>
}

export function TeamPanel() {
    const { api, me, project, refresh } = useEvolved()
    const action = useAction()
    const teams = useQuery({ queryKey: ['evolved', 'teams', api.baseUrl, me.user.id], queryFn: ({ signal }) => api.request<{ teams: Team[] }>('/teams', { signal }) })
    const passkeys = useQuery({ queryKey: ['evolved', 'passkeys', me.user.id], queryFn: ({ signal }) => api.request<{ passkeys: { id: string; createdAt: number }[] }>('/auth/passkeys', { signal }) })
    const [selectedTeam, setSelectedTeam] = useState('')
    const current = teams.data?.teams.find(team => team.id === selectedTeam) ?? teams.data?.teams.find(team => team.id === project?.teamId) ?? teams.data?.teams[0]
    const members = useQuery({ queryKey: ['evolved', 'team-members', current?.id], enabled: !!current, queryFn: ({ signal }) => api.request<{ members: TeamMember[] }>(`/teams/${encodeURIComponent(current!.id)}/members`, { signal }) })
    const projectMembers = useQuery({ queryKey: ['evolved', 'project-members', project?.id], enabled: !!project && isProjectAdmin(project.role), queryFn: ({ signal }) => api.request<{ members: TeamMember[] }>(`${projectPath(project!.id)}/members`, { signal }) })
    const [teamName, setTeamName] = useState('')
    const [inviteName, setInviteName] = useState('')
    const [inviteRole, setInviteRole] = useState<ProjectRole>('member')
    const [invite, setInvite] = useState<{ token: string; expiresAt: number | string } | null>(null)
    const [codes, setCodes] = useState<string[] | null>(null)
    const [memberId, setMemberId] = useState('')
    const [memberRole, setMemberRole] = useState<ProjectRole>('member')
    const teamAdmin = isProjectAdmin(current?.role)
    const inviteLink = invite ? `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invite.token)}` : ''
    return <div className="ev-stack"><Panel title="Dein Konto"><p><strong>{me.user.displayName}</strong></p><p className="ev-muted">Benutzer-ID: <code>{me.user.id}</code></p><div className="ev-actions">
        <button disabled={action.busy} onClick={() => void action.run(async () => { const result = await enrollPasskey(api); await refresh(); await passkeys.refetch(); if (result.recoveryCodes?.length) setCodes(result.recoveryCodes) }, 'Passkey hinzugefügt.')}>Weiteren Passkey hinzufügen</button>
        <ConfirmButton label="Wiederherstellungscodes erneuern" detail="Bisherige Codes werden ungültig." disabled={action.busy} onConfirm={() => void action.run(async () => { const result = await api.request<{ recoveryCodes: string[] }>('/auth/recovery-codes', { method: 'POST', body: {} }); setCodes(result.recoveryCodes) })} />
    </div></Panel>
    <Panel title="Deine Passkeys" description="Entferne verlorene Geräte nach dem Anlegen eines Ersatz-Passkeys. Beim Entfernen werden andere Anmeldungen und Runner-Zugänge dieses Kontos widerrufen."><ErrorNotice error={passkeys.error} />{passkeys.isPending ? <Loading /> : <div className="ev-list">{passkeys.data?.passkeys.map(key => <div className="ev-row" key={key.id}><div><strong>Passkey · {formatDate(key.createdAt)}</strong><small><code>{key.id.slice(0, 16)}…</code></small></div><ConfirmButton label="Passkey entfernen" detail="Passkey und andere aktive Zugänge dieses Kontos widerrufen?" disabled={action.busy || (passkeys.data?.passkeys.length ?? 0) < 2} onConfirm={() => void action.run(async () => { await api.request(`/auth/passkeys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); await passkeys.refetch(); await refresh() }, 'Passkey entfernt. Andere aktive Zugänge wurden widerrufen.')} /></div>)}</div>}</Panel>
    {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
    <Panel title="Teams"><ErrorNotice error={teams.error} />{teams.isPending ? <Loading /> : <>
        {current ? <Field label="Team auswählen"><select value={current.id} onChange={event => { setSelectedTeam(event.target.value); setInvite(null) }}>{teams.data?.teams.map(team => <option key={team.id} value={team.id}>{team.name} · {roleNames[team.role]}</option>)}</select></Field> : <Empty>Noch kein Team vorhanden.</Empty>}
        <form className="ev-inline-form" onSubmit={submit(() => void action.run(async () => { await api.request('/teams', { method: 'POST', body: { name: teamName.trim() } }); setTeamName(''); await teams.refetch(); await refresh() }, 'Team angelegt.'))}>
            <Field label="Neues Team"><input required maxLength={100} value={teamName} onChange={event => setTeamName(event.target.value)} /></Field><button disabled={action.busy || !teamName.trim()}>Team anlegen</button>
        </form>
    </>}</Panel>
    {current && <Panel title={`Mitglieder · ${current.name}`}><ErrorNotice error={members.error} />{members.isPending ? <Loading /> : <div className="ev-list">{members.data?.members.map(member => <div className="ev-row" key={member.userId}><div><strong>{member.displayName}</strong><small>{member.userId}</small></div><select aria-label={`Rolle für ${member.displayName}`} disabled={!teamAdmin || action.busy} value={member.role} onChange={event => { const role = event.target.value; void action.run(async () => { await api.request(`/teams/${encodeURIComponent(current.id)}/members`, { method: 'POST', body: { userId: member.userId, role } }); await members.refetch(); await refresh() }, 'Teamrolle gespeichert.') }}>{roles.map(role => <option key={role} value={role}>{roleNames[role]}</option>)}</select>
        {teamAdmin && <ConfirmButton label="Entfernen" detail={`${member.displayName} aus dem Team entfernen?`} disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`/teams/${encodeURIComponent(current.id)}/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE' }); await members.refetch(); await refresh() }, 'Mitglied entfernt.')} />}
    </div>)}</div>}</Panel>}
    {current && teamAdmin && <Panel title="Mitglied einladen" description="Die Einladung ermöglicht dem Empfänger, seinen eigenen Passkey anzulegen."><form className="ev-inline-form" onSubmit={submit(() => void action.run(async () => {
        setInvite(await api.request(`/teams/${encodeURIComponent(current.id)}/invitations`, { method: 'POST', body: { displayName: inviteName.trim(), role: inviteRole } })); setInviteName('')
    }))}><Field label="Benutzername"><input required value={inviteName} onChange={event => setInviteName(event.target.value)} maxLength={100} /></Field><Field label="Teamrolle"><select value={inviteRole} onChange={event => setInviteRole(event.target.value as ProjectRole)}>{roles.map(role => <option key={role} value={role}>{roleNames[role]}</option>)}</select></Field><button disabled={action.busy}>Einladung erstellen</button></form>
        {invite && <div className="ev-callout"><p>Einladung gültig bis {new Date(invite.expiresAt).toLocaleString('de-DE')}. Teile den Link direkt mit dem Empfänger.</p><Field label="Einladungslink"><input readOnly value={inviteLink} onFocus={event => event.target.select()} /></Field><div className="ev-actions"><button onClick={() => void action.run(async () => { await navigator.clipboard.writeText(inviteLink) }, 'Einladungslink kopiert.')}>Link kopieren</button><button onClick={() => setInvite(null)}>Ausblenden</button></div></div>}
    </Panel>}
    {project && isProjectAdmin(project.role) && <Panel title={`Projektrollen · ${project.name}`} description="Eine Projektrolle überschreibt die Teamrolle für dieses Projekt. Zurücksetzen stellt die Teamrolle wieder her. Für vollständigen Rechteentzug das Mitglied aus dem Team entfernen."><ErrorNotice error={projectMembers.error} /><div className="ev-list">{projectMembers.data?.members.map(member => <div className="ev-row" key={member.userId}><span>{member.displayName || member.userId} · {roleNames[member.role]}</span>{member.override != null ? <ConfirmButton label="Teamrolle verwenden" detail="Projektüberschreibung entfernen und Teamrolle wiederherstellen? Der Projektzugriff bleibt bestehen." disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${projectPath(project.id)}/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE' }); await projectMembers.refetch(); await refresh() })} /> : <span className="ev-badge">Teamrolle</span>}</div>)}</div>
        <form className="ev-inline-form" onSubmit={submit(() => void action.run(async () => { await api.request(`${projectPath(project.id)}/members`, { method: 'PUT', body: { userId: memberId, role: memberRole } }); await projectMembers.refetch(); await refresh() }, 'Projektrolle gespeichert.'))}><Field label="Benutzer-ID"><input required value={memberId} onChange={event => setMemberId(event.target.value)} list="evolved-team-members" /><datalist id="evolved-team-members">{members.data?.members.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</datalist></Field><Field label="Projektrolle"><select value={memberRole} onChange={event => setMemberRole(event.target.value as ProjectRole)}>{roles.map(role => <option key={role} value={role}>{roleNames[role]}</option>)}</select></Field><button disabled={action.busy}>Rolle setzen</button></form>
    </Panel>}
    <ActionStatus action={action} /></div>
}
