import type { CommandDefinition } from './types'
import { evolvedClientFromEnvironment } from '@/evolved/client'
import { EVOLVED_CAPABILITY_TOPICS, getEvolvedCapability } from '@/evolved/capabilities'
import { buildEvolvedOperatingContext, EVOLVED_OPERATING_CONTEXT_VERSION } from '@/evolved/operatingContext'
import { DEVELOPMENT_USAGE, runDevelopmentCommand } from '@/evolved/development/command'
import { runEvolvedPluginCommand } from './evolvedPlugin'
import { runEvolvedAdsCommand } from './evolvedAds'

export const evolvedCommand: CommandDefinition = {
    name: 'evolved', requiresRuntimeAssets: false,
    run: async ({ commandArgs: args }) => {
        if (!args.length || args.includes('--help') && args[0] !== 'development' && args[0] !== 'plugin' && args[0] !== 'ads') {
            console.log(`hapi evolved context [topic]\nhapi evolved access\nhapi evolved mcp\nhapi evolved codegraph <status|search|graph|node|impact|affected> [query-or-id]\nhapi evolved memory search <query>\nhapi evolved memory propose <title> <body>\nhapi evolved resources\nhapi evolved agent-credentials\nhapi evolved repositories [--workspace]\nhapi evolved sync <clone|pull> <repository-id> [--request-id <UUID>]\nhapi evolved sync status <job-id>\nhapi evolved development <context|knowledge|build-status|doctor|inspect> (see hapi evolved development --help)\nhapi evolved ads <doctor|capabilities|install-skills|ingest|validate|prepare|report|status|run> (bundled Claude Ads, offline; see hapi evolved ads --help)\nhapi evolved plugin validate [<plugin-directory-or-manifest>] (offline author check of hapi-evolved.plugin.json)\n\nContext prints local operating instructions without credentials or a Hub connection; it does not check live availability or grant permissions. Access reads this project's current profile and runner scopes, without granting rights. Topics: ${EVOLVED_CAPABILITY_TOPICS.join(', ')}.\n\nRepositories lists exact granted owner/name and paths; --workspace also inspects local state. Clone/pull return a job immediately; poll with sync status. A request UUID is generated and returned automatically; reuse it with --request-id after an uncertain response. git:read permits discovery and clone/pull in writable projects; git:write is for push. Managed runners configure their isolated Git broker automatically: use native HTTPS Git, no gh or raw token. Other installations require HAPI_EVOLVED_URL, EVOLVED_PROJECT_ID and a private HAPI_EVOLVED_CAPABILITY_FILE (0600). No global token fallback.`)            return
        }
        if (args[0] === 'context') {
            const topic = args[1]
            const capability = topic === undefined ? undefined : getEvolvedCapability(topic)
            if (args.length > 2 || (topic !== undefined && !capability)) {
                console.error(`Usage: hapi evolved context [topic]. Valid topics: ${EVOLVED_CAPABILITY_TOPICS.join(', ')}`)
                process.exitCode = 1
                return
            }
            console.log(JSON.stringify({ version: EVOLVED_OPERATING_CONTEXT_VERSION,
                ...(capability ? { topic: capability.id, instructions: capability.details } : { instructions: buildEvolvedOperatingContext() })
            }, null, 2))
            return
        }
        if (args[0] === 'mcp') { const { startEvolvedMcp } = await import('@/evolved/mcp'); return startEvolvedMcp() }
        if (args[0] === 'development') {
            if (args.length === 1 || args[1] === '--help') { console.log(DEVELOPMENT_USAGE); return }
            console.log(JSON.stringify(await runDevelopmentCommand(args.slice(1), evolvedClientFromEnvironment), null, 2))
            return
        }
        if (args[0] === 'plugin') return runEvolvedPluginCommand(args)
        if (args[0] === 'ads') return runEvolvedAdsCommand(args)
        const client = evolvedClientFromEnvironment()
        let result: unknown
        if (args[0] === 'access' && args.length === 1) result = await client.request(client.projectPath('/agent-access'))
        else if (args[0] === 'codegraph' && ['status', 'search', 'graph', 'node', 'impact', 'affected'].includes(args[1] ?? '')) {
            const operation = args[1], key = ['node', 'impact'].includes(operation) ? 'nodeId' : operation === 'affected' ? 'files' : 'q'
            result = await client.request(client.projectPath(`/codegraph/${operation}?${new URLSearchParams({ [key]: args.slice(2).join(' ') })}`))
        } else if (args[0] === 'memory' && args[1] === 'search') {
            result = await client.request(`/memory/search?${new URLSearchParams({ q: args.slice(2).join(' '), projectId: client.projectId })}`)
        } else if (args[0] === 'memory' && args[1] === 'propose' && args[2] && args[3]) {
            result = await client.request(client.projectPath('/memory'), 'POST', { title: args[2], body: args.slice(3).join(' ') })
        } else if (args[0] === 'agent-credentials') result = await client.request(client.projectPath('/agent-credentials'))
        else if (args[0] === 'resources') result = await client.request(client.projectPath('/resources'))
        else if (args[0] === 'repositories' && (args.length === 1 || args.length === 2 && args[1] === '--workspace')) result = await client.repositories(args[1] === '--workspace')
        else if (args[0] === 'sync' && args[1] === 'status' && args.length === 3) result = await client.repositoryJob(args[2])
        else if (args[0] === 'sync' && (args[1] === 'clone' || args[1] === 'pull') && (args.length === 3 || args.length === 5 && args[3] === '--request-id')) result = await client.syncRepository(args[2], args[1], args[4])
        else throw new Error('Unknown command. Run hapi evolved --help')
        console.log(JSON.stringify(result, null, 2))
    }
}
