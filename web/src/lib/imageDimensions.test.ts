import { describe, expect, it } from 'vitest'
import { imageHeaderDimensions } from './imageDimensions'
describe('bounded raster dimensions', () => {
    it('reads PNG dimensions without decoding pixel bytes', () => {
        const bytes = new Uint8Array(24), view = new DataView(bytes.buffer)
        view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(12, 0x49484452); view.setUint32(16, 30000); view.setUint32(20, 40000)
        expect(imageHeaderDimensions(bytes)).toEqual({ width: 30000, height: 40000 })
    })
    it('walks JPEG metadata to a SOF marker and rejects a truncated segment', () => {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0, 0xff, 0xc2, 0, 7, 8, 0x07, 0xd0, 0x0b, 0xb8])
        expect(imageHeaderDimensions(bytes)).toEqual({ width: 3000, height: 2000 })
        expect(imageHeaderDimensions(bytes.subarray(0, 15))).toBeNull()
    })
    it('reads extended WebP dimensions and refuses unknown containers', () => {
        const bytes = new Uint8Array(30)
        bytes.set(new TextEncoder().encode('RIFF'), 0); bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
        bytes.set([0xff, 0x07, 0, 0xff, 0x03, 0], 24)
        expect(imageHeaderDimensions(bytes)).toEqual({ width: 2048, height: 1024 })
        expect(imageHeaderDimensions(new Uint8Array(30))).toBeNull()
    })
})
