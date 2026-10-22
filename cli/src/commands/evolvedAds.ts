import { ADS_USAGE, runAdsCommand } from '@/evolved/ads/command'

/**
 * `hapi evolved ads …` (offline Claude Ads helper). Like `hapi evolved plugin`, runCli dispatches here before loading
 * the command registry, so read-only commands create no HAPI_HOME, logs or settings. The Hub client module is loaded
 * only for `run --from-settings`. `args` follow `evolved`.
 */
export async function runEvolvedAdsCommand(args: readonly string[]): Promise<void> {
    if (args.length === 1 || args[1] === '--help') { console.log(ADS_USAGE); return }
    try {
        const { evolvedClientFromEnvironment } = args[1] === 'run' ? await import('@/evolved/client') : { evolvedClientFromEnvironment: null }
        const client = () => { if (!evolvedClientFromEnvironment) throw new Error('This command does not use the Hub'); return evolvedClientFromEnvironment() }
        console.log(JSON.stringify(await runAdsCommand(args.slice(1), client), null, 2))
    } catch (error) {
        // Bounded JSON error for agents; usage and boundary errors carry no secrets or stack traces.
        console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message.slice(0, 2000) : 'Claude Ads command failed' }))
        process.exitCode = 2
    }
}
