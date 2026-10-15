export function DiffDisplay(props: { diffContent: string }) {
    const lines = props.diffContent.split('\n')

    return (
        <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
            {lines.map((line, index) => {
                const isAdd = line.startsWith('+') && !line.startsWith('+++')
                const isRemove = line.startsWith('-') && !line.startsWith('---')
                const isHunk = line.startsWith('@@')
                const isHeader = line.startsWith('+++') || line.startsWith('---')

                const className = [
                    'whitespace-pre-wrap px-3 py-0.5 text-xs font-mono',
                    isAdd ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]' : '',
                    isRemove ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]' : '',
                    isHunk ? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold' : '',
                    isHeader ? 'text-[var(--app-hint)] font-semibold' : ''
                ].filter(Boolean).join(' ')

                const style = isAdd
                    ? { borderLeft: '2px solid var(--app-git-staged-color)' }
                    : isRemove
                        ? { borderLeft: '2px solid var(--app-git-deleted-color)' }
                        : undefined

                return (
                    <div key={`${index}-${line}`} className={className} style={style}>
                        {line || ' '}
                    </div>
                )
            })}
        </div>
    )
}
