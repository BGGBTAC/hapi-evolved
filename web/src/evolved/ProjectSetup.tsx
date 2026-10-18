import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ProjectReadiness, ReadinessState } from '@hapi/protocol/evolvedWorkspace'
import type { DevelopmentModuleContext, DevelopmentModuleSettingsInput, DevelopmentModulesResponse, ProjectDevelopmentModuleConfig } from '@hapi/protocol/developmentModules'
import { useEvolved } from './auth'
import { canWriteProject, isProjectAdmin, projectPath, type ExecutionProfile, type EvolvedProject } from './api'
import { ConfirmButton, ErrorNotice, Loading, useAction } from './ui'
import { setupSteps, WorkspaceLink, type SetupStep } from './workspaceNavigation'
import { useProjectRepositories, type RepositoryCatalog } from './repositoryCatalog'
import { describeActiveModule, describeDevelopmentError, developmentScope, formatTimestamp, moduleStateLabels, sameSettings, settingsInput, useDevelopmentModuleContext, useDevelopmentModuleDetail, useDevelopmentModules } from './developmentApi'
import { applyIntent, ProjectDevelopmentPanel } from './ProjectDevelopment'
import { GithubPanel } from './Github'
import { ProviderLoginPanel } from './ProviderLogin'
import { intendedSettings, readSetupIntent, writeSetupIntent, type SetupIntent } from './setupIntent'
import './setup.css'

/**
 * Guided project setup. Every state shown here is derived from what the hub returns now (project profile,
 * readiness, repository catalog, saved development configuration); there is no stored progress. Opening a step,
 * "Weiter" or "Zurück" never logs in, clones, checks, starts or changes anything: each step embeds the existing
 * panel whose own buttons remain the only way to act.
 */

export type StepState = 'done' | 'todo' | 'blocked' | 'unknown' | 'draft' | 'optional' | 'admin'
export const stepStateLabels: Record<StepState, string> = {
    done: 'Erledigt', todo: 'Offen', blocked: 'Blockiert', unknown: 'Nicht geprüft', draft: 'Entwurf', optional: 'Optional', admin: 'Sache der Administration',
}
const stepTitles: Record<SetupStep, string> = {
    profile: 'Profil', provider: 'Anbieter und Runner', github: 'GitHub und Repository', module: 'Modul und Einstellungen', checks: 'Prüfen und einrichten', summary: 'Zusammenfassung',
}
export type SetupStepStatus = { id: SetupStep; state: StepState; detail: string }
type Repo = RepositoryCatalog['repositories'][number]

export type SetupInput = {
    project: Pick<EvolvedProject, 'role' | 'profile'>
    readiness: { data: ProjectReadiness | null; error: boolean }
    repositories: { data: RepositoryCatalog | undefined; error: boolean }
    modules: DevelopmentModulesResponse | undefined
    modulesError: boolean
    intent: SetupIntent | null
    /**
     * Whether the intended or saved module needs a repository, from its definition (required repository field or a task
     * that requires one); null while the definition is not loaded. A handbook-only module needs none.
     */
    repositoryRequired: boolean | null
    /** Revision- and digest-bound doctor summary of the saved, ready module; undefined = not loaded or not applicable. */
    doctor: { available: boolean; last: DevelopmentModuleContext['lastDoctor'] } | undefined
}

const readinessItem = (readiness: ProjectReadiness | null, key: string) => readiness?.items.find(item => item.key === key)
/** Folded readiness of several items: missing wins over stale/unknown, denied (role) is reported separately. */
function fold(states: Array<ReadinessState | undefined>): StepState {
    if (states.some(state => state === undefined || state === 'unknown' || state === 'stale')) return states.some(state => state === 'missing') ? 'todo' : 'unknown'
    if (states.some(state => state === 'missing')) return 'todo'
    return 'done'
}

/** Pure derivation of step states from authoritative data; never treats an unknown or failed read as done. */
export function deriveSetupSteps(input: SetupInput): SetupStepStatus[] {
    const { project, readiness, repositories, modules, intent } = input
    const config = modules?.config
    const savedModule = config?.settings.activeModuleId ?? null
    const intended = intendedSettings(intent)
    const intendedModule = intended.moduleId && intent && config && applyIntent(settingsInput(config.settings), intent) && intended.moduleId !== savedModule ? intended.moduleId : null
    const draftPending = !!intent && !!config && !!applyIntent(settingsInput(config.settings), intent)
    const moduleId = intendedModule ?? savedModule
    const odoo = moduleId === 'builtin:odoo' ? (intent?.draft?.settings.odoo ?? config?.settings.odoo ?? null) : null
    const boundId = config?.settings.repositoryId ?? null
    const catalog = repositories.error ? undefined : repositories.data
    const bound = boundId ? catalog?.repositories.find(item => item.id === boundId) : undefined

    const profile: SetupStepStatus = project.role === 'viewer' ? { id: 'profile', state: 'admin', detail: 'Lesender Zugang: Einrichten können Mitglieder und Administratoren.' }
        : project.profile === 'restricted' ? { id: 'profile', state: 'todo', detail: 'Eingeschränkt: planen und lesen. Klonen, Einrichtungs- und Testaufgaben brauchen „Arbeitsbereich“.' }
            : { id: 'profile', state: 'done', detail: project.profile === 'workspace' ? 'Arbeitsbereich: Klonen, Code ändern und lokale Tests im Projektordner.' : 'Erweitert: zusätzliche Ausführungsrechte.' }

    const live = readiness.error || !readiness.data ? null : readiness.data
    const providerStates = ['runner', 'rpc', 'agents'].map(key => readinessItem(live, key)?.state)
    const providerItem = readinessItem(live, 'providers')
    const providerState = !live ? 'unknown' : fold(providerItem?.state === 'denied' ? providerStates : [...providerStates, providerItem?.state])
    const provider: SetupStepStatus = { id: 'provider', state: providerState,
        detail: !live ? 'Bereitschaft nicht geladen oder gehört zu einer anderen Konfigurationsrevision.' : providerState === 'done' ? `Projektdienst verbunden${providerItem?.state === 'denied' ? '; den Anbieterstatus prüft ein Projektadministrator' : ', Anbieter angemeldet'}.`
            : [...['runner', 'rpc', 'agents', 'providers'].map(key => readinessItem(live, key)).filter(item => item && item.state !== 'ok' && item.state !== 'denied').map(item => item!.detail)].join(' ') || 'Noch nicht bestätigt.' }

    // Without a module nothing needs a repository; with one, only its definition decides (null: not known yet).
    const needed: boolean | null = !moduleId ? false : input.repositoryRequired
    const missingState = (detail: string): SetupStepStatus => needed === null ? { id: 'github', state: 'unknown', detail: `${detail} Ob das Modul ein Repository braucht, wird noch geprüft.` }
        : { id: 'github', state: needed ? 'todo' : 'optional', detail: needed ? detail : `${detail} Für dieses Modul nicht nötig.` }
    const github: SetupStepStatus = repositories.error ? { id: 'github', state: 'unknown', detail: 'Repository-Status konnte nicht geladen werden.' }
        : !catalog ? { id: 'github', state: 'unknown', detail: 'Wird geprüft …' }
            : !catalog.connected ? missingState('GitHub ist für dieses Projekt nicht verbunden.')
                : boundId && !bound ? { id: 'github', state: 'blocked', detail: `Das gespeicherte Standard-Repository (${boundId}) ist nicht mehr freigegeben.` }
                    : bound ? repositoryStep(bound, catalog)
                        : intended.repositoryId && draftPending ? { id: 'github', state: 'draft', detail: 'Ein Standard-Repository ist vorgemerkt, aber noch nicht gespeichert.' }
                            : missingState(catalog.repositories.some(item => item.local.state === 'ready') ? 'Ein Repository ist geklont, aber nicht als Standard gespeichert. Wähle es im Schritt Modul.' : catalog.repositories.length ? 'Repository freigegeben, aber noch nicht geklont.' : 'Noch kein Repository freigegeben.')
    // A separate Enterprise checkout is optional local tooling (Odoo.sh ships Enterprise itself): it is reported, never a blocker.
    if (odoo?.edition === 'enterprise' && odoo.enterpriseRepositoryId) {
        const enterprise = catalog?.repositories.find(item => item.id === odoo.enterpriseRepositoryId)
        const note = !catalog ? '' : !enterprise ? ' Optionale Enterprise-Quelle: nicht mehr freigegeben.' : enterprise.local.state !== 'ready' ? ` Optionale Enterprise-Quelle ${enterprise.fullName}: noch nicht geklont.` : ` Optionale Enterprise-Quelle ${enterprise.fullName}: geklont.`
        github.detail += note
    }

    const module: SetupStepStatus = input.modulesError && !config ? { id: 'module', state: 'unknown', detail: 'Entwicklungsmodul nicht geladen.' }
        : !config ? { id: 'module', state: 'unknown', detail: 'Wird geladen …' }
            : intendedModule ? { id: 'module', state: 'draft', detail: `${describeActiveModule({ activeModuleId: intendedModule, odoo: null }, modules!.catalog.modules)} ist vorgemerkt, aber nicht gespeichert und nicht aktiv.` }
                : draftPending ? { id: 'module', state: 'draft', detail: 'Ungespeicherte Änderungen sind vorgemerkt.' }
                    : !savedModule ? { id: 'module', state: 'optional', detail: 'Kein Modul gespeichert: Sitzungen arbeiten allgemein.' }
                        : config.active.state === 'ready' ? { id: 'module', state: 'done', detail: `${describeActiveModule(config.settings, modules!.catalog.modules)} · Revision ${config.revision}.` }
                            : { id: 'module', state: 'blocked', detail: `${describeActiveModule(config.settings, modules!.catalog.modules)}: ${moduleStateLabels[config.active.state]}.` }

    const checks: SetupStepStatus = !savedModule ? { id: 'checks', state: 'optional', detail: 'Ohne Modul gibt es keine Modulprüfung.' }
        : config?.active.state !== 'ready' ? { id: 'checks', state: 'blocked', detail: 'Erst mit einem gespeicherten, verfügbaren Modul.' }
            : doctorStep(input.doctor, config)
    const summary: SetupStepStatus = { id: 'summary', state: 'optional', detail: 'Überblick, optionale Anbindungen und Start einer Sitzung.' }
    return [profile, provider, github, module, checks, summary]
}

/** Only a doctor run of exactly the saved revision and installed module revision counts; optional checks never block. */
function doctorStep(doctor: SetupInput['doctor'], config: ProjectDevelopmentModuleConfig): SetupStepStatus {
    if (!doctor) return { id: 'checks', state: 'unknown', detail: 'Prüfstand wird geladen …' }
    if (!doctor.available) return { id: 'checks', state: 'optional', detail: 'Dieses Modul bietet keine Werkzeugprüfung.' }
    const last = doctor.last
    if (!last || last.revision !== config.revision || last.moduleDigest !== config.active.installedDigest) return { id: 'checks', state: 'unknown', detail: 'Für die gespeicherte Revision liegt noch keine Werkzeugprüfung vor. Starte sie bewusst.' }
    if (!last.missingRequired) return { id: 'checks', state: 'unknown', detail: `Letzte Prüfung ${formatTimestamp(last.observedAt)}: Pflichtprüfungen sind nicht einzeln bekannt. Prüfe erneut.` }
    if (!last.missingRequired.length) return { id: 'checks', state: 'done', detail: `Alle Pflichtprüfungen bestanden (${formatTimestamp(last.observedAt)}, Revision ${last.revision}).${last.missing + last.unknown + last.unsupported + last.warning ? ' Optionale Prüfungen haben Hinweise.' : ''}` }
    return { id: 'checks', state: 'todo', detail: `${last.missingRequired.length} Pflichtprüfung${last.missingRequired.length === 1 ? '' : 'en'} offen (${formatTimestamp(last.observedAt)}). Die Abhilfe steht im Schritt.` }
}

function repositoryStep(bound: Repo, catalog: RepositoryCatalog): SetupStepStatus {
    if (bound.job?.state === 'running') return { id: 'github', state: 'unknown', detail: `${bound.fullName}: Git-Vorgang läuft.` }
    if (bound.local.state === 'ready') return catalog.runner.status === 'ready'
        ? { id: 'github', state: 'done', detail: `${bound.fullName} ist Standard-Repository und geklont${bound.local.branch ? ` (Branch ${bound.local.branch})` : ''}.` }
        : { id: 'github', state: 'unknown', detail: `${bound.fullName} ist geklont; der Projektdienst ist derzeit nicht erreichbar.` }
    if (bound.local.state === 'missing') return { id: 'github', state: 'todo', detail: `${bound.fullName} ist Standard-Repository, aber noch nicht geklont.` }
    if (bound.local.state === 'blocked') return { id: 'github', state: 'blocked', detail: `${bound.fullName} kann nicht verwendet werden${bound.local.message ? `: ${bound.local.message}` : '.'}` }
    return { id: 'github', state: 'unknown', detail: `${bound.fullName}: lokaler Zustand unbekannt.` }
}

export function ProjectSetupPanel({ step, onStep }: { step?: SetupStep; onStep: (step: SetupStep) => void }) {
    const evolved = useEvolved()
    if (!evolved.project) return null
    // Account, project, role or profile changes discard everything derived for the previous scope.
    return <SetupForProject key={JSON.stringify(developmentScope(evolved))} step={step ?? null} onStep={onStep} />
}

function useReadiness() {
    const { api, me, project } = useEvolved()
    // Same query key as the overview panel: one read-only request, no runner or provider action.
    const query = useQuery({ queryKey: ['evolved', 'readiness', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile],
        retry: false, gcTime: 0, queryFn: ({ signal }) => api.request<ProjectReadiness>(`${projectPath(project!.id)}/readiness`, { signal }) })
    return { ...query, current: !query.error && query.data?.projectId === project!.id ? query.data : null }
}

function SetupForProject({ step, onStep }: { step: SetupStep | null; onStep: (step: SetupStep) => void }) {
    const evolved = useEvolved()
    const { api, me, project } = evolved
    const [intent, setIntentState] = useState(() => readSetupIntent(api.baseUrl, me.user.id, project!.id))
    const [intentError, setIntentError] = useState(false)
    const setIntent = (next: SetupIntent | null) => { setIntentError(!writeSetupIntent(api.baseUrl, me.user.id, project!.id, next)); setIntentState(next) }
    const readiness = useReadiness()
    const repositories = useProjectRepositories(evolved)
    const modules = useDevelopmentModules(evolved)
    const config = modules.current?.config
    // Readiness is only evidence for the configuration revision it was computed for; another revision is re-read, never shown as current.
    const readinessRevision = readiness.current ? readiness.current.configRevision ?? 0 : null
    const readinessMatches = !!readiness.current && !!config && readinessRevision === config.revision
    const rereadFor = useRef<number | null>(null)
    useEffect(() => {
        if (!config || !readiness.current || readinessMatches || readiness.isFetching || rereadFor.current === config.revision) return
        rereadFor.current = config.revision
        void readiness.refetch()
    }, [config?.revision, readiness.current, readinessMatches, readiness.isFetching])
    // Prerequisites come from the definition of the intended (or saved) module, never from the mere presence of a module.
    const intended = intendedSettings(intent)
    const moduleId = (config && intent && applyIntent(settingsInput(config.settings), intent) ? intended.moduleId : null) ?? config?.settings.activeModuleId ?? null
    const entry = moduleId ? modules.current?.catalog.modules.find(item => item.id === moduleId) : undefined
    const detail = useDevelopmentModuleDetail(evolved, entry ? moduleId : null, entry?.digest ?? null)
    const repositoryRequired = !moduleId ? false : !entry ? null : !detail.current ? null
        : (detail.current.form.kind === 'fields' && detail.current.form.fields.some(field => field.kind === 'repository' && field.required)) || detail.current.tasks.some(task => task.requiresRepository)
    const context = useDevelopmentModuleContext(evolved, config?.active.state === 'ready' ? config.revision : undefined)
    const contextCurrent = context.current && config && context.current.revision === config.revision && context.current.module?.digest === config.active.installedDigest ? context.current : undefined
    const steps = deriveSetupSteps({
        project: project!, readiness: { data: readinessMatches ? readiness.current : null, error: !!readiness.error }, repositories: { data: repositories.current, error: !!repositories.error },
        modules: modules.current, modulesError: !!modules.error, intent, repositoryRequired,
        doctor: contextCurrent ? { available: !!contextCurrent.module?.doctor, last: contextCurrent.lastDoctor } : undefined,
    })
    const loaded = (!!readiness.current || !!readiness.error) && (!!repositories.current || !!repositories.error) && (!!modules.current || !!modules.error)
    // Resume where the saved state needs attention; an explicit step in the URL always wins.
    const firstOpen = steps.find(item => item.state === 'todo' || item.state === 'blocked' || item.state === 'draft')?.id ?? steps.find(item => item.state === 'unknown')?.id ?? 'summary'
    const active: SetupStep | null = step ?? (loaded ? firstOpen : null)
    const index = active ? setupSteps.indexOf(active) : -1
    const heading = useRef<HTMLHeadingElement>(null)
    const moved = useRef(false)
    useEffect(() => { if (moved.current) heading.current?.focus({ preventScroll: false }); moved.current = false }, [active])
    const go = (next: SetupStep) => { moved.current = true; onStep(next) }
    const refreshAll = () => { void readiness.refetch(); void repositories.refetch(); void modules.refetch(); if (config?.active.state === 'ready') void context.refetch() }
    /** Keeps the unsaved wizard form; a clean form means the draft is saved, discarded or already what is saved. */
    const keepDraft = (draft: DevelopmentModuleSettingsInput | null, baseRevision: number) => {
        if (!draft) { if (intent) setIntent(null); return }
        const next: SetupIntent = { moduleId: null, moduleDigest: null, values: null, repositoryId: null, createdAt: intent?.createdAt ?? Date.now(), draft: { baseRevision, settings: draft } }
        if (!intent?.draft || intent.draft.baseRevision !== baseRevision || !sameSettings(intent.draft.settings, draft)) setIntent(next)
    }
    const bind = (repositoryId: string) => {
        // Binding is an edit of the pending form: an existing draft keeps all its other values.
        setIntent(intent?.draft ? { ...intent, draft: { ...intent.draft, settings: { ...intent.draft.settings, repositoryId } } }
            : { moduleId: intent?.moduleId ?? null, moduleDigest: intent?.moduleDigest ?? null, values: intent?.values ?? null, repositoryId, createdAt: intent?.createdAt ?? Date.now() })
        go('module')
    }
    const status = (id: SetupStep) => steps.find(item => item.id === id)!

    return <div className="ev-setup">
        <section className="ev-panel ev-setup-head" aria-labelledby="ev-setup-title">
            <div className="ev-setup-title-row"><div>
                <h2 id="ev-setup-title">Einrichtung · {project!.name}</h2>
                <p className="ev-muted">Alle Angaben stammen aus dem gespeicherten Stand{readiness.current ? ` (geprüft ${formatTimestamp(readiness.current.checkedAt)})` : ''}. Öffnen, „Weiter“ und „Zurück“ führen nichts aus.</p>
            </div><button type="button" disabled={readiness.isFetching || repositories.isFetching || modules.isFetching} onClick={refreshAll}>Stand neu prüfen</button></div>
            <nav aria-label="Einrichtungsschritte"><ol className="ev-setup-steps">{setupSteps.map((id, position) => {
                const item = status(id)
                return <li key={id}><button type="button" className="ev-setup-step" aria-current={active === id ? 'step' : undefined} onClick={() => go(id)} aria-describedby={`ev-setup-state-${id}`}>
                    <span className="ev-setup-number" aria-hidden="true">{position + 1}</span><span className="ev-setup-label">{stepTitles[id]}</span>
                    <span className="ev-setup-badge" id={`ev-setup-state-${id}`} data-state={item.state}>{stepStateLabels[item.state]}</span>
                </button></li>
            })}</ol></nav>
            {intentError && <p className="ev-error" role="alert">Dieser Browser kann die Vormerkung nicht aufbewahren. Sie gilt nur, solange diese Seite offen bleibt.</p>}
        </section>
        {!active ? <Loading /> : <section className="ev-panel ev-setup-body" aria-labelledby="ev-setup-step-title">
            <p className="ev-setup-progress">Schritt {index + 1} von {setupSteps.length}</p>
            <h2 id="ev-setup-step-title" ref={heading} tabIndex={-1}>{stepTitles[active]}</h2>
            <p className="ev-setup-status" role="status"><span className="ev-setup-badge" data-state={status(active).state}>{stepStateLabels[status(active).state]}</span> {status(active).detail}</p>
            {active === 'profile' && <ProfileStep readiness={readiness.current} onChanged={() => void readiness.refetch()} />}
            {active === 'provider' && <ProviderStep readiness={readiness.current} readinessError={readiness.error} refetch={() => void readiness.refetch()} fetching={readiness.isFetching} />}
            {active === 'github' && <GithubStep catalog={repositories.current} modules={modules.current} intent={intent} repositoryRequired={repositoryRequired} onBind={bind} />}
            {active === 'module' && <ModuleStep intent={intent} onDraftChange={keepDraft} />}
            {active === 'checks' && <ChecksStep />}
            {active === 'summary' && <SummaryStep steps={steps} readiness={readiness.current} catalog={repositories.current} modules={modules.current} />}
        </section>}
        {active && <nav className="ev-setup-nav" aria-label="Schritt wechseln">
            <button type="button" disabled={index <= 0} onClick={() => go(setupSteps[index - 1]!)}>Zurück{index > 0 ? `: ${stepTitles[setupSteps[index - 1]!]}` : ''}</button>
            {index < setupSteps.length - 1 && <button type="button" className="ev-primary" onClick={() => go(setupSteps[index + 1]!)}>Weiter: {stepTitles[setupSteps[index + 1]!]}</button>}
        </nav>}
    </div>
}

const profileChoices: Array<{ id: ExecutionProfile; label: string; purpose: string }> = [
    { id: 'restricted', label: 'Eingeschränkt', purpose: 'Planen, Handbuch und Code lesen. Kein Klonen, keine Installation, keine lokalen Tests.' },
    { id: 'workspace', label: 'Arbeitsbereich', purpose: 'Repositorys klonen, Code ändern, lokale Laufzeit einrichten und Tests im Projektordner ausführen.' },
    { id: 'extended', label: 'Erweitert', purpose: 'Zusätzliche Ausführungsrechte. Nur für ausdrücklich freigegebene Projekte.' },
]

function ProfileStep({ readiness, onChanged }: { readiness: ProjectReadiness | null; onChanged: () => void }) {
    const { api, project, refresh } = useEvolved()
    const action = useAction()
    // A lost response may already have changed the profile; check before allowing another change.
    const [needsRefresh, setNeedsRefresh] = useState(false)
    const admin = isProjectAdmin(project!.role)
    const runnerExists = !!readiness && ['runner', 'providers'].some(key => { const state = readinessItem(readiness, key)?.state; return state !== undefined && state !== 'missing' && state !== 'denied' })
    const change = (profile: ExecutionProfile) => void action.run(async () => {
        setNeedsRefresh(true)
        await api.request(`${projectPath(project!.id)}/profile`, { method: 'PUT', body: { profile } })
        await refresh()
        setNeedsRefresh(false)
        onChanged()
    }, 'Profil gespeichert.')
    return <div className="ev-stack">
        <p>Entscheide zuerst, was Agenten in diesem Projekt dürfen. Das Profil gilt für das ganze Projekt und wird beim Einrichten des Projektdienstes übernommen.</p>
        <p className="ev-callout" role="note"><strong>Reihenfolge beachten:</strong> Ein späterer Profilwechsel macht alle bisherigen Runner-Zugänge ungültig und stoppt den verwalteten Projektdienst; Anbieter müssen danach erneut verbunden werden. Repository-Freigaben bleiben erhalten.</p>
        {runnerExists && <p className="ev-error" role="status">Für dieses Projekt besteht bereits ein Projektdienst. Ein Wechsel jetzt widerruft ihn; verbinde danach im Schritt „Anbieter und Runner“ erneut.</p>}
        <ul className="ev-setup-choices">{profileChoices.map(choice => <li key={choice.id} data-current={project!.profile === choice.id || undefined}>
            <div><strong>{choice.label}{project!.profile === choice.id ? ' · aktuell' : ''}</strong><small>{choice.purpose}</small></div>
            {admin && project!.profile !== choice.id && !needsRefresh && <ConfirmButton label={`„${choice.label}“ wählen`} disabled={action.busy}
                detail={`Projektprofil auf „${choice.label}“ ändern?${runnerExists ? ' Bisherige Runner-Zugänge werden ungültig.' : ''} Dafür kann eine Passkey-Bestätigung nötig sein.`} onConfirm={() => change(choice.id)} />}
        </li>)}</ul>
        {!admin && <p className="ev-muted">Nur Projektadministratoren können das Profil ändern.</p>}
        {needsRefresh && !action.busy && <div className="ev-callout" role="status"><p>Ob die letzte Änderung wirksam wurde, ist unklar. Prüfe den Projektstatus, bevor du erneut wechselst.</p>
            <button type="button" onClick={() => void action.run(async () => { await refresh(); setNeedsRefresh(false); onChanged() }, 'Projektstatus aktualisiert.')}>Projektstatus aktualisieren</button></div>}
        <ErrorNotice error={action.error} />{action.notice && <p className="ev-success" role="status">{action.notice}</p>}
    </div>
}

function ProviderStep({ readiness, readinessError, refetch, fetching }: { readiness: ProjectReadiness | null; readinessError: unknown; refetch: () => void; fetching: boolean }) {
    const { project } = useEvolved()
    const items = ['runner', 'rpc', 'agents', 'providers'].map(key => readinessItem(readiness, key)).filter(item => !!item)
    return <div className="ev-stack">
        {project!.profile === 'restricted' && isProjectAdmin(project!.role) && <p className="ev-callout" role="note">Das Profil ist „Eingeschränkt“. Der Projektdienst übernimmt dieses Profil; wechselst du später, musst du hier erneut verbinden. <WorkspaceLink tab="setup" projectId={project!.id} step="profile">Zum Profil</WorkspaceLink></p>}
        {readinessError != null && <p className="ev-error" role="alert">Bereitschaft nicht geladen: {describeDevelopmentError(readinessError)}</p>}
        {items.length > 0 && <ul className="ev-setup-facts">{items.map(item => <li key={item.key}><span>{item.label}</span><span className="ev-setup-badge" data-state={item.state === 'ok' ? 'done' : item.state === 'missing' ? 'todo' : item.state === 'denied' ? 'admin' : 'unknown'}>{item.state === 'ok' ? 'Bereit' : item.state === 'missing' ? 'Fehlt' : item.state === 'denied' ? 'Admin' : 'Unbestätigt'}</span><small>{item.detail}</small></li>)}</ul>}
        <button type="button" disabled={fetching} onClick={refetch}>Bereitschaft erneut prüfen</button>
        <p className="ev-muted">Angemeldet heißt: die Anbieter-CLI auf dem Runner hat die Anmeldung bestätigt. Kontingent und Modellfreigabe prüft der Anbieter erst beim Start einer Sitzung.</p>
        <ProviderLoginPanel />
    </div>
}

/** Token permissions per purpose; nothing here is checked live except through an explicit status request later. */
function TokenPermissions({ statusWanted }: { statusWanted: boolean }) {
    return <details className="ev-setup-help" open={statusWanted}><summary>Welche GitHub-Tokenrechte wofür?</summary>
        <ul className="ev-dev-links">
            <li><strong>Contents: Read-only</strong> und <strong>Metadata: Read-only</strong> – Freigeben und Klonen (auch für eine Enterprise-Quelle ausreichend).</li>
            <li><strong>Contents: Read and write</strong> – nur wenn Agenten pushen sollen.</li>
            <li><strong>Commit statuses: Read-only</strong> – optional, nur damit HAPI Build-Statusmeldungen (z. B. von Odoo.sh) lesen kann.</li>
        </ul>
        <p className="ev-muted">Damit Odoo.sh überhaupt Statusmeldungen an GitHub schickt, braucht Odoo.sh selbst in seinen Projekteinstellungen ein eigenes GitHub-Token mit „Commit statuses: Read and write“. Das richtest du in Odoo.sh ein; HAPI sieht diese Einstellung nicht und meldet keine Verbindung, solange keine Statusmeldung vorliegt.</p>
    </details>
}

function GithubStep({ catalog, modules, intent, repositoryRequired, onBind }: { catalog: RepositoryCatalog | undefined; modules: DevelopmentModulesResponse | undefined; intent: SetupIntent | null; repositoryRequired: boolean | null; onBind: (repositoryId: string) => void }) {
    const { project } = useEvolved()
    const settings = intent?.draft?.settings ?? modules?.config.settings
    const boundId = intendedSettings(intent).repositoryId ?? settings?.repositoryId ?? null
    const odoo = settings?.activeModuleId === 'builtin:odoo' ? settings.odoo : null
    const admin = isProjectAdmin(project!.role)
    const unbound = catalog?.repositories.filter(item => item.id !== boundId && item.id !== odoo?.enterpriseRepositoryId) ?? []
    return <div className="ev-stack">
        <ol className="ev-setup-sequence">
            <li><strong>Verbinden:</strong> Fine-grained Token unten eintragen (Projektadministrator, Passkey-Bestätigung).</li>
            <li><strong>Freigeben:</strong> genau die Repositorys dieses Projekts als <code>owner/repository</code> freigeben.</li>
            <li><strong>Klonen:</strong> „Ins Projekt klonen“ holt den Code in den Projektordner (Profil „Arbeitsbereich“ nötig).</li>
            <li><strong>Binden:</strong> das geklonte Repository als Standard für Sitzungen und Modul wählen – das geschieht erst mit „Speichern“ im Schritt Modul.</li>
        </ol>
        {repositoryRequired === false && <p className="ev-muted">Das gewählte Modul braucht kein Repository (zum Beispiel nur Handbuch und Planung). Dieser Schritt ist optional.</p>}
        {project!.profile === 'restricted' && <p className="ev-callout" role="note">Klonen ist im Profil „Eingeschränkt“ gesperrt. Freigaben kannst du trotzdem schon speichern. <WorkspaceLink tab="setup" projectId={project!.id} step="profile">Zum Profil</WorkspaceLink></p>}
        {admin && unbound.some(item => item.local.state === 'ready') && <div className="ev-callout" role="status"><p>Geklont, aber nicht als Standard gewählt:</p>
            <ul className="ev-setup-facts">{unbound.filter(item => item.local.state === 'ready').map(item => <li key={item.id}><span>{item.fullName}</span>
                <button type="button" onClick={() => onBind(item.id)}>Als Standard vormerken und zum Modul</button></li>)}</ul>
            <p className="ev-muted">Vormerken speichert nichts; du prüfst und speicherst im nächsten Schritt.</p></div>}
        {odoo?.edition === 'enterprise' && <EnterpriseGuide major={odoo.major} catalog={catalog} enterpriseId={odoo.enterpriseRepositoryId} odooSh={odoo.hosting === 'odoo_sh'} />}
        <TokenPermissions statusWanted={odoo?.hosting === 'odoo_sh'} />
        <GithubPanel />
    </div>
}

/** Enterprise addons for local work are a separate authorised GitHub repository; HAPI never obtains, licenses or downloads them. */
export function EnterpriseGuide({ major, catalog, enterpriseId, odooSh }: { major: number; catalog: RepositoryCatalog | undefined; enterpriseId: string | null; odooSh: boolean }) {
    const { project } = useEvolved()
    const chosen = enterpriseId ? catalog?.repositories.find(item => item.id === enterpriseId) : undefined
    return <div className="ev-callout ev-setup-enterprise" role="note">
        <p><strong>Odoo Enterprise-Quelle</strong> {chosen ? `· gewählt: ${chosen.fullName} (${chosen.local.state === 'ready' ? `geklont${chosen.local.branch ? `, Branch ${chosen.local.branch}` : ''}` : 'noch nicht geklont'})` : enterpriseId ? '· gewählte Quelle ist nicht mehr freigegeben' : '· keine gewählt (optional)'}</p>
        <p>{odooSh ? 'Odoo.sh stellt die Enterprise-Addons selbst bereit. ' : ''}Ein eigener Enterprise-Checkout ist nur für lokale Arbeit nötig und nur, wenn ihr berechtigten Zugriff auf ein passendes GitHub-Repository habt. HAPI prüft keine Lizenz und beschafft keine Quellen.</p>
        <ol className="ev-setup-sequence">
            <li>Freigeben: das Repository als <code>owner/repository</code> im GitHub-Bereich unten freigeben. „Nur lesen“ genügt.</li>
            <li>Klonen: separat „Ins Projekt klonen“ und prüfen, dass der Branch zur Odoo-Version passt (<code>{major}.0</code>).</li>
            <li>Wählen: im Schritt Modul als „Enterprise-Quelle“. Die Auswahl allein klont nichts und nimmt die Quelle nicht automatisch in die Addon-Pfade lokaler Tests auf; die mitgelieferte Testhilfe bindet einen separaten Enterprise-Checkout nicht selbst ein.</li>
        </ol>
        {chosen?.local.state === 'ready' && chosen.local.branch && chosen.local.branch !== `${major}.0` && <p className="ev-error">Ausgecheckt ist {chosen.local.branch}, erwartet für Odoo {major} wird {major}.0.</p>}
        <p className="ev-muted">Grenze: Die GitHub-Verbindung eines Projekts nutzt ein einziges Fine-grained Token, und ein solches Token gilt für genau einen Eigentümer (Konto oder Organisation). Liegt die Enterprise-Quelle bei einem anderen Eigentümer als euer Projekt-Repository, lässt sie sich mit dieser Verbindung nicht freigeben; ein Ersetzen der Verbindung entfernt alle bisherigen Freigaben.</p>
        <p className="ev-muted">Nicht verwechseln: Die Odoo.sh-Build-ID ist eine Zahl aus Odoo.sh (z. B. <code>25004381</code>); ein GitHub-Repository wird über <code>owner/repository</code> freigegeben. <WorkspaceLink tab="setup" projectId={project!.id} step="module">Zum Schritt Modul</WorkspaceLink></p>
    </div>
}

function ModuleStep({ intent, onDraftChange }: { intent: SetupIntent | null; onDraftChange: (draft: DevelopmentModuleSettingsInput | null, baseRevision: number) => void }) {
    return <div className="ev-stack">
        <p>Wähle das Modul, binde das Standard-Repository und ergänze Pflichtangaben. Gespeichert wird nur mit „Speichern“; der Server prüft Freigaben und Modulfassung erneut. Ungespeicherte Eingaben bleiben in diesem Browser für dieses Projekt erhalten, auch wenn du zwischendurch zu GitHub wechselst.</p>
        <ProjectDevelopmentPanel section="settings" intent={intent} onDraftChange={onDraftChange} />
    </div>
}

function ChecksStep() {
    const { project } = useEvolved()
    return <div className="ev-stack">
        <p>Prüfe zuerst die Werkzeuge auf dem Projektrunner. Fehlt etwas, öffnet die Abhilfe das Startformular der passenden Einrichtungsaufgabe; gestartet wird erst dort und erst nach deiner Bestätigung.</p>
        {!canWriteProject(project!.role) && <p className="ev-muted">Mit lesendem Zugang kannst du Ergebnisse und Aufgaben ansehen, aber nichts starten.</p>}
        {project!.profile === 'restricted' && <p className="ev-callout" role="note">Im Profil „Eingeschränkt“ lassen sich nur lesende Aufgaben starten. Einrichtungs- und Testaufgaben brauchen „Arbeitsbereich“. <WorkspaceLink tab="setup" projectId={project!.id} step="profile">Zum Profil</WorkspaceLink></p>}
        <ProjectDevelopmentPanel section="checks" />
    </div>
}

function SummaryStep({ steps, readiness, catalog, modules }: { steps: SetupStepStatus[]; readiness: ProjectReadiness | null; catalog: RepositoryCatalog | undefined; modules: DevelopmentModulesResponse | undefined }) {
    const { project } = useEvolved()
    const required = steps.filter(item => item.id !== 'summary' && item.state !== 'optional')
    const done = required.filter(item => item.state === 'done').length
    const settings = modules?.config.settings
    const bound = settings?.repositoryId ? catalog?.repositories.find(item => item.id === settings.repositoryId) : undefined
    const odoo = settings?.activeModuleId === 'builtin:odoo' ? settings.odoo : null
    const optional: Array<{ key: string; title: string; text: ReactNode }> = []
    if (odoo?.hosting === 'odoo_sh') optional.push({ key: 'odoo-sh', title: 'Odoo.sh', text: <>Staging und Produktion sind gespeicherte Angaben, keine Live-Verbindung. Build-Status kommt nur über GitHub-Commit-Statusmeldungen: Odoo.sh muss sie senden (Token in Odoo.sh), HAPI braucht „Commit statuses: Read-only“. Abruf im Schritt „Prüfen und einrichten“.</> })
    for (const key of ['memory', 'codegraph']) { const item = readinessItem(readiness, key); if (item) optional.push({ key, title: item.label, text: item.detail }) }
    optional.push({ key: 'mcp', title: 'Externe Werkzeuge (MCP)', text: <>Für lokale Odoo-Arbeit nicht nötig. <WorkspaceLink tab="mcp" projectId={project!.id} from="setup" step="summary">MCP-Shop</WorkspaceLink></> })
    const chatReady = !settings?.repositoryId || (bound?.local.state === 'ready' && bound.job?.state !== 'running' && catalog?.runner.status === 'ready')
    return <div className="ev-stack">
        <p role="status"><strong>{done} von {required.length}</strong> prüfbaren Schritten erfüllt. Das ist ein Stand der gespeicherten Daten, keine Zusage, dass jede Aufgabe gelingt.</p>
        <ul className="ev-setup-facts">{steps.filter(item => item.id !== 'summary').map(item => <li key={item.id}><span>{stepTitles[item.id]}</span><span className="ev-setup-badge" data-state={item.state}>{stepStateLabels[item.state]}</span><small>{item.detail}</small></li>)}</ul>
        <h3>Optional</h3>
        <ul className="ev-setup-facts">{optional.map(item => <li key={item.key}><span>{item.title}</span><span className="ev-setup-badge" data-state="optional">Optional</span><small>{item.text}</small></li>)}</ul>
        <div className="ev-actions">{canWriteProject(project!.role) && chatReady
            ? <Link to="/sessions/new" search={{ projectId: project!.id, ...(settings?.repositoryId ? { repositoryId: settings.repositoryId } : {}) }} className="ev-primary-link">Neue Sitzung {bound ? `in ${bound.fullName}` : 'im Projektordner'} vorbereiten</Link>
            : <p className="ev-muted">{!canWriteProject(project!.role) ? 'Sitzungen starten Mitglieder und Administratoren.' : 'Eine Sitzung im Standard-Repository ist erst möglich, wenn es geklont und der Projektdienst erreichbar ist.'}</p>}</div>
    </div>
}
