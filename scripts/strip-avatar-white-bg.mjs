/**
 * Generate `src/assets/assistant-avatar.png` from `src/assets/assistant-avatar.jpg`,
 * with the white background converted to transparency.
 *
 * Why this script exists:
 *   The source artwork is a JPG (no alpha channel), so the welcome screen's
 *   logo always rendered an opaque white square on top of the dark theme.
 *   Re-encoding to a transparent PNG with a graded alpha key lets the logo
 *   sit directly on `--bg-base` without a white halo.
 *
 * Algorithm:
 *   For each pixel, examine `lo = min(r, g, b)` — the chrominance of the
 *   "whitest" channel. Then:
 *     - lo == 255           → alpha = 0   (pure background)
 *     - HI ≤ lo < 255       → alpha ramps from ALPHA_FLOOR down to 0
 *                              (preserves a faint glow around the central
 *                               highlight without dragging the white halo
 *                               back in)
 *     - LO ≤ lo < HI        → alpha ramps from 255 down to ALPHA_FLOOR
 *                              (anti-aliased edge feather)
 *     - lo < LO             → alpha = 255 (logo interior, kept as-is)
 *
 * Usage: `node scripts/strip-avatar-white-bg.mjs`
 * Output: src/assets/assistant-avatar.png (re-run to regenerate after JPG change)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const srcJpg = path.join(repoRoot, 'src', 'assets', 'assistant-avatar.jpg')
const dstPng = path.join(repoRoot, 'src', 'assets', 'assistant-avatar.png')

const HI = 250
const LO = 180
const ALPHA_FLOOR = 36

async function main() {
  if (!fs.existsSync(srcJpg)) {
    throw new Error(`Source JPG not found: ${srcJpg}`)
  }

  const { data, info } = await sharp(srcJpg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let bgPixels = 0
  let edgePixels = 0
  let solidPixels = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const lo = Math.min(r, g, b)

    let alpha
    if (lo >= 255) {
      alpha = 0
      bgPixels++
    } else if (lo >= HI) {
      const t = (lo - HI) / (255 - HI)
      alpha = Math.round(ALPHA_FLOOR * (1 - t))
      edgePixels++
    } else if (lo >= LO) {
      const t = (lo - LO) / (HI - LO)
      alpha = Math.round(255 - (255 - ALPHA_FLOOR) * t)
      edgePixels++
    } else {
      alpha = 255
      solidPixels++
    }
    data[i + 3] = alpha
  }

  // Quantized palette PNG: the logo has a narrow blue/violet palette, so
  // 256 colours produces no visible banding while keeping the file size
  // close to the original JPG (which had no alpha channel).
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: true,
      quality: 90,
      colours: 256,
    })
    .toFile(dstPng)

  const stat = fs.statSync(dstPng)
  console.log(`wrote ${dstPng}`)
  console.log(`  ${info.width}x${info.height}, ${stat.size} bytes`)
  console.log(`  background pixels:  ${bgPixels}`)
  console.log(`  edge/feather:       ${edgePixels}`)
  console.log(`  solid logo pixels:  ${solidPixels}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
