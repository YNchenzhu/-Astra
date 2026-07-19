/**
 * Build a Windows-compatible multi-size .ico from `public/icon.png`.
 *
 * Why this script exists:
 *   electron-builder's rcedit step fails with "Unable to commit changes"
 *   when the .ico contains only a single PNG-encoded 256×256 entry. Windows
 *   Explorer + rcedit want classic BMP/DIB entries at smaller sizes. We emit
 *   sizes 16/24/32/48/64/128 as BMP/DIB and 256 as PNG (keeps file <200 KB
 *   while staying compatible).
 *
 * Usage: `node scripts/build-icon.mjs`
 * Input:  public/icon.png  (any size, ideally 1024×1024 or larger)
 * Output: public/icon.ico
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const srcPng = path.join(repoRoot, 'public', 'icon.png')
const dstIco = path.join(repoRoot, 'public', 'icon.ico')

const BMP_SIZES = [16, 24, 32, 48, 64, 128]
const PNG_SIZES = [256]

/**
 * Build a DIB (BMP without the BITMAPFILEHEADER) for a square BGRA image.
 * Includes the 1-bit AND mask (Windows icon spec). Height in BITMAPINFOHEADER
 * is 2× the image height because Windows stores XOR + AND masks stacked.
 */
function makeBmpDib(rgba, size) {
  const rowStride = size * 4
  const imageSize = rowStride * size
  const maskRowStride = Math.ceil(size / 32) * 4
  const maskSize = maskRowStride * size

  const headerSize = 40
  const buf = Buffer.alloc(headerSize + imageSize + maskSize)

  buf.writeUInt32LE(headerSize, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8)
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(imageSize, 20)
  buf.writeInt32LE(0, 24)
  buf.writeInt32LE(0, 28)
  buf.writeUInt32LE(0, 32)
  buf.writeUInt32LE(0, 36)

  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y
    const dstRow = headerSize + y * rowStride
    for (let x = 0; x < size; x++) {
      const srcIdx = (srcY * size + x) * 4
      buf[dstRow + x * 4 + 0] = rgba[srcIdx + 2]
      buf[dstRow + x * 4 + 1] = rgba[srcIdx + 1]
      buf[dstRow + x * 4 + 2] = rgba[srcIdx + 0]
      buf[dstRow + x * 4 + 3] = rgba[srcIdx + 3]
    }
  }
  return buf
}

async function main() {
  if (!fs.existsSync(srcPng)) {
    throw new Error(`Source PNG not found: ${srcPng}`)
  }

  const entries = []

  for (const size of BMP_SIZES) {
    const { data } = await sharp(srcPng)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    entries.push({ size, type: 'bmp', payload: makeBmpDib(data, size) })
  }

  for (const size of PNG_SIZES) {
    const pngBuf = await sharp(srcPng)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
    entries.push({ size, type: 'png', payload: pngBuf })
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dirEntries = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  entries.forEach((e, i) => {
    const o = i * 16
    dirEntries.writeUInt8(e.size === 256 ? 0 : e.size, o + 0)
    dirEntries.writeUInt8(e.size === 256 ? 0 : e.size, o + 1)
    dirEntries.writeUInt8(0, o + 2)
    dirEntries.writeUInt8(0, o + 3)
    dirEntries.writeUInt16LE(1, o + 4)
    dirEntries.writeUInt16LE(32, o + 6)
    dirEntries.writeUInt32LE(e.payload.length, o + 8)
    dirEntries.writeUInt32LE(offset, o + 12)
    offset += e.payload.length
  })

  const out = Buffer.concat([header, dirEntries, ...entries.map((e) => e.payload)])
  fs.writeFileSync(dstIco, out)

  console.log(`wrote ${dstIco}`)
  console.log(`total ${out.length} bytes, ${entries.length} images:`)
  entries.forEach((e) => console.log(`  ${e.type.padEnd(3)} ${e.size}x${e.size}  ${e.payload.length} bytes`))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
