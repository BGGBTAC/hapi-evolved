import type { CommandDefinition } from './types'
import { evolvedClientFromEnvironment } from '@/evolved/client'

export const evolvedCommand: CommandDefinition = {
    name: 'evolved', requiresRuntimeAssets: false,
    run: async ({ commandArgs: args }) => {
        if (!args.length || args.includes('--help')) {
            console.log('hapi evolved mcp\nhapi evolved codegraph <status|search|graph|node|impact|affected> [query-or-id]\nhapi evolved memory search <query>\nhapi evolved memory propose <title> <body>\nhapi evolved resources\n\nSet HAPI_EVOLVED_URL, EVOLVED_PROJECT_ID and HAPI_EVOLVED_CAPABILITY_FILE (0600). The capability is scoped and revocable; no global token fallback.')
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
        else throw new Error('Unknown command. Run hapi evolved --help')
        console.log(JSON.stringify(result, null, 2))
    }
}
