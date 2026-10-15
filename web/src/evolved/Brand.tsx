/** Small, code-native optical companion to the original graph-e wordmark. */
export function EvolvedMark({ className = '' }: { className?: string }) {
    return <svg className={`evolved-mark ${className}`} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M33 32a14 14 0 1 1 3-13H11m25 0h6M29 7l5-4" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="42" cy="19" r="4" fill="currentColor" /><circle cx="36" cy="3" r="3" fill="currentColor" />
    </svg>
}

export function EvolvedBrand({ compact = false }: { compact?: boolean }) {
    return <span className={`evolved-brand${compact ? ' evolved-brand-compact' : ''}`}>
        <EvolvedMark /><span className="evolved-wordmark">HAPI<span>-eVolved</span></span>
    </span>
}
