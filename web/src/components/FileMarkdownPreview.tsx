import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import { MarkdownRenderer } from './MarkdownRenderer'
import { defaultComponents } from './assistant-ui/markdown-text'
import { resolveMarkdownAssetPath } from '@/lib/markdownAssetPath'
import { encodeBase64 } from '@/lib/utils'

const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' }
function LocalImage({ api, sessionId, path, alt }: { api: ApiClient; sessionId: string; path: string; alt?: string }) {
    const [url, setUrl] = useState<string | null>(null), [error, setError] = useState('')
    useEffect(() => {
        let disposed = false, objectUrl: string | null = null
        setUrl(null); setError('')
        void api.readSessionFile(sessionId, path).then(result => {
            if (disposed) return
            if (!result.success || !result.content) throw new Error(result.error || 'Bild nicht verfügbar')
            if ((result.size ?? 0) > 5 * 1024 * 1024 || result.content.length > 7 * 1024 * 1024) throw new Error('Bild zu groß für die Vorschau (maximal 5 MiB)')
            const mime = imageTypes[path.split('.').pop()?.toLowerCase() ?? '']
            if (!mime) throw new Error('Bildformat nicht unterstützt')
            const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0))
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime })); setUrl(objectUrl)
        }).catch(failure => { if (!disposed) setError(failure instanceof Error ? failure.message : 'Bild nicht verfügbar') })
        return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
    }, [api, sessionId, path])
    return url ? <img src={url} alt={alt ?? ''} className="max-w-full" /> : <span className="text-sm text-[var(--app-hint)]">{error || `Bild lädt: ${alt || path}`}</span>
}
export function FileMarkdownPreview({ content, api, sessionId, filePath, rootPath }: { content: string; api: ApiClient; sessionId: string; filePath: string; rootPath: string }) {
    const navigate = useNavigate()
    const documentKey = `${sessionId}:${filePath}`
    const [externalChoice, setExternalChoice] = useState<string | null>(null)
    const externalImagesEnabled = externalChoice === documentKey
    const components = useMemo(() => ({
        img: ({ src, alt }: ComponentPropsWithoutRef<'img'>) => {
            const path = typeof src === 'string' ? resolveMarkdownAssetPath(filePath, src, rootPath) : null
            if (typeof src === 'string' && /^https:\/\//i.test(src)) return externalImagesEnabled ? <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" className="max-w-full" onError={event => { event.currentTarget.alt = `Bild nicht verfügbar: ${alt || src}` }} /> : <span className="text-sm text-[var(--app-hint)]">Externes Bild: {alt || src}</span>
            return path ? <LocalImage api={api} sessionId={sessionId} path={path} alt={alt} /> : <span className="text-sm text-[var(--app-hint)]">{alt || 'Externes oder unzulässiges Bild'}</span>
        },
        a: ({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) => {
            const path = href ? resolveMarkdownAssetPath(filePath, href, rootPath) : null
            if (!path) {
                if (href && (/^https:\/\//i.test(href) || href.startsWith('#'))) { const Anchor = defaultComponents.a!; return <Anchor href={href} {...props}>{children}</Anchor> }
                return <span title="Unzulässiger oder nicht auflösbarer Dateipfad">{children}</span>
            }
            return <a href={href} {...props} onClick={event => { event.preventDefault(); void navigate({ to: '/sessions/$sessionId/file', params: { sessionId }, search: { path: encodeBase64(path) } }) }}>{children}</a>
        }
    }), [api, sessionId, filePath, rootPath, navigate, externalImagesEnabled])
    return <><p className="mb-2 text-xs text-[var(--app-hint)]">HTTPS-Bilder werden direkt vom Browser geladen; externe Anbieter sehen dabei deine IP-Adresse. {!externalImagesEnabled && <button type="button" className="underline" onClick={() => setExternalChoice(documentKey)}>Externe HTTPS-Bilder laden</button>}</p><MarkdownRenderer key={`${documentKey}:${externalImagesEnabled}`} content={content} components={components} standalone /></>
}
