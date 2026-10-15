import { useEffect, useMemo, useState } from 'react'
import { ImagePreview } from '@/components/ImagePreview'
import type { ToolViewComponent } from './_all'

type ToolImage = { mimeType: string; data: string }
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_ENCODED_IMAGE = 4 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024

/** Accept inline MCP and Anthropic raster blocks only; never fetch tool-supplied URLs. */
export function splitToolImages(result: unknown): { images: ToolImage[]; textResult: unknown } {
    const images: ToolImage[] = []; let total = 0, visited = 0
    const walk = (value: unknown, depth: number): unknown => {
        if (++visited > 500 || depth > 5 || value === null || typeof value !== 'object') return value
        if (Array.isArray(value)) return value.map(item => walk(item, depth + 1))
        const object = value as Record<string, unknown>
        if (object.type === 'image') {
            const source = object.source && typeof object.source === 'object' ? object.source as Record<string, unknown> : null
            const data = source?.type === 'base64' ? source.data : object.data
            const mimeType = source?.type === 'base64' ? source.media_type : object.mimeType
            if (typeof data === 'string' && typeof mimeType === 'string' && rasterTypes.has(mimeType)
                && data.length > 0 && data.length <= MAX_ENCODED_IMAGE && data.length % 4 === 0
                && /^[A-Za-z0-9+/]*={0,2}$/.test(data) && total + data.length <= MAX_TOTAL && images.length < 6) {
                total += data.length; images.push({ data, mimeType })
                return { type: 'text', text: `[Image ${images.length} shown below]` }
            }
            return { type: 'text', text: '[Image omitted: unsupported format or size limit]' }
        }
        const copy = { ...object }
        for (const key of ['content', 'result', 'data', 'output']) if (copy[key] && typeof copy[key] === 'object') copy[key] = walk(copy[key], depth + 1)
        return copy
    }
    return { textResult: walk(result, 0), images }
}

function ToolImagePreview({ image, index }: { image: ToolImage; index: number }) {
    const [url, setUrl] = useState('')
    useEffect(() => {
        const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0))
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }))
        setUrl(objectUrl)
        return () => URL.revokeObjectURL(objectUrl)
    }, [image])
    return url ? <ImagePreview src={url} fileName={`tool-image-${index + 1}.${image.mimeType.split('/')[1]}`} label={`Tool result image ${index + 1}`}
        galleryId="tool-result-images" allowOpenInNewTab buttonClassName="max-w-full rounded border overflow-hidden" imageClassName="max-h-64 max-w-full object-contain" /> : null
}

const decorated = new WeakMap<ToolViewComponent, ToolViewComponent>()
export function withToolImages(View: ToolViewComponent): ToolViewComponent {
    const existing = decorated.get(View); if (existing) return existing
    const Result: ToolViewComponent = props => {
        const split = useMemo(() => splitToolImages(props.block.tool.result), [props.block.tool.result])
        return <><View {...props} block={{ ...props.block, tool: { ...props.block.tool, result: split.textResult } }} />
            {split.images.length ? <div className="mt-2 flex flex-wrap gap-2">{split.images.map((image, index) => <ToolImagePreview key={index} image={image} index={index} />)}</div> : null}</>
    }
    decorated.set(View, Result); return Result
}
