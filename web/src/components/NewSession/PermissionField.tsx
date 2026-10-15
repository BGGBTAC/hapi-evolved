import {
    getAgentConfigDescriptor,
    getPermissionModeLabel,
    getLaunchPermissionModesForFlavor,
    resolveHapiYoloPermissionMode,
    type PermissionMode
} from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { usesNativePermissionSelect } from '@/lib/codexFamilyPermissionAgents'
import type { AgentType } from './types'
import { AgentConfigFieldControl } from '@/components/AgentConfigFieldControl'
import type { AgentConfigDescriptor } from '@hapi/protocol'
import { YoloToggle } from './YoloToggle'

export type PermissionFieldProps = {
    descriptor?: AgentConfigDescriptor
    agent: AgentType
    /** Native permission mode for flavors rendered as a native-mode select. */
    nativeValue: PermissionMode
    yoloMode: boolean
    isDisabled: boolean
    autoPermissionModeSupported?: boolean | null
    onNativeChange: (value: PermissionMode) => void
    onYoloToggle: (value: boolean) => void
}

/**
 * Renders the Permission section of the create-session form from the agent's
 * configuration descriptor (see shared/src/agentConfig.ts).
 *
 * - `status` fields (Pi) surface a managed note instead of a control so the
 *   HAPI YOLO policy is never silently ignored for agents that cannot apply it.
 * - `select` fields render the agent's native permission modes. Claude and
 *   grok get this native select at create time even though neither shares
 *   the codex-family mode set (see usesNativePermissionSelect).
 * - Remaining flavors whose create surface still carries the persistent HAPI
 *   YOLO preference render the YOLO toggle with the native mode it maps to.
 */
export function PermissionField(props: PermissionFieldProps) {
    const { t } = useTranslation()
    const descriptor = props.descriptor ?? getAgentConfigDescriptor(props.agent)
    const field = descriptor.fields.find((candidate) => candidate.id === 'permission')
    if (!field) {
        return null
    }

    if (field.kind === 'status') {
        return (
            <div className="flex flex-col gap-1.5 px-3 py-3" data-testid="permission-managed">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('misc.permissionMode')}
                </label>
                <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-[var(--app-fg)]">
                        {t('newSession.permission.managedTitle')}
                    </span>
                    <span className="text-xs text-[var(--app-hint)]">
                        {t('newSession.permission.managedDesc')}
                    </span>
                </div>
            </div>
        )
    }

    if (field.kind === 'select' && usesNativePermissionSelect(props.agent)) {
        const options = (field.options ?? getLaunchPermissionModesForFlavor(props.agent).map(mode => ({ value: mode, label: getPermissionModeLabel(mode) })))
            .map(option => option.value === 'auto' && props.autoPermissionModeSupported === false ? { ...option, disabled: true, label: `${option.label} (${t('newSession.grokAutoUnavailable')})` } : option)
        return <><AgentConfigFieldControl field={props.autoPermissionModeSupported === false ? { ...field, unavailableReason: undefined } : field} label={t('misc.permissionMode')} value={props.nativeValue}
            options={options} disabled={props.isDisabled} onChange={value => props.onNativeChange(value as PermissionMode)} />
            {props.autoPermissionModeSupported === false ? <span className="px-3 text-xs text-[var(--app-hint)]">{t('newSession.grokAutoUnavailableDesc')}</span> : null}</>
    }

    // Remaining flavors still carry the persistent HAPI YOLO preference at
    // create time. The descriptor advertises the native modes their session
    // surface supports; surface the mapping so the preference is explicit.
    const nativeHint = resolveHapiYoloPermissionMode(props.agent)
    return (
        <YoloToggle
            yoloMode={props.yoloMode}
            isDisabled={props.isDisabled}
            onToggle={props.onYoloToggle}
            nativeHint={nativeHint ? getPermissionModeLabel(nativeHint) : undefined}
        />
    )
}
