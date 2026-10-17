import type { RepositoryChoices } from './repositoryCatalog'
import { ErrorNotice, Field } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

const UNSELECTED = '\u0000unselected'

export function RepositoryPicker({ choices, value, onChange, projectId, disabled = false, allowProjectRoot = true, defaultRepositoryId, hint, unselected = false, showFolder = false, projectRoot }: {
    choices: RepositoryChoices; value: string; onChange: (id: string) => void; projectId: string; disabled?: boolean
    /** No work location chosen yet (e.g. the default is unknown): nothing is preselected, not even the project folder. */
    unselected?: boolean
    /** Show the authorised folder from the hub catalog (or the project root) below the picker. */
    showFolder?: boolean
    projectRoot?: string | null
    /** False when the server would substitute a default for an omitted repository (development tasks). */
    allowProjectRoot?: boolean
    /** Repository bound by the project development mode; only annotated, never substituted here. */
    defaultRepositoryId?: string | null
    hint?: string
}) {
    const repository = choices.current?.repositories.find(item => item.id === value)
    const usable = repository?.local.state === 'ready' && repository.job?.state !== 'running' && choices.current?.runner.status === 'ready'
    return <div className="evolved ev-stack">
        <Field label="Arbeitsort" hint={hint ?? 'Der Ordner wird automatisch aus dem Projekt oder dem freigegebenen Repository bestimmt.'}><select value={unselected ? UNSELECTED : value} onChange={event => onChange(event.target.value)} disabled={disabled || choices.isFetching}>
            {unselected && <option value={UNSELECTED} disabled>Arbeitsort wählen …</option>}
            {allowProjectRoot && <option value="">Projektordner</option>}
            {value && !repository && <option value={value}>Repository nicht verfügbar</option>}
            {choices.current?.repositories.map(item => <option key={item.id} value={item.id}>{item.fullName}{item.id === defaultRepositoryId ? ' · Standard' : ''}{item.local.state === 'ready' ? '' : item.local.state === 'missing' ? ' · noch nicht geklont' : ' · nicht bereit'}</option>)}
        </select></Field>
        {choices.isFetching && <p role="status" className="ev-muted">Repository-Status wird geprüft …</p>}
        <ErrorNotice error={choices.error} />
        {showFolder && !unselected && <div className="ev-muted" role="group" aria-label="Arbeitsordner">Ordner: <code>{value ? usable ? repository!.path : 'nicht verfügbar' : choices.current?.rootPath ?? projectRoot ?? 'unbekannt'}</code></div>}
        {!unselected && value && !usable && !choices.isFetching && <p role="status" className="ev-muted">Dieses Repository kann noch nicht als Arbeitsort verwendet werden. Prüfe Freigabe, Clone und Projektdienst. Es wird kein anderer Ordner gewählt.</p>}
        <div className="ev-actions"><button type="button" disabled={disabled || choices.isFetching} onClick={() => void choices.refetch()}>Repositorys prüfen</button><WorkspaceLink tab="github" projectId={projectId}>Repositorys verwalten</WorkspaceLink></div>
    </div>
}
