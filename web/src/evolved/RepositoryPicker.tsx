import type { RepositoryChoices } from './repositoryCatalog'
import { ErrorNotice, Field } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

export function RepositoryPicker({ choices, value, onChange, projectId, disabled = false }: {
    choices: RepositoryChoices; value: string; onChange: (id: string) => void; projectId: string; disabled?: boolean
}) {
    const repository = choices.current?.repositories.find(item => item.id === value)
    const usable = repository?.local.state === 'ready' && repository.job?.state !== 'running' && choices.current?.runner.status === 'ready'
    return <div className="evolved ev-stack">
        <Field label="Arbeitsort" hint="Der Ordner wird automatisch aus dem Projekt oder dem freigegebenen Repository bestimmt."><select value={value} onChange={event => onChange(event.target.value)} disabled={disabled || choices.isFetching}>
            <option value="">Projektordner</option>
            {value && !repository && <option value={value}>Repository nicht verfügbar</option>}
            {choices.current?.repositories.map(item => <option key={item.id} value={item.id}>{item.fullName}{item.local.state === 'ready' ? '' : item.local.state === 'missing' ? ' · noch nicht geklont' : ' · nicht bereit'}</option>)}
        </select></Field>
        {choices.isFetching && <p role="status" className="ev-muted">Repository-Status wird geprüft …</p>}
        <ErrorNotice error={choices.error} />
        {value && !usable && !choices.isFetching && <p role="status" className="ev-muted">Dieses Repository kann noch nicht als Arbeitsort verwendet werden. Prüfe Freigabe, Clone und Projektdienst. Es wird kein anderer Ordner gewählt.</p>}
        <div className="ev-actions"><button type="button" disabled={disabled || choices.isFetching} onClick={() => void choices.refetch()}>Repositorys prüfen</button><WorkspaceLink tab="github" projectId={projectId}>Repositorys verwalten</WorkspaceLink></div>
    </div>
}
