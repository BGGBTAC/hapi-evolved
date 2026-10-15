import { afterEach, expect, it, vi } from 'vitest'
import { withRepositoryInstruction } from './repositoryPrompt'
import { getSystemPrompt } from '@/claude/utils/systemPrompt'
import { getCodexSystemPrompt } from '@/codex/utils/systemPrompt'

afterEach(() => vi.unstubAllEnvs())
it('does not advertise unavailable repository tools in a legacy session', () => {
    expect(withRepositoryInstruction('existing instructions', {})).toBe('existing instructions')
    expect(getCodexSystemPrompt({})).not.toContain('evolved_repositories')
})
it.each([{ HAPI_EVOLVED_PROXY: '1' }, { HAPI_EVOLVED_CAPABILITY_FILE: '/private/capability' }])('shows project discovery for scoped Evolved sessions: %j', env => {
    const prompt = withRepositoryInstruction('existing instructions', env)
    expect(prompt).toContain('evolved_repositories')
    expect(prompt).toContain('never guess an owner')
    expect(prompt).toContain('same requestId')
    expect(prompt).toContain('git:write')
    expect(prompt).not.toContain('/private/capability')
    expect(getCodexSystemPrompt(env)).toContain('evolved_repository_sync')
})
it('resolves Claude repository discovery at bootstrap instead of freezing the environment on import', () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '')
    vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '')
    expect(getSystemPrompt()).not.toContain('evolved_repositories')
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    expect(getSystemPrompt()).toContain('evolved_repositories')
    vi.stubEnv('HAPI_EVOLVED_PROXY', '')
    expect(getSystemPrompt()).not.toContain('evolved_repositories')
})
