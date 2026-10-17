import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it.each([
        ['claude-opus-5-5', 'claude'], ['opus[1m]', 'claude'], ['claude-fable-5', 'claude'],
        ['gpt-6-astra', 'codex'], ['gpt-5.4', 'codex'], ['custom', 'pi'], [null, 'claude'],
    ])('does not invent a session limit from model %s', (model, flavor) => {
        expect(getContextBudgetTokens(model, flavor)).toBeNull()
    })
    it('keeps an explicitly encoded Cursor window exact without subtracting hidden headroom', () => {
        expect(getContextBudgetTokens('composer-2.5-fast[context=300k]', 'cursor')).toBe(300_000)
    })
    it('returns null for unknown providers', () => {
        expect(getContextBudgetTokens('gemini-3-pro', 'gemini')).toBeNull()
    })
})
