import type { CommandDefinition } from './types'
import { linkGithubPr } from '@/modules/githubPr'
export const linkPrCommand: CommandDefinition = {
    name: 'link-pr', requiresRuntimeAssets: false,
    async run({ commandArgs }) {
        if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
            console.log('hapi link-pr <https://github.com/owner/repo/pull/123 | owner/repo#123>\nLinks the current HAPI_SESSION_ID. Requires enabled hub PR awareness.'); return
        }
        if (commandArgs.length !== 1) throw new Error('Usage: hapi link-pr <PR URL or owner/repository#number>')
        console.log(JSON.stringify(await linkGithubPr(commandArgs[0]!)))
    }
}
