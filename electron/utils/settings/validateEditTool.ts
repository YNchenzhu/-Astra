/**
 * Settings-side / pre-flight validation for FileEdit-style payloads (upstream validateEditTool analogue).
 *
 * Audit Bug A8: previously this validator allowed a `content`-only
 * payload (intended for full-file replace), but:
 *   - `editFileInputZod` requires both `oldString`/`newString` and
 *     rejects `content`-only input;
 *   - `registry.ts`'s `execute` path never wires `content` to
 *     `toolEditFile`.
 * So the `content`-only branch was dead, and the divergent semantics
 * confused maintainers. Aligning with Zod: `edit_file` must always
 * provide `oldString`+`newString`; full-file replace goes through
 * `Write`.
 */

export type EditToolValidation = { ok: true } | { ok: false; message: string }

/**
 * Compose the "identical strings" rejection message.
 *
 * When `oldString === newString` the agent has almost always fallen into
 * one of two Unicode traps (the third — a deliberate idempotent no-op —
 * is handled at the `registryBuiltinTools.ts` description layer, not
 * here):
 *
 *   1. **Look-alike confusables.** Typed ASCII `"` (U+0022) but meant
 *      curly `"` (U+201C) / `"` (U+201D); typed `'` (U+0027) meant
 *      `'` (U+2018) / `'` (U+2019); typed `-` (U+002D) meant en/em-dash
 *      U+2013 / U+2014; typed `"` for the corner-bracket `「` etc.
 *      Both sides of the edit visually look different to the agent
 *      because of font rendering, but the JSON payload only carries
 *      the byte-identical sequences.
 *
 *   2. **Literal `\uXXXX` written into both sides.** The agent meant
 *      "JSON-escape this Unicode codepoint" but wrote the 6 ASCII
 *      characters (`\`, `u`, hex, hex, hex, hex) on both sides instead
 *      of letting the JSON parser decode them. Both sides collapse to
 *      the same 6-char ASCII string.
 *
 * Listing the codepoints of what was actually received lets the agent
 * diagnose the mismatch themselves on the next turn.
 */
export function describeIdenticalEditPayload(s: string): string {
  if (s === '') return ''
  const chars = [...s]
  const sample = chars.slice(0, 8)
  const cps = sample
    .map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))
    .join(' ')
  const preview =
    s.length > 32 ? `${JSON.stringify(s.slice(0, 32))}…` : JSON.stringify(s)
  const containsLiteralUnicodeEscape = /\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/.test(s)
  const looksLikeAscii = chars.every((c) => {
    const cp = c.codePointAt(0)!
    return cp >= 0x20 && cp <= 0x7e
  })

  const lines: string[] = [`(both sides = ${preview}; codepoints: ${cps}${chars.length > 8 ? ' …' : ''}).`]

  // Advice below deliberately never recommends writing `\uXXXX` escapes:
  // that instruction is provider-dependent (structured function-calling
  // channels have no model-controlled JSON-syntax layer) and in observed
  // agent traces it taught models to double-escape, turning the escape
  // into 6 literal ASCII bytes and looping the failure. The only robust,
  // channel-independent fix is pasting the real glyph.
  if (containsLiteralUnicodeEscape) {
    lines.push(
      'Your payload contains a literal `\\uXXXX` sequence on BOTH sides. ' +
        'edit_file does not decode Unicode escapes — `old_string` and `new_string` are raw byte ' +
        'comparators (whatever the JSON parser hands the tool is compared byte-for-byte). ' +
        'If you wanted two DIFFERENT Unicode characters, put the actual glyphs into the values — ' +
        'copy them from a previous read_file output. Working example: ' +
        '`"old_string": "\u201d"`, `"new_string": "\u201c"` (real curly-quote characters, ' +
        'NOT the 6-char `\\u201d` escape text).',
    )
  } else if (looksLikeAscii) {
    lines.push(
      'If you intended to replace a "look-alike" character — e.g. ASCII `"` (U+0022) vs curly ' +
        '`\u201c`/`\u201d` (U+201C/U+201D), ASCII `\'` (U+0027) vs curly `\u2018`/`\u2019` (U+2018/U+2019), ' +
        'ASCII `-` (U+002D) vs en/em-dash (U+2013/U+2014), or corner brackets `\u300c`/`\u300d` — note that ' +
        'JSON only carries the literal bytes you typed. Paste the real target glyph from a previous ' +
        'read_file output into the side that needs it. Working example for straight\u2192curly: ' +
        '`"old_string": "\\"\u5f15\u7528\\""`, `"new_string": "\u201c\u5f15\u7528\u201d"` (the curly quotes are real ' +
        'characters copied from the file, not escape text). Do NOT write the 6-char `\\uXXXX` escape ' +
        'sequence as the value — the tool does not decode it and the match will fail.',
    )
  }
  return lines.length > 1 ? ' ' + lines.join(' ') : ' ' + lines[0]
}

/**
 * Shared shape check for an `expectedLineRange` value (single-edit top level
 * OR multi-edit per-entry). Returns a model-friendly error message, or null
 * when the value is well-formed / absent. Runtime guards downstream assume a
 * well-formed `[start, end]` tuple (integers, start >= 1, start <= end).
 */
function validateExpectedLineRangeShape(rangeRaw: unknown): string | null {
  if (rangeRaw === undefined) return null
  if (!Array.isArray(rangeRaw) || rangeRaw.length !== 2) {
    return (
      'expectedLineRange must be a 2-element array of 1-based line numbers, e.g. [42, 58]. ' +
      'Omit the field to fall back to legacy single-match behaviour.'
    )
  }
  const [start, end] = rangeRaw as [unknown, unknown]
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    return 'expectedLineRange entries must be integers (1-based line numbers).'
  }
  if (start < 1 || end < 1) {
    return 'expectedLineRange entries must be >= 1 (1-based line numbers).'
  }
  if (start > end) {
    return `expectedLineRange must have start <= end; got [${start}, ${end}].`
  }
  return null
}

/**
 * Validate edit_file / Edit tool input before touching disk.
 */
export function validateEditToolPayload(input: Record<string, unknown>): EditToolValidation {
  const fp =
    typeof input.filePath === 'string'
      ? input.filePath
      : typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : ''
  // Loosened gate (aligns with `editFileInputZod.superRefine` and
  // `toolEditFile`'s baseReadId fallback): tolerate a missing filePath when a
  // baseReadId is present. The executor recovers the path via
  // `findReadReceiptByReadId(baseReadId)`; if that fails it returns a clear
  // "filePath missing AND baseReadId unresolved" error. Without this, a model
  // that drops `filePath` on a chained edit (a common ~30% failure mode) hits a
  // spurious "filePath is required." here BEFORE the executor's recovery can run.
  const baseReadId =
    typeof input.baseReadId === 'string'
      ? input.baseReadId
      : typeof input.base_read_id === 'string'
        ? input.base_read_id
        : ''
  if (!fp.trim() && !baseReadId.trim()) {
    return {
      ok: false,
      message:
        'filePath is required (or supply baseReadId from a recent read_file / edit_file response so the path can be recovered).',
    }
  }

  const oldString =
    typeof input.oldString === 'string'
      ? input.oldString
      : typeof input.old_string === 'string'
        ? input.old_string
        : undefined
  const newString =
    typeof input.newString === 'string'
      ? input.newString
      : typeof input.new_string === 'string'
        ? input.new_string
        : undefined

  if ('content' in input && typeof input.content === 'string') {
    return {
      ok: false,
      message:
        'edit_file does not accept `content` — use Write for full-file replace, or Edit with oldString/newString.',
    }
  }

  if (oldString === undefined || newString === undefined) {
    return {
      ok: false,
      message: 'Provide both oldString and newString (Edit is a substring replace; use Write for full-file replace).',
    }
  }

  if (oldString === newString) {
    return {
      ok: false,
      message:
        'No changes to make: oldString and newString are identical.' +
        describeIdenticalEditPayload(oldString),
    }
  }

  if (oldString === '' && newString === '') {
    return { ok: false, message: 'oldString and newString cannot both be empty (no-op).' }
  }

  // P0 — expectedLineRange shape validation (soft cross-boundary guard).
  // We accept the camelCase OR snake_case alias and require: array of length
  // 2, both integers, both >= 1, start <= end. Anything else is a fast
  // rejection with a model-friendly message — the runtime guard inside
  // computeExpectedLineRangeViolation assumes a well-formed tuple.
  const rangeRaw =
    'expectedLineRange' in input ? input.expectedLineRange :
    'expected_line_range' in input ? input.expected_line_range :
    undefined
  const rangeShapeError = validateExpectedLineRangeShape(rangeRaw)
  if (rangeShapeError) {
    return { ok: false, message: rangeShapeError }
  }

  const hashAnchorRaw =
    'hashAnchor' in input ? input.hashAnchor :
    'hash_anchor' in input ? input.hash_anchor :
    undefined
  if (hashAnchorRaw !== undefined) {
    if (typeof hashAnchorRaw !== 'object' || hashAnchorRaw === null || Array.isArray(hashAnchorRaw)) {
      return { ok: false, message: 'hashAnchor must be an object from read_file line hashes, e.g. { startLine: 42, startHash: "a3" }.' }
    }
    const h = hashAnchorRaw as Record<string, unknown>
    const startLine = h.startLine ?? h.start_line
    const startHash = h.startHash ?? h.start_hash
    const endLine = h.endLine ?? h.end_line
    const endHash = h.endHash ?? h.end_hash
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
      return { ok: false, message: 'hashAnchor.startLine must be a 1-based integer line number.' }
    }
    if (typeof startHash !== 'string' || !/^[0-9a-f]{2}$/i.test(startHash.trim())) {
      return { ok: false, message: 'hashAnchor.startHash must be the 2-character hash shown by read_file, e.g. "a3".' }
    }
    if (endLine !== undefined && (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < startLine)) {
      return { ok: false, message: 'hashAnchor.endLine must be an integer >= startLine when provided.' }
    }
    if (endHash !== undefined && (typeof endHash !== 'string' || !/^[0-9a-f]{2}$/i.test(endHash.trim()))) {
      return { ok: false, message: 'hashAnchor.endHash must be the 2-character hash shown by read_file when provided.' }
    }
  }

  return { ok: true }
}

/**
 * Validate multi_edit_file payload before touching disk. Mirrors
 * {@link validateEditToolPayload} but applies the core single-edit checks
 * (oldString/newString required, identical strings rejected, both-empty
 * rejected) to EACH entry in the `edits` array. Per-edit
 * `expectedLineRange` (2026-07) gets the same shape validation as the
 * single-edit field; `hashAnchor` remains unsupported in multi-edit —
 * line hashes shift mid-batch, see {@link toolMultiEditFile}.
 */
export function validateMultiEditToolPayload(
  input: Record<string, unknown>,
): EditToolValidation {
  const fp =
    typeof input.filePath === 'string'
      ? input.filePath
      : typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : ''
  // Same loosened gate as validateEditToolPayload — tolerate a missing filePath
  // when baseReadId is present (toolMultiEditFile recovers the path via
  // recoverFilePathFromBaseReadId, and the loosened multiEditFileInputZod gate
  // already lets the request through). Prevents a spurious "filePath is
  // required." pre-check rejection on chained multi-edit batches where the
  // model dropped `filePath`.
  const baseReadId =
    typeof input.baseReadId === 'string'
      ? input.baseReadId
      : typeof input.base_read_id === 'string'
        ? input.base_read_id
        : ''
  if (!fp.trim() && !baseReadId.trim()) {
    return {
      ok: false,
      message:
        'filePath is required (or supply baseReadId from a recent read_file / edit_file response so the path can be recovered).',
    }
  }

  if ('content' in input && typeof input.content === 'string') {
    return {
      ok: false,
      message:
        'multi_edit_file does not accept `content` — use write_file for full-file replace, or list each substring change as an `edits[i]` entry with oldString/newString.',
    }
  }

  const rawEdits = input.edits
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return {
      ok: false,
      message:
        '`edits` must be a non-empty array of {oldString, newString, replaceAll?} objects.',
    }
  }

  for (let i = 0; i < rawEdits.length; i++) {
    const e = rawEdits[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return {
        ok: false,
        message: `edits[${i}] must be an object with oldString and newString.`,
      }
    }
    const rec = e as Record<string, unknown>
    const oldString =
      typeof rec.oldString === 'string'
        ? rec.oldString
        : typeof rec.old_string === 'string'
          ? rec.old_string
          : undefined
    const newString =
      typeof rec.newString === 'string'
        ? rec.newString
        : typeof rec.new_string === 'string'
          ? rec.new_string
          : undefined
    if (oldString === undefined || newString === undefined) {
      return {
        ok: false,
        message: `edits[${i}]: provide both oldString and newString (snake_case aliases allowed).`,
      }
    }
    if (oldString === newString) {
      return {
        ok: false,
        message:
          `edits[${i}]: oldString and newString are identical — remove this no-op entry.` +
          describeIdenticalEditPayload(oldString),
      }
    }
    if (oldString === '' && newString === '') {
      return {
        ok: false,
        message: `edits[${i}]: oldString and newString cannot both be empty (no-op).`,
      }
    }
    // Per-edit positional cross-check (2026-07): same shape rules as the
    // single-edit field. The range refers to PRE-BATCH file coordinates and
    // is validated against the original buffer in computeFileEditResultMulti.
    const entryRangeRaw =
      'expectedLineRange' in rec ? rec.expectedLineRange :
      'expected_line_range' in rec ? rec.expected_line_range :
      undefined
    const entryRangeError = validateExpectedLineRangeShape(entryRangeRaw)
    if (entryRangeError) {
      return { ok: false, message: `edits[${i}]: ${entryRangeError}` }
    }
  }

  return { ok: true }
}
