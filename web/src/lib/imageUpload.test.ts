import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imageVersionFile, prepareImageUpload, scaledImageDimensions, setImageUploadPreference } from './imageUpload'
let alpha = 255
beforeEach(() => { localStorage.clear(); alpha = 255 })
afterEach(() => vi.restoreAllMocks())
function raster(type = 'image/png', size = 4 * 1024 * 1024 + 1, width = 3000, height = 2000) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer)
    view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(12, 0x49484452); view.setUint32(16, width); view.setUint32(20, height)
    return new File([bytes], 'photo.png', { type })
}
function decoder(width = 3000, height = 2000, outputSize = 1024) {
    const close = vi.fn(), decode = vi.fn().mockResolvedValue({ width, height, close })
    vi.stubGlobal('createImageBitmap', decode)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) }) } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) { callback(new Blob([new Uint8Array(outputSize)], { type })) })
    return { decode, close }
}
describe('image upload selection', () => {
    it('rejects huge image dimensions before allocating a decoded raster', async () => {
        const { decode } = decoder(), original = raster('image/png', 5 * 1024 * 1024, 30000, 30000)
        expect((await prepareImageUpload(original)).file).toBe(original); expect(decode).not.toHaveBeenCalled()
    })
    it('preserves aspect ratio and never upscales', () => { expect(scaledImageDimensions(4000, 2000)).toEqual({ width: 2048, height: 1024 }); expect(scaledImageDimensions(20, 10)).toEqual({ width: 20, height: 10 }) })
    it('compresses opaque images, preserving oriented dimensions and matching filename/MIME', async () => {
        const { decode, close } = decoder(), original = raster(), result = await prepareImageUpload(original)
        expect(decode).toHaveBeenCalledWith(original, { imageOrientation: 'from-image' })
        expect(result).toMatchObject({ compressed: true, width: 2048, height: 1365, original })
        expect(result.file.name).toBe('photo.jpg'); expect(result.file.type).toBe('image/jpeg'); expect(result.file.size).toBe(1024); expect(close).toHaveBeenCalledOnce()
        expect(await prepareImageUpload(imageVersionFile(result, true))).toMatchObject({ file: original, compressed: false, originalSelected: true })
    })
    it.each(['image/gif', 'image/svg+xml', 'text/plain'])('preserves %s byte for byte', async type => { const { decode } = decoder(), original = raster(type); expect((await prepareImageUpload(original)).file).toBe(original); expect(decode).not.toHaveBeenCalled() })
    it('preserves threshold images and original preference without decoding', async () => {
        const { decode } = decoder(), small = raster('image/png', 4 * 1024 * 1024)
        expect((await prepareImageUpload(small)).file).toBe(small)
        setImageUploadPreference('original'); const large = raster(); expect((await prepareImageUpload(large)).file).toBe(large); expect(decode).not.toHaveBeenCalled()
    })
    it('preserves transparency, failed decodes, larger outputs, and cancellation', async () => {
        const original = raster(); decoder(); alpha = 0; expect((await prepareImageUpload(original)).file).toBe(original)
        alpha = 255; decoder(30, 20, original.size + 1); expect((await prepareImageUpload(original)).file).toBe(original)
        const { decode } = decoder(); expect((await prepareImageUpload(original, () => true)).file).toBe(original); expect(decode).not.toHaveBeenCalled()
        vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported HEIC'))); expect((await prepareImageUpload(original)).file).toBe(original)
    })
})
