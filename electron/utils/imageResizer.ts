/**
 * Image reading + resizing for the read_file tool.
 *
 * Uses sharp to detect format, resize, and convert images to base64
 * suitable for Anthropic's multimodal API (image content blocks).
 */

import { readFile } from 'fs/promises'
import type { ToolResult } from '../ai/tools'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const MAX_DIMENSION = 1568
const JPEG_QUALITY = 80
const MAX_BASE64_BYTES = 5 * 1024 * 1024 // ~5 MB base64

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const MAGIC_BYTES: Array<{ prefix: number[]; type: ImageMediaType }> = [
  { prefix: [0x89, 0x50, 0x4e, 0x47], type: 'image/png' },
  { prefix: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  { prefix: [0x47, 0x49, 0x46, 0x38], type: 'image/gif' },
  { prefix: [0x52, 0x49, 0x46, 0x46], type: 'image/webp' }, // RIFF....WEBP
]

function detectMediaType(buffer: Buffer): ImageMediaType {
  for (const { prefix, type } of MAGIC_BYTES) {
    if (prefix.every((b, i) => buffer[i] === b)) {
      if (type === 'image/webp') {
        // Verify WEBP signature at offset 8
        if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return type
        continue
      }
      return type
    }
  }
  return 'image/png' // fallback
}

export interface ImageReadResult {
  base64: string
  mediaType: string
  originalSize: number
  width?: number
  height?: number
}

/**
 * Read an image file, optionally resize if too large, return base64 + metadata.
 */
export async function readImageAsBase64(filePath: string): Promise<ToolResult> {
  try {
    const buffer = await readFile(filePath)
    const mediaType = detectMediaType(buffer)
    const originalSize = buffer.length

    let sharp: typeof import('sharp') | undefined
    try {
      sharp = (await import('sharp')).default
    } catch {
      // sharp not available — return raw base64 if small enough
    }

    if (!sharp) {
      const b64 = buffer.toString('base64')
      if (b64.length > MAX_BASE64_BYTES) {
        return { success: false, error: `Image too large (${(originalSize / 1024 / 1024).toFixed(1)} MB). Install sharp for automatic resizing.` }
      }
      return {
        success: true,
        output: `[Image: ${filePath} (${originalSize} bytes, ${mediaType})]`,
        contentBlocks: [{ type: 'image', base64: b64, mediaType }],
      }
    }

    // Get metadata and resize if needed
    const img = sharp(buffer)
    const meta = await img.metadata()
    const width = meta.width || 0
    const height = meta.height || 0

    let processedBuffer: Buffer
    let processedType = mediaType

    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      processedBuffer = await img
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer()
      processedType = 'image/jpeg'
    } else {
      processedBuffer = buffer
    }

    let b64 = processedBuffer.toString('base64')

    // If still too large, progressive quality reduction
    if (b64.length > MAX_BASE64_BYTES) {
      for (const quality of [60, 40, 20]) {
        processedBuffer = await sharp(buffer)
          .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer()
        b64 = processedBuffer.toString('base64')
        processedType = 'image/jpeg'
        if (b64.length <= MAX_BASE64_BYTES) break
      }
    }

    if (b64.length > MAX_BASE64_BYTES) {
      return { success: false, error: `Image too large even after resizing (${(b64.length / 1024 / 1024).toFixed(1)} MB base64)` }
    }

    return {
      success: true,
      output: `[Image: ${filePath} (${originalSize} bytes, ${width}x${height}, ${processedType})]`,
      contentBlocks: [{ type: 'image', base64: b64, mediaType: processedType }],
    }
  } catch (error) {
    return { success: false, error: `Failed to read image: ${error instanceof Error ? error.message : String(error)}` }
  }
}
