import { useState, type ReactNode } from 'react'
import type { AndroidSettings, IosSettings, OdooMajor, OdooSettings, ProjectDevelopmentConfig } from '@hapi/protocol/evolvedDevelopment'
import type { RepositoryChoices } from './repositoryCatalog'
import { SegmentedChoice } from './DevelopmentModePicker'
import { ANDROID_SDK_TERMS_URL, formatTimestamp } from './developmentApi'
import { WorkspaceLink } from './workspaceNavigation'

type Common = { disabled: boolean; invalidField: string | null; projectId: string }

function invalid(invalidField: string | null, path: string) {
    return !!invalidField && (invalidField === path || invalidField.startsWith(`${path}.`))
}
function Labeled({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
    return <label className="ev-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
/** Optional text value: an empty field stores null instead of an empty string. */
function TextSetting({ label, value, onChange, hint, placeholder, disabled, isInvalid, maxLength = 512 }: {
    label: string; value: string | null; onChange: (value: string | null) => void; hint?: ReactNode; placeholder?: string; disabled: boolean; isInvalid: boolean; maxLength?: number
}) {
    return <Labeled label={label} hint={hint}><input value={value ?? ''} placeholder={placeholder} disabled={disabled} maxLength={maxLength} aria-invalid={isInvalid || undefined} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        onChange={event => onChange(event.target.value.trim() ? event.target.value : null)} /></Labeled>
}
/** Keeps the raw text while typing (trailing separators) and reports the parsed list. */
function ListSetting({ label, value, onChange, hint, placeholder, disabled, isInvalid }: {
    label: string; value: string[]; onChange: (value: string[]) => void; hint?: ReactNode; placeholder?: string; disabled: boolean; isInvalid: boolean
}) {
    const [text, setText] = useState(value.join('\n'))
    return <Labeled label={label} hint={hint}><textarea rows={Math.min(4, Math.max(2, value.length + 1))} value={text} placeholder={placeholder} disabled={disabled} aria-invalid={isInvalid || undefined} spellCheck={false} autoCapitalize="off"
        onChange={event => { setText(event.target.value); onChange(event.target.value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean)) }} /></Labeled>
}
function NumberSetting({ label, value, onChange, disabled, isInvalid, hint }: { label: string; value: number | null; onChange: (value: number | null) => void; disabled: boolean; isInvalid: boolean; hint?: string }) {
    return <Labeled label={label} hint={hint}><input type="number" inputMode="numeric" min={1} max={99} step={1} placeholder="aus dem Projekt" value={value === null || Number.isNaN(value) ? '' : value} disabled={disabled} aria-invalid={isInvalid || undefined}
        onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))} /></Labeled>
}

/** Granted repositories only. A stored ID that is no longer granted stays visible as unavailable. */
export function RepositorySelect({ label, choices, value, onChange, disabled, exclude, hint, emptyLabel }: {
    label: string; choices: RepositoryChoices; value: string | null; onChange: (id: string | null) => void; disabled: boolean; exclude?: string | null; hint?: ReactNode; emptyLabel: string
}) {
    const repositories = choices.current?.repositories.filter(item => item.id !== exclude) ?? []
    const selected = value ? choices.current?.repositories.find(item => item.id === value) : undefined
    return <Labeled label={label} hint={hint}><select value={value ?? ''} disabled={disabled || choices.isFetching} onChange={event => onChange(event.target.value || null)}>
        <option value="">{emptyLabel}</option>
        {value && !selected && <option value={value}>{choices.isFetching ? `Repository ${value} · wird geprüft` : `Repository ${value} · nicht verfügbar`}</option>}
        {repositories.map(item => <option key={item.id} value={item.id}>{item.fullName}{item.local.state === 'ready' ? '' : item.local.state === 'missing' ? ' · noch nicht geklont' : ' · nicht bereit'}</option>)}
    </select></Labeled>
}

/** Explains the state of the default repository with links to the existing GitHub workflow. */
export function RepositoryStatus({ choices, repositoryId, projectId }: { choices: RepositoryChoices; repositoryId: string | null; projectId: string }) {
    if (choices.error) return <p className="ev-dev-invalid" role="status">Freigegebene Repositorys konnten nicht geladen werden. Eine gespeicherte Auswahl bleibt unverändert. <button type="button" onClick={() => void choices.refetch()}>Erneut prüfen</button></p>
    if (choices.isPending || choices.isFetching) return <p className="ev-muted" role="status">Repository-Freigaben werden geprüft …</p>
    const catalog = choices.current
    if (!catalog) return null
    if (!catalog.connected) return <p className="ev-muted" role="status">GitHub ist für dieses Projekt nicht verbunden. <WorkspaceLink tab="github" projectId={projectId}>GitHub verbinden</WorkspaceLink></p>
    if (!repositoryId) return <p className="ev-muted">{catalog.repositories.length ? 'Ohne Standard-Repository starten Sitzungen im Projektordner, solange du nichts anderes wählst.' : 'Noch kein Repository freigegeben.'} <WorkspaceLink tab="github" projectId={projectId}>Repositorys freigeben</WorkspaceLink></p>
    const repository = catalog.repositories.find(item => item.id === repositoryId)
    if (!repository) return <p className="ev-dev-invalid" role="status">Repository {repositoryId} ist nicht mehr freigegeben oder wurde umbenannt. Sitzungen nutzen es nicht; wähle ein anderes oder gib es im Bereich GitHub erneut frei.</p>
    const link = <WorkspaceLink tab="github" projectId={projectId}>Im Bereich GitHub öffnen</WorkspaceLink>
    if (repository.local.state === 'missing') return <p className="ev-muted" role="status">{repository.fullName} ist freigegeben, aber noch nicht im Projekt geklont. Klone es im Bereich GitHub; vorher können Sitzungen dort nicht starten. {link}</p>
    if (repository.local.state !== 'ready') return <p className="ev-muted" role="status">{repository.fullName} ist derzeit nicht nutzbar{repository.local.message ? `: ${repository.local.message}` : '.'} {link}</p>
    return <p className="ev-muted" role="status">{repository.fullName} · {repository.permission === 'write' ? 'lesen und schreiben' : 'nur lesen'} · geklont{repository.local.branch ? ` (Branch ${repository.local.branch})` : ''}. {link}</p>
}

const hostingLabels = { local: 'Lokal', self_hosted: 'Selbst gehostet', odoo_sh: 'Odoo.sh' } as const
const stageLabels = { development: 'Entwicklung', staging: 'Staging', production: 'Produktion' } as const

export function OdooFields({ value, onChange, majors, choices, repositoryId, ...common }: Common & {
    value: OdooSettings; onChange: (value: OdooSettings) => void; majors: readonly OdooMajor[]; choices: RepositoryChoices; repositoryId: string | null
}) {
    const { disabled, invalidField, projectId } = common
    const set = <K extends keyof OdooSettings>(key: K, next: OdooSettings[K]) => onChange({ ...value, [key]: next })
    const setSh = (next: Partial<OdooSettings['odooSh']>) => onChange({ ...value, odooSh: { ...value.odooSh, ...next } })
    const sshCommand = value.odooSh.buildId && value.odooSh.buildHost ? `ssh ${value.odooSh.buildId}@${value.odooSh.buildHost}` : null
    return <>
        <div className="ev-dev-wide"><span className="ev-dev-field-label" id="ev-dev-odoo-major">Odoo-Version</span>
            <SegmentedChoice legend="Odoo-Version" describedBy="ev-dev-odoo-major" options={majors.map(major => ({ id: String(major) as `${OdooMajor}`, label: `${major}.0` }))} value={String(value.major) as `${OdooMajor}`} disabled={disabled} onChange={major => set('major', Number(major) as OdooMajor)} />
            <p className="ev-dev-mode-hint">{value.major === 19 ? 'Odoo 19 braucht Python ≥ 3.10 und PostgreSQL ≥ 13.' : 'Odoo 20 braucht Python ≥ 3.12 und PostgreSQL ≥ 16.'} Handbuch, Prüfungen und Aufgaben folgen nach dem Speichern dieser Version.</p>
        </div>
        <div><span className="ev-dev-field-label">Edition</span><SegmentedChoice legend="Edition" options={[{ id: 'community', label: 'Community' }, { id: 'enterprise', label: 'Enterprise' }]} value={value.edition} disabled={disabled} onChange={edition => onChange({ ...value, edition, enterpriseRepositoryId: edition === 'community' ? null : value.enterpriseRepositoryId })} /></div>
        <div><span className="ev-dev-field-label">Betrieb</span><SegmentedChoice legend="Betrieb" options={(['local', 'self_hosted', 'odoo_sh'] as const).map(id => ({ id, label: hostingLabels[id] }))} value={value.hosting} disabled={disabled}
            onChange={hosting => onChange({ ...value, hosting, ...(hosting === 'odoo_sh' ? {} : { odooSh: { dashboardUrl: null, buildId: null, buildHost: null, sshResourceId: null } }) })} />
            {value.hosting !== 'odoo_sh' && <small className="ev-muted">Odoo.sh-Angaben werden nur beim Betrieb auf Odoo.sh gespeichert.</small>}</div>
        {value.edition === 'enterprise' && <div className="ev-dev-wide"><RepositorySelect label="Enterprise-Repository (optional)" emptyLabel="Keines" choices={choices} value={value.enterpriseRepositoryId} exclude={repositoryId} disabled={disabled} onChange={id => set('enterpriseRepositoryId', id)}
            hint="Nur ein bereits freigegebenes Repository mit berechtigtem Enterprise-Zugang. HAPI klont Enterprise-Quellen nie automatisch." /></div>}
        <ListSetting label="Addon-Pfade im Repository" value={value.addonsPaths} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.addonsPaths')} placeholder="." onChange={paths => set('addonsPaths', paths)} hint="Einer pro Zeile, relativ zum Repository. „.“ ist das Repository selbst." />
        <ListSetting label="Module im Fokus (optional)" value={value.modules} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.modules')} placeholder="sale_custom" onChange={modules => set('modules', modules)} hint="Technische Namen. Leer lassen, um sie per Modulprüfung zu ermitteln." />
        <TextSetting label="Entwicklungs-Branch (optional)" value={value.developmentBranch} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.developmentBranch')} placeholder="z. B. dev-feature" onChange={branch => onChange({ ...value, developmentBranch: branch, stage: branch ? value.stage : null })} maxLength={200} />
        <Labeled label="Stufe dieses Branches" hint={value.stage === 'production' ? 'Achtung: Ein Push auf einen Produktions-Branch kann sofort deployen.' : value.hosting === 'odoo_sh' ? 'Auf Odoo.sh kann ein Push einen Build oder ein Deployment auslösen.' : undefined}>
            <select value={value.stage ?? ''} disabled={disabled || !value.developmentBranch} aria-invalid={invalid(invalidField, 'odoo.stage') || undefined} onChange={event => set('stage', (event.target.value || null) as OdooSettings['stage'])}>
                <option value="">Nicht angegeben</option>{(['development', 'staging', 'production'] as const).map(stage => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}
            </select></Labeled>
        <Labeled label="Kürzel der Testdatenbank" hint={<>Lokale Wegwerf-Datenbank <code>hapi_test_{value.testDatabaseSlug || '…'}</code>; Tests laufen nie gegen geteilte oder produktive Daten.</>}>
            <input value={value.testDatabaseSlug} disabled={disabled} maxLength={32} aria-invalid={invalid(invalidField, 'odoo.testDatabaseSlug') || undefined} spellCheck={false} autoCapitalize="off" onChange={event => set('testDatabaseSlug', event.target.value.trim())} /></Labeled>
        {value.hosting === 'odoo_sh' && <details className="ev-dev-wide" open={!!(value.odooSh.dashboardUrl || value.odooSh.buildId)}>
            <summary>Odoo.sh-Angaben (optional)</summary>
            <p className="ev-muted">Aus dem Odoo.sh-Dashboard kopiert. HAPI hat keine Verbindung zu Odoo.sh; Build-Status kommt nur über GitHub-Commit-Statusmeldungen.</p>
            <div className="ev-dev-form">
                <div className="ev-dev-wide"><TextSetting label="Odoo.sh-Projektlink" value={value.odooSh.dashboardUrl} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.odooSh.dashboardUrl')} placeholder="https://www.odoo.sh/project/mein-projekt" onChange={dashboardUrl => setSh({ dashboardUrl })} maxLength={500} /></div>
                <TextSetting label="Build-ID" value={value.odooSh.buildId} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.odooSh.buildId') || invalidField === 'odoo.odooSh'} placeholder="12345678" onChange={buildId => setSh({ buildId, sshResourceId: buildId ? value.odooSh.sshResourceId : null })} maxLength={12} />
                <TextSetting label="Build-Host" value={value.odooSh.buildHost} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.odooSh.buildHost') || invalidField === 'odoo.odooSh'} placeholder="projekt-branch-12345678.dev.odoo.com" onChange={buildHost => setSh({ buildHost: buildHost?.toLowerCase() ?? null })} maxLength={253} />
                <div className="ev-dev-wide"><TextSetting label="Vorhandene SSH-Ressource im Tresor (optional)" value={value.odooSh.sshResourceId} disabled={disabled || !value.odooSh.buildId} isInvalid={invalid(invalidField, 'odoo.odooSh.sshResourceId')} onChange={sshResourceId => setSh({ sshResourceId })} maxLength={128}
                    hint={<>Nur die ID einer vom Betreiber eingerichteten Ressource, kein Schlüssel. <WorkspaceLink tab="vault" projectId={projectId}>Tresor öffnen</WorkspaceLink></>} /></div>
                {sshCommand && <div className="ev-dev-wide ev-callout"><p>Befehl zum Kopieren (HAPI führt ihn nicht aus): <code>{sshCommand}</code></p><p className="ev-muted">Hinterlege deinen öffentlichen Schlüssel in deinem Odoo.sh-Profil und prüfe den Host-Fingerabdruck beim ersten Verbinden selbst. Entwicklungs-Builds sind kurzlebig; der Host ändert sich mit jedem Build.</p></div>}
            </div>
        </details>}
        <details className="ev-dev-wide"><summary>Anwendungs-API (optional)</summary>
            <TextSetting label="Vorhandene Tresor-Ressource für JSON-2" value={value.applicationResourceId} disabled={disabled} isInvalid={invalid(invalidField, 'odoo.applicationResourceId')} onChange={applicationResourceId => set('applicationResourceId', applicationResourceId)} maxLength={128}
                hint={<>Verweis auf die Geschäfts-API einer Odoo-Datenbank (ab Odoo 19), nicht auf Odoo.sh. Zugangsdaten bleiben im Tresor. <WorkspaceLink tab="vault" projectId={projectId}>Tresor öffnen</WorkspaceLink></>} />
        </details>
    </>
}

const strategyLabels = { undecided: 'Noch offen', local_mac: 'Eigener Mac', xcode_cloud: 'Xcode Cloud', github_actions: 'GitHub Actions' } as const
export function IosFields({ value, onChange, ...common }: Common & { value: IosSettings; onChange: (value: IosSettings) => void }) {
    const { disabled, invalidField, projectId } = common
    const set = <K extends keyof IosSettings>(key: K, next: IosSettings[K]) => onChange({ ...value, [key]: next })
    return <>
        <div className="ev-dev-wide ev-callout" role="note"><strong>Plattformgrenzen:</strong> Linux-Runner können iOS-Apps weder mit Xcode bauen noch UIKit/SwiftUI ausführen oder einen Simulator starten. Dort sind Codearbeit und portable Swift-Pakete möglich. Native Builds laufen auf einem Mac, in Xcode Cloud oder GitHub Actions.</div>
        <TextSetting label="App-Ordner im Repository" value={value.projectDirectory} disabled={disabled} isInvalid={invalid(invalidField, 'ios.projectDirectory')} onChange={directory => set('projectDirectory', directory ?? '.')} hint="„.“ ist das Repository selbst." />
        <TextSetting label="Projektdatei (optional)" value={value.projectFile} disabled={disabled} isInvalid={invalid(invalidField, 'ios.projectFile')} placeholder="App.xcodeproj" onChange={file => set('projectFile', file)} hint=".xcodeproj, .xcworkspace oder Package.swift" />
        <TextSetting label="Scheme (optional)" value={value.scheme} disabled={disabled} isInvalid={invalid(invalidField, 'ios.scheme')} onChange={scheme => set('scheme', scheme)} maxLength={100} />
        <TextSetting label="Bundle-ID (optional)" value={value.bundleId} disabled={disabled} isInvalid={invalid(invalidField, 'ios.bundleId')} placeholder="com.beispiel.app" onChange={bundleId => set('bundleId', bundleId)} maxLength={155} />
        <TextSetting label="Mindestversion iOS (optional)" value={value.deploymentTarget} disabled={disabled} isInvalid={invalid(invalidField, 'ios.deploymentTarget')} placeholder="aus dem Projekt" onChange={target => set('deploymentTarget', target)} maxLength={5} />
        <div className="ev-dev-wide"><span className="ev-dev-field-label">Wo laufen native Builds?</span>
            <SegmentedChoice legend="Build-Strategie" options={(['undecided', 'local_mac', 'xcode_cloud', 'github_actions'] as const).map(id => ({ id, label: strategyLabels[id] }))} value={value.buildStrategy} disabled={disabled}
                onChange={buildStrategy => onChange({ ...value, buildStrategy, xcodeCloudResourceId: buildStrategy === 'xcode_cloud' ? value.xcodeCloudResourceId : null })} />
            {value.buildStrategy === 'xcode_cloud' && <p className="ev-dev-mode-hint">Xcode Cloud wird von Hand eingerichtet: Die erste Verbindung von App und Repository geht nur in Xcode auf einem Mac, mit eigener Apple-Anmeldung. Ein Verweis hier ist <strong>keine aktive Verbindung</strong>; HAPI startet keine Cloud-Builds und lädt nichts zu TestFlight hoch.</p>}
            {value.buildStrategy === 'github_actions' && <p className="ev-dev-mode-hint">Builds laufen in deinen GitHub-Workflows auf macOS-Runnern. HAPI zeigt nur GitHub-Commit-Statusmeldungen an und startet keine Workflows.</p>}
            {value.buildStrategy === 'local_mac' && <p className="ev-dev-mode-hint">Builds laufen auf deinem Mac. HAPI hat keinen Zugriff auf ihn, solange dort kein eigener Runner verbunden ist.</p>}
        </div>
        {value.buildStrategy === 'xcode_cloud' && <div className="ev-dev-wide"><TextSetting label="Verweis auf Tresor-Ressource oder MCP-Server (optional)" value={value.xcodeCloudResourceId} disabled={disabled} isInvalid={invalid(invalidField, 'ios.xcodeCloudResourceId')} onChange={id => set('xcodeCloudResourceId', id)} maxLength={128}
            hint={<>Nur eine vorhandene, freigegebene Ressource; Zugangsdaten werden nie hier eingetragen. <WorkspaceLink tab="vault" projectId={projectId}>Tresor</WorkspaceLink> · <WorkspaceLink tab="mcp" projectId={projectId}>MCP-Shop</WorkspaceLink></>} /></div>}
    </>
}

export function AndroidFields({ value, onChange, canEdit, acknowledgement, ...common }: Common & {
    value: AndroidSettings; onChange: (value: AndroidSettings) => void; canEdit: boolean; acknowledgement: ProjectDevelopmentConfig['androidSdkLicenseAcknowledgement']
}) {
    const { disabled, invalidField } = common
    const set = <K extends keyof AndroidSettings>(key: K, next: AndroidSettings[K]) => onChange({ ...value, [key]: next })
    return <>
        <div className="ev-dev-wide ev-callout" role="note"><strong>Plattformgrenzen:</strong> Builds, Unit-Tests und Lint laufen auf dem Linux-Runner, sobald JDK und SDK vorhanden sind. Emulatoren brauchen zusätzlich KVM und werden nie automatisch gestartet; Geräte bereitest du selbst vor.</div>
        <TextSetting label="Projektordner im Repository" value={value.projectDirectory} disabled={disabled} isInvalid={invalid(invalidField, 'android.projectDirectory')} onChange={directory => set('projectDirectory', directory ?? '.')} hint="Ordner mit settings.gradle(.kts); „.“ ist das Repository selbst." />
        <TextSetting label="Modul" value={value.module} disabled={disabled} isInvalid={invalid(invalidField, 'android.module')} placeholder="app" onChange={module => set('module', module ?? '')} maxLength={256} />
        <TextSetting label="Variante" value={value.variant} disabled={disabled} isInvalid={invalid(invalidField, 'android.variant')} placeholder="debug" onChange={variant => set('variant', variant ?? '')} maxLength={64} />
        <TextSetting label="Application-ID (optional)" value={value.applicationId} disabled={disabled} isInvalid={invalid(invalidField, 'android.applicationId')} placeholder="com.beispiel.app" onChange={applicationId => set('applicationId', applicationId)} maxLength={155} />
        <NumberSetting label="minSdk (optional)" value={value.minSdk} disabled={disabled} isInvalid={invalid(invalidField, 'android.minSdk')} onChange={minSdk => set('minSdk', minSdk)} />
        <NumberSetting label="targetSdk (optional)" value={value.targetSdk} disabled={disabled} isInvalid={invalid(invalidField, 'android.targetSdk')} onChange={targetSdk => set('targetSdk', targetSdk)} hint="Leer lassen: Werte aus dem Projekt gelten. HAPI setzt kein „neuestes“ SDK voraus." />
        <NumberSetting label="compileSdk (optional)" value={value.compileSdk} disabled={disabled} isInvalid={invalid(invalidField, 'android.compileSdk')} onChange={compileSdk => set('compileSdk', compileSdk)} />
        <Labeled label="JDK" hint="Muss zur Gradle- und AGP-Version des Projekts passen."><select value={value.jdkMajor ?? ''} disabled={disabled} onChange={event => set('jdkMajor', event.target.value ? Number(event.target.value) as AndroidSettings['jdkMajor'] : null)}>
            <option value="">Aus dem Projekt ermitteln</option>{([17, 21, 25] as const).map(major => <option key={major} value={major}>JDK {major}</option>)}
        </select></Labeled>
        <div className="ev-dev-wide ev-dev-license" role="group" aria-labelledby="ev-dev-license-title">
            <strong id="ev-dev-license-title">Android-SDK-Lizenzen · nur durch Menschen</strong>
            <p className="ev-muted">Nur ein Projektadministrator kann diese Prüfung bestätigen, Agenten nicht. Lizenzen werden nie im Hintergrund angenommen; die Installation geschieht erst in einer ausdrücklich gestarteten Einrichtungssitzung.</p>
            <p><a href={ANDROID_SDK_TERMS_URL} target="_blank" rel="noopener noreferrer">Offizielle Android-SDK-Lizenzbedingungen lesen</a></p>
            {canEdit ? <label className="ev-check"><input type="checkbox" checked={value.sdkLicensesAcknowledged} disabled={disabled} onChange={event => set('sdkLicensesAcknowledged', event.target.checked)} />Ich habe die Android-SDK-Lizenzbedingungen gelesen und bestätige die Prüfung für dieses Projekt.</label>
                : null}
            <p className="ev-muted" role="status">{acknowledgement ? `Gespeicherte Bestätigung: ${acknowledgement.by?.displayName ?? 'gelöschtes Konto'}, ${formatTimestamp(acknowledgement.at)}.` : 'Noch keine gespeicherte Bestätigung.'}</p>
        </div>
    </>
}
