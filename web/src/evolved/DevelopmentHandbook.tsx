import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEVELOPMENT_KNOWLEDGE_QUERY_MAX, DevelopmentKnowledgeResponseSchema, type DevelopmentContext, type DevelopmentTopicSummary, type ProjectDevelopmentConfig } from '@hapi/protocol/evolvedDevelopment'
import { useEvolved } from './auth'
import { WorkspaceLink } from './workspaceNavigation'
import { describeDevelopmentError, developmentPath, developmentScope, safeHttpsUrl } from './developmentApi'

export function DevelopmentHandbook({ config, context }: { config: ProjectDevelopmentConfig; context: DevelopmentContext }) {
    const evolved = useEvolved()
    const projectId = evolved.project!.id
    const pack = context.pack
    const [input, setInput] = useState('')
    const [query, setQuery] = useState('')
    const search = useQuery({
        queryKey: ['evolved', 'development-knowledge', ...developmentScope(evolved), config.revision, 'q', query],
        enabled: !!query, retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentKnowledgeResponseSchema.parse(await evolved.api.request(developmentPath(projectId, `/knowledge?${new URLSearchParams({ q: query, limit: '20' })}`), { signal })),
    })
    if (!pack) return null
    const results = query && !search.error && search.data?.revision === config.revision ? search.data : null
    const topics: (DevelopmentTopicSummary & { excerpt?: string })[] = query ? results?.results ?? [] : pack.topics
    return <section className="ev-panel" aria-labelledby="ev-dev-handbook">
        <h2 id="ev-dev-handbook">Handbuch · {pack.title}</h2>
        <p className="ev-muted">Mitgeliefert, Version {pack.version} (geprüft am {pack.verifiedAt}, Revision <code>{pack.revision}</code>), Inhalte auf Englisch. Funktioniert ohne Graph-Gedächtnis.</p>
        {pack.brief.length > 0 && <details><summary>Kurzüberblick</summary><ul className="ev-dev-links">{pack.brief.map(item => <li key={item}>{item}</li>)}</ul></details>}
        <form className="ev-dev-toolbar" role="search" onSubmit={event => { event.preventDefault(); setQuery(input.trim().slice(0, DEVELOPMENT_KNOWLEDGE_QUERY_MAX)) }}>
            <label className="ev-field"><span>Handbuch durchsuchen</span><input type="search" value={input} maxLength={DEVELOPMENT_KNOWLEDGE_QUERY_MAX} onChange={event => { setInput(event.target.value); if (!event.target.value.trim()) setQuery('') }} placeholder="z. B. security, upgrade, gradle" /></label>
            <button type="submit" disabled={!input.trim() || search.isFetching}>Suchen</button>
            {query && <button type="button" onClick={() => { setInput(''); setQuery('') }}>Alle Themen</button>}
        </form>
        {search.error && <p className="ev-error" role="alert">{describeDevelopmentError(search.error)}</p>}
        {query && search.isFetching && <p className="ev-muted" role="status">Suche läuft …</p>}
        <p className="ev-muted" role="status">{query ? results ? `${results.total} Treffer für „${query}“${results.truncated ? ' (gekürzt)' : ''}` : '' : `${pack.topics.length} Themen für die gespeicherte Version`}</p>
        <div className="ev-dev-topics">{topics.map(topic => <TopicEntry key={topic.id} topic={topic} revision={config.revision} />)}</div>
        <p className="ev-muted">Projektspezifische Erkenntnisse gehören ins <WorkspaceLink tab="memory" projectId={projectId}>Gedächtnis</WorkspaceLink>. Aktuelle Bibliotheksdokumentation gibt es über Context7 im <WorkspaceLink tab="mcp" projectId={projectId}>MCP-Shop</WorkspaceLink>; dort wird nichts automatisch freigegeben.</p>
    </section>
}

function TopicEntry({ topic, revision }: { topic: DevelopmentTopicSummary & { excerpt?: string }; revision: number }) {
    const evolved = useEvolved()
    const [open, setOpen] = useState(false)
    const detail = useQuery({
        queryKey: ['evolved', 'development-knowledge', ...developmentScope(evolved), revision, 'topic', topic.id],
        enabled: open, retry: false, gcTime: 0,
        queryFn: async ({ signal }) => DevelopmentKnowledgeResponseSchema.parse(await evolved.api.request(developmentPath(evolved.project!.id, `/knowledge?${new URLSearchParams({ topic: topic.id })}`), { signal })),
    })
    const full = !detail.error && detail.data?.revision === revision && detail.data.topic?.id === topic.id ? detail.data.topic : null
    const sources = full?.sources ?? topic.sources
    return <details className="ev-dev-topic" onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary><span>{topic.title}</span><small>{topic.appliesTo.odooMajors?.length ? `Odoo ${topic.appliesTo.odooMajors.join(' / ')}` : ''}{topic.tags.length ? ` ${topic.tags.slice(0, 4).join(' · ')}` : ''}</small></summary>
        <div>
            <p>{topic.summary}</p>
            {topic.excerpt && <p className="ev-muted">… {topic.excerpt} …</p>}
            {open && detail.isFetching && <p className="ev-muted" role="status">Thema wird geladen …</p>}
            {detail.error && <p className="ev-error" role="alert">{describeDevelopmentError(detail.error)}</p>}
            {full && <p>{full.body}</p>}
            <p><strong>Quellen</strong></p>
            <ul className="ev-dev-links">{sources.map(source => { const url = safeHttpsUrl(source.url); return <li key={source.url}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}{source.version ? ` · ${source.version}` : ''} · geprüft am {source.verifiedAt}</li> })}</ul>
        </div>
    </details>
}
