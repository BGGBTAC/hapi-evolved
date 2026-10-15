import { useSyncExternalStore } from 'react'
import { readImageDimensions } from './imageDimensions'
export const IMAGE_UPLOAD_PREFERENCE = 'hapi:image-uploads'
export type ImageUploadPreference = 'auto' | 'original'
export type ImagePreparation = { original: File; file: File; width?: number; height?: number; compressed: boolean; originalSelected: boolean }
const overrides = new WeakMap<File, { original: File; originalSelected: boolean; id: string }>()
const switching = new Set<string>(), listeners = new Set<() => void>()
const inconsistentVersions = new Map<string, readonly [string, string]>()
export function imageUploadPreference(): ImageUploadPreference { try { return localStorage.getItem(IMAGE_UPLOAD_PREFERENCE) === 'original' ? 'original' : 'auto' } catch { return 'auto' } }
export function setImageUploadPreference(value: ImageUploadPreference) { try { localStorage.setItem(IMAGE_UPLOAD_PREFERENCE, value) } catch { /* optional preference */ } }
export function setImageVersionSwitching(sessionId: string, value: boolean) { if (value) switching.add(sessionId); else switching.delete(sessionId); for (const callback of listeners) callback() }
export function isImageVersionSwitching(sessionId?: string) { return sessionId === undefined ? switching.size > 0 : switching.has(sessionId) || inconsistentVersions.has(sessionId) }
export function markImageVersionsInconsistent(sessionId: string, ids: readonly [string, string]) { inconsistentVersions.set(sessionId, ids); for (const callback of listeners) callback() }
export function reconcileImageVersions(sessionId: string, attachments: readonly { id: string }[]) {
    const pair = inconsistentVersions.get(sessionId)
    if (pair && !pair.every(id => attachments.some(item => item.id === id))) { inconsistentVersions.delete(sessionId); for (const callback of listeners) callback() }
}
export function useImageVersionSwitching(sessionId?: string) { return useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback) }, () => isImageVersionSwitching(sessionId), () => false) }
export function imageVersionFile(preparation: ImagePreparation, originalSelected: boolean): File {
    const original = preparation.original
    const file = new File([original], original.name, { type: original.type, lastModified: original.lastModified })
    overrides.set(file, { original, originalSelected, id: crypto.randomUUID() }); return file
}
export function imageVersionId(file: File): string | undefined { return overrides.get(file)?.id }
export function scaledImageDimensions(width: number, height: number) {
    const ratio = Math.min(1, 2048 / Math.max(width, height))
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}
let preparationTail: Promise<void> = Promise.resolve()
let decoderUnavailable = false
/** Decode at most one large image at a time to bound mobile peak memory. */
export async function prepareImageUpload(input: File, cancelled: () => boolean = () => false): Promise<ImagePreparation> {
    const override = overrides.get(input), original = override?.original ?? input
    const originalSelected = override?.originalSelected ?? imageUploadPreference() === 'original'
    if (cancelled() || decoderUnavailable || originalSelected || original.size <= 4 * 1024 * 1024 || original.size > 50 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/i.test(original.type) || typeof createImageBitmap !== 'function') return { original, file: original, compressed: false, originalSelected }
    const previous = preparationTail
    let release!: () => void
    preparationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await prepareImageUploadSerial(input, cancelled) } finally { release() }
}
async function prepareImageUploadSerial(input: File, cancelled: () => boolean): Promise<ImagePreparation> {
    const override = overrides.get(input), original = override?.original ?? input
    const originalSelected = override?.originalSelected ?? imageUploadPreference() === 'original'
    const unchanged: ImagePreparation = { original, file: original, compressed: false, originalSelected }
    if (cancelled()) return unchanged
    if (originalSelected || original.size <= 4 * 1024 * 1024 || !/^image\/(jpeg|png|webp|avif|heic|heif)$/i.test(original.type) || typeof createImageBitmap !== 'function' || original.size > 50 * 1024 * 1024) return unchanged
    let bitmap: ImageBitmap | undefined
    try {
        const header = await readImageDimensions(original)
        if (!header || !header.width || !header.height || header.width * header.height > 40_000_000 || cancelled() || decoderUnavailable) return unchanged
        let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
        const decoding = createImageBitmap(original, { imageOrientation: 'from-image' }).then(result => { if (timedOut) result.close(); return result })
        try { bitmap = await Promise.race([decoding, new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; decoderUnavailable = true; reject(new Error('Image decode timed out')) }, 5000) })]) } finally { clearTimeout(timer) }
        if (cancelled()) return unchanged
        // Bounded canvas and alpha scanning. Reject exceptionally large decoded rasters.
        if (bitmap.width * bitmap.height > 40_000_000 || !bitmap.width || !bitmap.height) return unchanged
        // Check original pixels in small tiles, so a transparent pixel cannot disappear during downscaling.
        const alphaCanvas = document.createElement('canvas'); alphaCanvas.width = 512; alphaCanvas.height = 512
        const alphaContext = alphaCanvas.getContext('2d', { willReadFrequently: true })
        if (!alphaContext) return unchanged
        let tile = 0
        for (let y = 0; y < bitmap.height; y += 512) for (let x = 0; x < bitmap.width; x += 512) {
            if (cancelled()) return unchanged
            const width = Math.min(512, bitmap.width - x), height = Math.min(512, bitmap.height - y)
            alphaContext.clearRect(0, 0, 512, 512)
            alphaContext.drawImage(bitmap, x, y, width, height, 0, 0, width, height)
            const pixels = alphaContext.getImageData(0, 0, width, height).data
            for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! < 255) return { ...unchanged, width: bitmap.width, height: bitmap.height }
            if (++tile % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0))
        }
        const dimensions = scaledImageDimensions(bitmap.width, bitmap.height)
        const canvas = document.createElement('canvas'); canvas.width = dimensions.width; canvas.height = dimensions.height
        const context = canvas.getContext('2d')
        if (!context) return unchanged
        context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height)
        if (cancelled()) return unchanged
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
        if (!blob || blob.type !== 'image/jpeg' || blob.size >= original.size || cancelled()) return { ...unchanged, width: bitmap.width, height: bitmap.height }
        const file = new File([blob], original.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: original.lastModified })
        return { original, file, ...dimensions, compressed: true, originalSelected: false }
    } catch { return unchanged } finally { bitmap?.close() }
}
