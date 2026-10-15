import { useId, type RefObject } from 'react'
import type { SessionType } from './types'
import { useTranslation } from '@/lib/use-translation'

export function SessionTypeSelector(props: {
    sessionType: SessionType
    worktreeName: string
    worktreeInputRef: RefObject<HTMLInputElement | null>
    isDisabled: boolean
    onSessionTypeChange: (value: SessionType) => void
    onWorktreeNameChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const groupId = useId()
    return (
        <fieldset className="flex flex-col gap-1.5 px-3 py-3">
            <legend className="text-xs font-medium text-[var(--app-hint)]">{t('newSession.type')}</legend>
            <div className="flex flex-col gap-1.5">
                {(['simple', 'worktree'] as const).map(type => <div key={type} className="flex flex-col gap-2">
                    <label htmlFor={`${groupId}-${type}`} className="flex min-h-[44px] items-center gap-2 cursor-pointer">
                        <input id={`${groupId}-${type}`} type="radio" name={`${groupId}-sessionType`} value={type}
                            checked={props.sessionType === type} onChange={() => props.onSessionTypeChange(type)}
                            disabled={props.isDisabled} className="accent-[var(--app-link)]" />
                        <span className="text-sm capitalize">{t(type === 'simple' ? 'newSession.type.simple' : 'newSession.type.worktree')}</span>
                        <span className="text-xs text-[var(--app-hint)]">{t(type === 'simple' ? 'newSession.type.simple.desc' : 'newSession.type.worktree.desc')}</span>
                    </label>
                    {type === 'worktree' && props.sessionType === 'worktree' && <input
                        ref={props.worktreeInputRef} type="text" aria-label={t('newSession.type.worktree.placeholder')}
                        placeholder={t('newSession.type.worktree.placeholder')} value={props.worktreeName}
                        onChange={event => props.onWorktreeNameChange(event.target.value)} disabled={props.isDisabled}
                        className="min-h-[44px] w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-60" />}
                </div>)}
            </div>
        </fieldset>
    )
}
