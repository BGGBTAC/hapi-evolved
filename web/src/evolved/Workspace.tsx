import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useOptionalEvolved } from './auth'
import { ProjectsPanel, TeamPanel } from './ProjectsTeam'
import { VaultPanel } from './Vault'
import { MemoryPanel } from './Memory'
import { CodegraphPanel } from './Codegraph'
import { RunnerPanel } from './Runner'
import { AutomationPanel } from './Automation'
import { PreviewsPanel } from './Previews'
import { ErrorNotice, useAction } from './ui'
import './evolved.css'

const tabs = [
    { id: 'projects', label: 'Projekte', mark: '◈' },
    { id: 'team', label: 'Team & Konto', mark: '◎' },
    { id: 'vault', label: 'Tresor', mark: '◇' },
    { id: 'memory', label: 'Gedächtnis', mark: '✧' },
    { id: 'codegraph', label: 'Codegraph', mark: '⌘' },
    { id: 'automation', label: 'Automatisierung', mark: '◷' },
    { id: 'runner', label: 'Runner', mark: '▷' },
    { id: 'previews', label: 'Vorschauen', mark: '▧' },
] as const
type WorkspaceTab = typeof tabs[number]['id']
export default function EvolvedWorkspace() {
    const context = useOptionalEvolved()
    const [tab, setTab] = useState<WorkspaceTab>('projects')
    const action = useAction()
    if (!context) return <main className="evolved ev-login"><h1>HAPI evolved</h1><p>Dieser Hub hat den Evolved-Arbeitsbereich nicht aktiviert.</p><Link to="/sessions">Zu den Sessions</Link></main>
    const { me, project, selectProject, logout } = context
    return <main className="evolved ev-workspace"><header className="ev-header"><div className="ev-brand"><span className="ev-mark" aria-hidden="true">H</span><div><h1>HAPI evolved</h1><p>Projekte. Wissen. Kontrolle.</p></div></div><div className="ev-header-actions">
        {me.accessibleProjects.length > 0 && <label className="ev-project-picker"><span className="ev-sr-only">Aktives Projekt</span><select value={project?.id ?? ''} onChange={event => selectProject(event.target.value)}>{me.accessibleProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {project && <Link className="ev-session-link" to="/sessions">Sessions öffnen ↗</Link>}<button disabled={action.busy} onClick={() => void action.run(logout)}>Abmelden</button>
    </div></header><div className="ev-workspace-body"><nav className="ev-tabs" aria-label="Arbeitsbereich">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} disabled={!project && item.id !== 'projects' && item.id !== 'team'} onClick={() => setTab(item.id)}><span aria-hidden="true">{item.mark}</span>{item.label}</button>)}<div className="ev-identity"><strong>{me.user.displayName}</strong><small>{project ? project.name : 'Noch kein Projekt ausgewählt'}</small></div></nav>
        <div className="ev-content" key={`${project?.id ?? 'none'}:${tab}`}><ErrorNotice error={action.error} />{!project && <div className="ev-callout">Willkommen. Lege unter „Team & Konto“ dein Team an und erstelle anschließend dein erstes Projekt.</div>}
            {tab === 'projects' ? <ProjectsPanel /> : tab === 'team' ? <TeamPanel /> : project && tab === 'vault' ? <VaultPanel /> : project && tab === 'memory' ? <MemoryPanel /> : project && tab === 'codegraph' ? <CodegraphPanel /> : project && tab === 'automation' ? <AutomationPanel /> : project && tab === 'runner' ? <RunnerPanel /> : project && tab === 'previews' ? <PreviewsPanel /> : null}
        </div>
    </div></main>
}
