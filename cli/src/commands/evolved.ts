import type { CommandDefinition } from './types'
import { evolvedClientFromEnvironment } from '@/evolved/client'
import { EVOLVED_CAPABILITY_TOPICS, getEvolvedCapability } from '@/evolved/capabilities'
import { buildEvolvedOperatingContext, EVOLVED_OPERATING_CONTEXT_VERSION } from '@/evolved/operatingContext'

export const evolvedCommand: CommandDefinition = {
    name: 'evolved', requiresRuntimeAssets: false,
    run: async ({ commandArgs: args }) => {
        if (!args.length || args.includes('--help')) {
            console.log(`hapi evolved context [topic]\nhapi evolved mcp\nhapi evolved codegraph <status|search|graph|node|impact|affected> [query-or-id]\nhapi evolved memory search <query>\nhapi evolved memory propose <title> <body>\nhapi evolved resources\nhapi evolved repositories [--workspace]\nhapi evolved sync <clone|pull> <repository-id> [--request-id <UUID>]\nhapi evolved sync status <job-id>\n\nContext prints local operating instructions without credentials or a Hub connection; it does not check live availability or grant permissions. Topics: ${EVOLVED_CAPABILITY_TOPICS.join(', ')}.\n\nRepositories lists exact granted owner/name and paths; --workspace also inspects local state. Clone/pull return a job immediately; poll with sync status. A request UUID is generated and returned automatically; reuse it with --request-id after an uncertain response. git:read permits discovery and clone/pull in writable projects; git:write is for push. Managed runners configure their isolated Git broker automatically: use native HTTPS Git, no gh or raw token. Other installations require HAPI_EVOLVED_URL, EVOLVED_PROJECT_ID and a private HAPI_EVOLVED_CAPABILITY_FILE (0600). No global token fallback.`)
            return
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
        const client = evolvedClientFromEnvironment()
        let result: unknown
        if (args[0] === 'codegraph' && ['status', 'search', 'graph', 'node', 'impact', 'affected'].includes(args[1] ?? '')) {
            const operation = args[1], key = ['node', 'impact'].includes(operation) ? 'nodeId' : operation === 'affected' ? 'files' : 'q'
            result = await client.request(client.projectPath(`/codegraph/${operation}?${new URLSearchParams({ [key]: args.slice(2).join(' ') })}`))
        } else if (args[0] === 'memory' && args[1] === 'search') {
            result = await client.request(`/memory/search?${new URLSearchParams({ q: args.slice(2).join(' '), projectId: client.projectId })}`)
        } else if (args[0] === 'memory' && args[1] === 'propose' && args[2] && args[3]) {
            result = await client.request(client.projectPath('/memory'), 'POST', { title: args[2], body: args.slice(3).join(' ') })
        } else if (args[0] === 'resources') result = await client.request(client.projectPath('/resources'))
        else if (args[0] === 'repositories' && (args.length === 1 || args.length === 2 && args[1] === '--workspace')) result = await client.repositories(args[1] === '--workspace')
        else if (args[0] === 'sync' && args[1] === 'status' && args.length === 3) result = await client.repositoryJob(args[2])
        else if (args[0] === 'sync' && (args[1] === 'clone' || args[1] === 'pull') && (args.length === 3 || args.length === 5 && args[3] === '--request-id')) result = await client.syncRepository(args[2], args[1], args[4])
        else throw new Error('Unknown command. Run hapi evolved --help')
        console.log(JSON.stringify(result, null, 2))
    }
}
