/**
 * Read-only readiness checks of the bundled Claude Ads module (provider `hapi.claude-ads` v1). Probes the pinned
 * Python runtime, verifies the vendored asset provenance, compares the native skill trees with their ownership
 * manifests and inspects the report directory. Installs, writes and executes nothing from the project; reports
 * no environment values.
 */
import { CLAUDE_ADS_ARTIFACTS_DIRECTORY, CLAUDE_ADS_UPSTREAM } from '@hapi/protocol/bundledPlugins'
import { HAPI_CLAUDE_ADS_CHECKS } from '@hapi/protocol/developmentModules'
import type { DevelopmentDoctorCheck } from '@hapi/protocol/evolvedDevelopment'
import { runToolchainDoctor, type ToolchainDoctorReport } from '../development/doctor'
import { verifyAdsAssets, type AdsAssetsResult } from './assets'
import { statBelow } from './files'
import { probeAdsPython } from './python'
import { adsSkillState, planAdsSkills, type AdsSkillTarget } from './skills'

export const ADS_DOCTOR_CHECK_IDS = Object.keys(HAPI_CLAUDE_ADS_CHECKS)
type Input = { projectRoot: string | null; checkout: string | null; checks: readonly string[]; env?: NodeJS.ProcessEnv; assetsRoot?: string }

function check(id: string, state: DevelopmentDoctorCheck['state'], extra: Partial<DevelopmentDoctorCheck> = {}): DevelopmentDoctorCheck {
    const label = HAPI_CLAUDE_ADS_CHECKS[id]!
    return { id, label: label.label, category: label.category, state, ...extra, ...(extra.detail ? { detail: extra.detail.slice(0, 500) } : {}) }
}

function pythonCheck(env: NodeJS.ProcessEnv | undefined): DevelopmentDoctorCheck {
    const probe = probeAdsPython(env)
    if (probe.ready) return check('ads.python', 'ready', { version: `Python ${probe.ready.version}`, detail: probe.ready.path })
    const seen = probe.unsupported.map(item => `${item.version} (${item.path})`).join(', ')
    return check('ads.python', probe.unsupported.length ? 'unsupported' : 'missing', {
        detail: seen ? `Gefunden: ${seen}. claude-ads unterstützt nur CPython 3.11 und 3.12.` : 'Kein Python 3.11/3.12 gefunden.',
        remedy: { kind: 'operator', text: 'Runner-Image mit separatem Python 3.12 unter /opt/hapi-ads-python (oder python3.12/3.11) verwenden; System-Python 3.13 und Odoo bleiben unverändert.' },
    })
}

function assetsCheck(result: AdsAssetsResult): DevelopmentDoctorCheck {
    if (result.ok) return check('ads.assets', 'ready', { version: `claude-ads ${CLAUDE_ADS_UPSTREAM.skillVersion} · core ${CLAUDE_ADS_UPSTREAM.coreVersion}`,
        detail: `${CLAUDE_ADS_UPSTREAM.displayRepository}@${CLAUDE_ADS_UPSTREAM.commit.slice(0, 12)}, ${result.assets.files.length} Dateien per SHA-256 geprüft` })
    return check('ads.assets', 'missing', { detail: result.reason, remedy: { kind: 'operator', text: 'Ein vollständiges HAPI-eVolved-Release mit vendor/claude-ads verwenden; die Dateien werden nicht nachgeladen.' } })
}

function skillsCheck(id: string, target: AdsSkillTarget, assets: AdsAssetsResult, workspace: string | null): DevelopmentDoctorCheck {
    if (!assets.ok) return check(id, 'unknown', { detail: 'Ohne geprüfte Assets nicht vergleichbar.' })
    if (!workspace) return check(id, 'unknown', { detail: 'Kein Projektordner bekannt.' })
    let plan
    try { plan = planAdsSkills(assets.assets, workspace, target) } catch (error) { return check(id, 'warning', { detail: (error as Error).message }) }
    const state = adsSkillState(plan), where = target === 'claude' ? '.claude/skills und .claude/agents' : '.agents/skills'
    const install = { kind: 'recipe' as const, recipeId: 'install-skills', text: 'Aufgabe „Native Skills einrichten“ starten oder hapi evolved ads install-skills ausführen.' }
    switch (state) {
        case 'installed': return check(id, 'ready', { detail: `Installiert in ${workspace}: ${where} (${plan.unchanged.length} Dateien, fc3908e).` })
        case 'not_installed': return check(id, 'missing', { detail: `Nicht installiert in ${workspace} (${where}).`, remedy: install })
        case 'incomplete': return check(id, 'warning', { detail: `Unvollständig in ${workspace} (${where}): ${plan.create.length} Dateien fehlen.`, remedy: install })
        case 'conflict': return check(id, 'warning', { detail: `${plan.conflicts.length} abweichende oder fremde Dateien in ${where} (${workspace}); HAPI ersetzt und löscht nichts.`, remedy: { kind: 'manual', text: 'Abweichende Dateien prüfen und bewusst entfernen oder verschieben; danach erneut einrichten.' } })
    }
}

function artifactsCheck(projectRoot: string | null): DevelopmentDoctorCheck {
    if (!projectRoot) return check('ads.artifacts', 'unknown', { detail: 'Kein Projektordner bekannt.' })
    try {
        const { kind } = statBelow(projectRoot, CLAUDE_ADS_ARTIFACTS_DIRECTORY)
        if (kind === 'missing') return check('ads.artifacts', 'ready', { detail: `${CLAUDE_ADS_ARTIFACTS_DIRECTORY}/ wird beim ersten Export angelegt.` })
        if (kind !== 'directory') return check('ads.artifacts', 'warning', { detail: `${CLAUDE_ADS_ARTIFACTS_DIRECTORY} ist kein Verzeichnis.` })
        return check('ads.artifacts', 'ready', { detail: `${CLAUDE_ADS_ARTIFACTS_DIRECTORY}/ vorhanden.` })
    } catch (error) { return check('ads.artifacts', 'warning', { detail: (error as Error).message }) }
}

export async function runAdsDoctor(input: Input): Promise<ToolchainDoctorReport> {
    const started = Date.now()
    const base = await runToolchainDoctor({ projectRoot: input.projectRoot, checkout: input.checkout, checks: [] })
    const wanted = (input.checks.length ? input.checks : ADS_DOCTOR_CHECK_IDS).filter(id => ADS_DOCTOR_CHECK_IDS.includes(id))
    const assets = verifyAdsAssets(input.assetsRoot)
    // Sessions start in the bound checkout when one exists, otherwise in the project folder: check that workspace.
    const workspace = input.checkout ?? input.projectRoot
    const checks = [...new Set(wanted)].map(id => {
        if (id === 'ads.python') return pythonCheck(input.env)
        if (id === 'ads.assets') return assetsCheck(assets)
        if (id === 'ads.skills.claude') return skillsCheck(id, 'claude', assets, workspace)
        if (id === 'ads.skills.codex') return skillsCheck(id, 'codex', assets, workspace)
        return artifactsCheck(input.projectRoot)
    })
    return { observedAt: Date.now(), durationMs: Math.min(120_000, Date.now() - started), host: base.host, checks, truncated: false }
}
