/**
 * Image ingestion: normalize odd/huge formats (heic, bmp, tiff, massive png)
 * into something every vendor accepts (JPEG/PNG) using `sharp`.
 */

import { readFile } from 'fs/promises'
import { LIMITS } from './types'

const DIRECT_ACCEPT: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

/**
 * 最大边长(像素)。Anthropic 硬上限 8000px,且 >~1568px 的部分对识别
 * 增益极小、纯烧 token;4096 是"保细节"与"省 token"的折中,与旧转码
 * 分支的硬编码一致(2026-07 审计修复时提取为常量)。
 */
const MAX_IMAGE_DIMENSION_PX = 4096

interface LoadedImage {
  base64: string
  mediaType: string
}

export async function loadImageForModel(
  filePath: string,
  declaredMime: string,
  sizeBytes: number,
): Promise<LoadedImage> {
  const buf = await readFile(filePath)

  // Fast path: format already accepted + reasonable byte size.
  //
  // 2026-07 审计修复:此前直传分支完全不看像素尺寸 —— 8000×6000 的照片
  // (JPEG 常在 5-15MB,低于 20MB 字节上限)原样进上下文,超出 provider
  // 像素上限或白白撑大 token。现在直传前用 sharp 探一次 metadata(仅读
  // 文件头,开销极小),超尺寸的落回下方转码分支缩放;sharp 不可用时保持
  // 旧行为直传。
  if (DIRECT_ACCEPT.has(declaredMime) && sizeBytes <= LIMITS.MAX_IMAGE_BYTES) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sharp = require('sharp') as typeof import('sharp')
      const meta = await sharp(buf, { failOn: 'none' }).metadata()
      const w = meta.width || 0
      const h = meta.height || 0
      if (w <= MAX_IMAGE_DIMENSION_PX && h <= MAX_IMAGE_DIMENSION_PX) {
        return { base64: buf.toString('base64'), mediaType: declaredMime }
      }
      // 超尺寸 → 落入下方转码分支缩放。
    } catch {
      return { base64: buf.toString('base64'), mediaType: declaredMime }
    }
  }

  // Try transcoding via sharp.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp') as typeof import('sharp')
    const img = sharp(buf, { failOn: 'none' })
    const meta = await img.metadata()
    let pipeline = img
    // Downscale if huge.
    if ((meta.width || 0) > MAX_IMAGE_DIMENSION_PX || (meta.height || 0) > MAX_IMAGE_DIMENSION_PX) {
      pipeline = pipeline.resize({
        width: MAX_IMAGE_DIMENSION_PX,
        height: MAX_IMAGE_DIMENSION_PX,
        fit: 'inside',
      })
    }
    const out = await pipeline.jpeg({ quality: 85 }).toBuffer()
    return { base64: out.toString('base64'), mediaType: 'image/jpeg' }
  } catch {
    // Last resort: send as-is even if vendor may reject.
    return { base64: buf.toString('base64'), mediaType: declaredMime || 'application/octet-stream' }
  }
}
