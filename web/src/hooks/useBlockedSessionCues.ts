import { useEffect, useState, type RefObject } from 'react'
import type { SessionSummary } from '@/types/api'
import { isSessionBlocked } from '@/lib/sessionActivity'
export function useBlockedSessionCues(ref: RefObject<HTMLElement | null>, sessions: readonly SessionSummary[]) {
    const [cues, setCues] = useState<{ above: string[]; below: string[] }>({ above: [], below: [] })
    useEffect(() => {
        const container = ref.current
        if (!container) return
        let frame: number | null = null
        const measure = () => {
            frame = null
            const viewport = container.getBoundingClientRect(), above: string[] = [], below: string[] = []
            const rows = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'), row => [row.dataset.sessionId!, row]))
            for (const session of sessions) {
                if (!isSessionBlocked(session)) continue
                const row = rows.get(session.id), bounds = row?.getBoundingClientRect()
                if (!row || row.closest('.collapsible-panel:not([data-open])') || !bounds || bounds.height === 0 || bounds.top >= viewport.bottom) below.push(session.id)
                else if (bounds.bottom <= viewport.top) above.push(session.id)
            }
            setCues(previous => previous.above.join() === above.join() && previous.below.join() === below.join() ? previous : { above, below })
        }
        const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure) }
        container.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
        observer?.observe(container); if (container.firstElementChild) observer?.observe(container.firstElementChild)
        schedule()
        return () => { if (frame !== null) cancelAnimationFrame(frame); container.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); observer?.disconnect() }
    }, [ref, sessions])
    return cues
}
