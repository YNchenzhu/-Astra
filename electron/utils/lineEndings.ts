import fsImpl from 'node:fs'

/** UTF-8 BOM as JS string (Unicode scalar). */
export const UTF8_BOM_CHAR = '\uFEFF'

export type LineEndingStyle = 'crlf' | 'lf'

/** If any CRLF sequence exists, treat file as CRLF; else LF (covers CR-only as LF after normalize). */
export function detectLineEndingStyle(text: string): LineEndingStyle {
  return text.includes('\r\n') ? 'crlf' : 'lf'
}

/**
 * Normalize to internal `\n`, then apply `crlf` or `lf` for disk write.
 */
export function applyLineEndingStyle(text: string, style: LineEndingStyle): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return style === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

export function stripUtf8Bom(text: string): { body: string; hadBom: boolean } {
  if (text.startsWith(UTF8_BOM_CHAR)) {
    return { body: text.slice(1), hadBom: true }
  }
  return { body: text, hadBom: false }
}

/**
 * BOM-based encoding detection (upstream `detectEncodingForResolvedPath` parity).
 *
 * Looks at the first 4 bytes of a file's raw buffer to decide between
 * `'utf16le'` and `'utf8'`. The vast majority of files in modern repos are
 * UTF-8, but UTF-16LE shows up in legacy Windows artefacts (.reg, some
 * .ps1 / .psm1, certain .ini, some Notepad-default-saved files) — reading
 * those as 'utf-8' returns garbled bytes, and writing them back as 'utf-8'
 * silently migrates the encoding so Windows-native tools (registry
 * importer, older PowerShell hosts) can no longer parse them.
 *
 * Detected signatures:
 *   `FF FE`        → utf16le (BOM)
 *   `EF BB BF`     → utf-8   (BOM)
 *   anything else  → utf-8   (default — modern repos are virtually all UTF-8)
 *
 * UTF-16BE (`FE FF`) is intentionally NOT detected: in our workspace
 * profile it's vanishingly rare and Node's `fs.readFileSync(p, 'utf16be')`
 * doesn't exist natively, so claiming support without a working write
 * path would be worse than punting. If we ever need it, add a Buffer
 * `swap16()` step and document the round-trip cost.
 *
 * `bytesRead === 0` (empty file) returns `'utf8'` — upstream's `fileRead.ts`
 * line 29 documents the same explicit choice: an empty file shouldn't be
 * tagged "ascii" because then writing emoji / CJK content into it would
 * misencode.
 */
export function detectBufferEncoding(buffer: Buffer | Uint8Array): BufferEncoding {
  const len = buffer.length
  if (len === 0) return 'utf8'
  if (len >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  if (
    len >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }
  return 'utf8'
}

/**
 * Read a file and return both its content (decoded in the right encoding) and
 * the detected encoding for round-tripping. Centralised so every file-mutating
 * tool gets identical BOM-based UTF-16LE detection without each call site
 * duplicating the `readFileSync(p) → detectBufferEncoding → readFileSync(p, enc)`
 * dance.
 *
 * For files that don't exist, the caller's `fs.readFileSync` would throw; we
 * mirror that behaviour by letting the error propagate so callers can decide
 * (e.g. create-new-file vs error-out) — exactly what `fs.readFileSync` would
 * give them, just with `encoding` added.
 *
 * Two reads of the same file in succession is cheap (kernel page cache); the
 * alternative — decode UTF-16LE in JS from the raw bytes — duplicates Node's
 * built-in conversion and risks subtle BOM/handling drift.
 */
export function readFileSyncWithDetectedEncoding(
  filePath: string,
): { content: string; encoding: BufferEncoding } {
  // `Buffer.toString(encoding)` for `'utf16le'` interprets the leading
  // `FF FE` pair as the BOM CHARACTER (`U+FEFF`) and yields it as the
  // string's first code unit; same for `'utf-8'` on an `EF BB BF` prefix
  // (yields the BOM char). In both cases the BOM survives as a normal
  // character in the JS string, so the model gets to see + decide
  // whether to keep it on rewrite. Round-trip:
  //   `read → '\uFEFF...' → write same → bytes back to `FF FE …` /
  //    `EF BB BF …`` — preserved.
  // This matches `fs.readFileSync(p, 'utf-8')` on a BOM-prefixed file
  // (Node never strips BOM for `'utf-8'`) so behaviour is symmetric.
  const raw = fsImpl.readFileSync(filePath)
  const encoding = detectBufferEncoding(raw)
  const content = Buffer.from(raw).toString(encoding)
  return { content, encoding }
}
