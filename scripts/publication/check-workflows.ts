import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstreamOnly = new Set([
    'android-release.yml', 'codex-mention-response.yml', 'codex-pr-review.yml',
    'issue-auto-response.yml', 'push-relay-image.yml', 'release.yml', 'webapp.yml',
])
const privilegedEvents = new Set(['pull_request_target', 'issues', 'issue_comment', 'pull_request_review_comment'])

type Mapping = Record<string, any>

// Deliberately accepts only the existing, auditable form of the upstream guard.
// A substring check would incorrectly accept `upstream || true` or its negation.
function isUpstreamGuard(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const condition = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim()
    return /^github\.repository\s*==\s*'tiann\/hapi'(?:\s*&&\s*[\s\S]+)?$/.test(condition)
        && !condition.includes('||')
}

export function checkWorkflowPolicy(name: string, source: string): string[] {
    const errors: string[] = []
    const fail = (message: string) => errors.push(`${name}: ${message}`)
    let workflow: Mapping
    try {
        workflow = Bun.YAML.parse(source) as Mapping
    } catch {
        return [`${name}: invalid YAML`]
    }
    if (!workflow || typeof workflow !== 'object' || !workflow.jobs) return [`${name}: missing jobs`]
    if (workflow.permissions?.contents !== 'read'
        || Object.values(workflow.permissions).some(value => value === 'write')) {
        fail('workflow defaults must explicitly grant contents: read and no write permissions')
    }
    const events = typeof workflow.on === 'string' ? [workflow.on]
        : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {})
    const privileged = events.some((event: string) => privilegedEvents.has(event))
    if (name === 'evolved-preview.yml' && (events.length !== 1 || events[0] !== 'workflow_dispatch')) {
        fail('preview packaging must remain manual-only')
    }
    for (const [id, value] of Object.entries(workflow.jobs)) {
        const job = value as Mapping
        const gated = isUpstreamGuard(job.if)
        if ((upstreamOnly.has(name) || privileged) && !gated) fail(`${id} requires the exact upstream repository guard`)
        const permissions = job.permissions ?? workflow.permissions
        if (!gated && (typeof permissions === 'string' || Object.values(permissions ?? {}).includes('write'))) {
            fail(`${id} grants write permissions outside an upstream-only job`)
        }
        if (!gated && (job.secrets || /\$\{\{\s*secrets[.[]/.test(JSON.stringify([workflow.env, job.env])))) {
            fail(`${id} exposes credentials outside an upstream-only job`)
        }
        for (const step of job.steps ?? []) {
            const uses: string = step.uses ?? ''
            if (uses.startsWith('oven-sh/setup-bun@') && step.with?.['bun-version'] !== '1.3.14') {
                fail(`${id} must pin Bun to 1.3.14`)
            }
            if (!gated && uses.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
                fail(`${id} must not persist checkout credentials`)
            }
            if (!gated && (
                /^(openai\/codex-action|actions\/deploy-pages|docker\/login-action)@/.test(uses)
                || /\$\{\{\s*secrets[.[]/.test(JSON.stringify(step))
                || /\b(?:npm|bun)\s+publish\b|\bgh\s+release\s+create\b|\bgit\s+push\b/.test(step.run ?? '')
            )) fail(`${id} contains publishing, credentials or automated AI outside an upstream-only job`)
            if (!gated && uses.startsWith('docker/build-push-action@') && ![undefined, false, 'false'].includes(step.with?.push)) {
                fail(`${id} must not push container images`)
            }
        }
    }
    return errors
}

export function checkRepository(root: string): string[] {
    const folder = resolve(root, '.github/workflows')
    const errors = readdirSync(folder).filter(name => /\.ya?ml$/.test(name))
        .flatMap(name => checkWorkflowPolicy(name, readFileSync(resolve(folder, name), 'utf8')))
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    if (pkg.packageManager !== 'bun@1.3.14') errors.push('package.json: update the Bun policy together with the supported toolchain')
    return errors
}

if (import.meta.main) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const errors = checkRepository(root)
    if (errors.length) {
        console.error(errors.join('\n'))
        process.exitCode = 1
    } else {
        console.log('Publication workflow policy passed: upstream guards, read-only defaults, Bun 1.3.14.')
    }
}
