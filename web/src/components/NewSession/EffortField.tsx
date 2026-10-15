import { getAgentConfigDescriptor, type PiThinkingLevelMap } from '@hapi/protocol'
import { getPiThinkingLevelOptions } from '@/components/AssistantChat/piThinkingLevelOptions'
import { getCodexComposerReasoningEffortOptions } from '@/components/AssistantChat/codexReasoningEffortOptions'
import { useTranslation } from '@/lib/use-translation'
import { AgentConfigFieldControl } from '@/components/AgentConfigFieldControl'
import type { AgentConfigDescriptor } from '@hapi/protocol'
import type { AgentType, CodexReasoningEffort, LaunchEffort } from './types'
import { CLAUDE_EFFORT_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS, GROK_EFFORT_OPTIONS } from './types'

export type EffortFieldProps = {
    descriptor?: AgentConfigDescriptor
    agent: AgentType
    /** Launch-effort state (Claude / Grok / Pi). */
    effort: LaunchEffort
    onEffortChange: (value: string) => void
    /** Reasoning-effort state (Codex / OpenCode). */
    reasoningEffort: CodexReasoningEffort
    onReasoningEffortChange: (value: string) => void
    isDisabled: boolean
    /** Model-dependent launch-effort options (Grok). */
    grokOptions?: Array<{ value: string; label: string }>
    /** Model-dependent reasoning-effort options (Codex). */
    codexReasoningOptions?: Array<{ value: string; name?: string }>
    /** Model-dependent variant values from the OpenCode catalog (OpenCode). Array = dynamic list, [] = hide field, null/undefined = static fallback. */
    opencodeVariantOptions?: string[] | null
    /** Selected Pi model — hides effort when the model cannot reason and filters levels via thinkingLevelMap. */
    piSelectedModel?: { reasoning?: boolean; thinkingLevelMap?: PiThinkingLevelMap } | null
}

/**
 * Renders the Effort section of the create-session form from the agent's
 * configuration descriptor (see shared/src/agentConfig.ts).
 *
 * One component serves every flavor with an `effort` field:
 * - Claude: static launch-effort levels.
 * - Grok: model-dependent launch-effort levels.
 * - Pi: model-dependent thinking levels (filtered by the selected model's
 *   thinkingLevelMap; hidden when the model cannot reason).
 * - Codex / OpenCode: model-dependent reasoning-effort levels.
 */
export function EffortField(props: EffortFieldProps) {
    const { t } = useTranslation()
    const descriptor = props.descriptor ?? getAgentConfigDescriptor(props.agent)
    const field = descriptor.fields.find((candidate) => candidate.id === 'effort')
    if (!field) {
        return null
    }

    const isReasoningEffort = props.agent === 'codex' || props.agent === 'opencode'

    let options: Array<{ value: string; label: string }>
    if (props.agent === 'grok') {
        options = props.grokOptions ?? GROK_EFFORT_OPTIONS
    } else if (props.agent === 'pi') {
        if (props.piSelectedModel?.reasoning === false) {
            return null
        }
        options = [
            { value: 'auto', label: t('newSession.model.default') },
            ...getPiThinkingLevelOptions(props.effort, props.piSelectedModel?.thinkingLevelMap)
        ]
    } else if (isReasoningEffort) {
        const modelOptions = props.agent === 'codex'
            ? (props.codexReasoningOptions?.length
                ? getCodexComposerReasoningEffortOptions(null, props.agent, props.codexReasoningOptions).map((option) => ({
                    value: option.value ?? 'default',
                    label: option.label
                }))
                : undefined)
            : undefined
        if (props.agent === 'opencode') {
            if (props.opencodeVariantOptions !== undefined && props.opencodeVariantOptions !== null) {
                if (props.opencodeVariantOptions.length === 0) {
                    return null
                }
                options = [
                    { value: 'default', label: t('newSession.model.default') },
                    ...props.opencodeVariantOptions.map((variant) => ({ value: variant, label: variant }))
                ]
            } else {
                options = CODEX_REASONING_EFFORT_OPTIONS.filter((option) => option.value !== 'xhigh')
            }
        } else {
            options = modelOptions ?? CODEX_REASONING_EFFORT_OPTIONS.filter(
                (option) => option.value !== 'max'
            )
        }
    } else {
        options = CLAUDE_EFFORT_OPTIONS
    }

    const value = isReasoningEffort ? props.reasoningEffort : props.effort
    const onChange = isReasoningEffort ? props.onReasoningEffortChange : props.onEffortChange

    return <AgentConfigFieldControl field={field}
        label={isReasoningEffort ? t('newSession.reasoningEffort') : t('newSession.effort')}
        value={value} options={options} disabled={props.isDisabled} onChange={value => onChange(value ?? 'default')} />
}
