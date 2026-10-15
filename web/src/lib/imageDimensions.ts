/** Bounded header parsing before any browser raster decode. Unknown formats keep original bytes. */
export function imageHeaderDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const text = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count))
    if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && text(12, 4) === 'IHDR') return { width: view.getUint32(16), height: view.getUint32(20) }
    if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
        const kind = text(12, 4)
        if (kind === 'VP8X') return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) }
        if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
        if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) } }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2
        while (offset + 4 <= bytes.length) {
            if (bytes[offset++] !== 0xff) return null
            while (bytes[offset] === 0xff) offset++
            const marker = bytes[offset++]
            if (marker === undefined || marker === 0xda || marker === 0xd9) return null
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
            if (offset + 2 > bytes.length) return null
            const length = view.getUint16(offset)
            if (length < 2 || offset + length > bytes.length) return null
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
            offset += length
        }
    }
    return null
}
export async function readImageDimensions(file: File) {
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(file.slice(0, 256 * 1024))
    })
    return imageHeaderDimensions(new Uint8Array(bytes))
}
