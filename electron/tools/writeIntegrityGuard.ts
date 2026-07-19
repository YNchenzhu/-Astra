/**
 * Single source of truth for "is this write safe to perform?" decisions.
 *
 * All disk-mutating file paths in the app MUST route their decision through
 * this module so the rules can only drift in one place. Historically the
 * destructive-clear check (refuse to overwrite a non-empty file with empty
 * content) was reimplemented inline in at least four independent locations:
 *
 *   1. electron/ai/tools.ts       → toolWriteFile
 *   2. electron/ai/tools.ts       → toolEditFile
 *   3. electron/fs/handlers.ts    → fs:write-file IPC
 *   4. electron/ai/runAgenticToolUse.ts → pre-approval diff preview
 *
 * Each copy had a slightly different idea of "empty" (strict `=== ''` vs.
 * post-BOM-strip vs. post-normalisation), which let inputs like a lone
 * `\uFEFF` or a single CRLF slip past the tool-layer guards and clobber real
 * file content. Consolidating here means: add one rule, every writer inherits
 * it. Remove one rule, every writer inherits that too.
 *
 * Two phases are exposed:
 *   • {@link assertPreWriteIntegrity}   — before `fs.writeFileSync`
 *   • {@link verifyPostWriteIntegrity}  — after `fs.writeFileSync`, by
 *     re-reading the file and comparing to the intended bytes. This closes
 *     the window where a partial write / filesystem quirk / antivirus hook
 *     could leave the file in a state the tool never intended, and makes
 *     sure a successful `ToolResult` only ever escapes the process when the
 *     on-disk bytes really do match what we promised.
 */

import fs from 'node:fs'
import { stripUtf8Bom } from '../utils/lineEndings'

/** Which caller is performing the write (purely for diagnostic messages). */
export type WriteIntent =
  | 'write'        // Write / write_file tool: full-file replace
  | 'edit'         // Edit / edit_file tool: old_string→new_string replace
  | 'notebook'     // NotebookEdit tool
  | 'ipc-save'     // fs:write-file IPC (user-initiated save from renderer)
  | 'preview'      // runAgenticToolUse diff preview (pre-approval supervisor)

export interface PreWriteIntegrityInput {
  /** Absolute resolved path (used only for error messages, not I/O). */
  resolvedPath: string
  /** Display path shown to the caller / model. */
  displayPath: string
  /** Current on-disk content. Use `''` for a new-file create intent. */
  previousContent: string
  /** Proposed bytes that would replace it. */
  nextContent: string
  /** Whether a file already exists at `resolvedPath` (create vs. update). */
  fileExisted: boolean
  /** Which caller is performing the write. */
  intent: WriteIntent
}

export interface PreWriteIntegrityOk {
  ok: true
}

export interface PreWriteIntegrityFail {
  ok: false
  /** Stable machine-readable error code (useful for tests / telemetry). */
  code: WriteIntegrityCode
  /** Human-readable message safe to surface in ToolResult.error. */
  error: string
}

export type PreWriteIntegrityResult = PreWriteIntegrityOk | PreWriteIntegrityFail

/**
 * Machine-readable codes for each rule. Error strings may evolve; codes
 * should be stable across versions so tests / logs can rely on them.
 */
/**
 * Machine-readable codes for each rule. Using an `as const` object instead of
 * `enum` to stay compatible with `erasableSyntaxOnly: true`.
 */
export const WriteIntegrityCode = {
  /** Pre-normalisation empty (literal `next === ''` while file has bytes). */
  DestructiveEmptyWrite: 'destructive_empty_write',
  /** Post-BOM-strip empty (e.g. `\uFEFF` only) while file has real body. */
  DestructiveWhitespaceLikeWrite: 'destructive_whitespace_like_write',
  /** fs.writeFileSync returned but disk bytes don't match intended bytes. */
  PostWriteMismatch: 'post_write_mismatch',
  /** fs.writeFileSync returned but re-reading the file failed. */
  PostWriteReadFailed: 'post_write_read_failed',
} as const
export type WriteIntegrityCode = typeof WriteIntegrityCode[keyof typeof WriteIntegrityCode]

function destructiveClearMessage(intent: WriteIntent): string {
  if (intent === 'edit') {
    return (
      'Refusing to apply an edit that would clear the entire file. ' +
      'Use a narrower old_string/new_string, or delete the file explicitly if you intend to remove all content.'
    )
  }
  // write, ipc-save, notebook, preview share the same canonical message
  return (
    'Refusing to write empty content to an existing file (would clear the file). ' +
    'Delete the file or use Edit if you intend to remove content.'
  )
}

/**
 * Gate run BEFORE writing to disk (or before showing an approval UI).
 *
 * Rules, in order of precedence:
 *
 *   1. Creating a new file: always allowed. A caller that wants to reject
 *      new-file empties (e.g. `toolEditFile`'s "Refusing to create an empty
 *      file" rule for the create branch) must do so itself — that is a
 *      tool-specific policy, not an integrity invariant.
 *
 *   2. Updating an existing file that has no real body content (either the
 *      raw bytes are empty, or the only bytes are a UTF-8 BOM): allowed.
 *      Going from "empty / BOM-only" to anything (including empty) is not
 *      destructive — there is no real content to lose. We do this check
 *      with `stripUtf8Bom` rather than `previousContent.length === 0`
 *      because a strict literal-empty check wrongly flagged BOM-only files
 *      as having content worth protecting (test E21).
 *
 *   3. Updating an existing file (with a real body) using literal
 *      `nextContent === ''`: rejected as
 *      {@link WriteIntegrityCode.DestructiveEmptyWrite}.
 *
 *   4. Updating an existing file where `previousContent` has a non-empty
 *      body (after BOM stripping) but `nextContent` collapses to an empty
 *      body after BOM stripping: rejected as
 *      {@link WriteIntegrityCode.DestructiveWhitespaceLikeWrite}. This
 *      catches lone-BOM / lone-CRLF payloads that the strict `=== ''`
 *      check used to let through.
 */
export function assertPreWriteIntegrity(
  input: PreWriteIntegrityInput,
): PreWriteIntegrityResult {
  const { previousContent, nextContent, fileExisted, intent } = input

  if (!fileExisted) {
    return { ok: true }
  }

  const prevBody = stripUtf8Bom(previousContent).body
  if (prevBody.length === 0) {
    // Existing file on disk has no real body (empty, or only a UTF-8 BOM).
    // Replacing it with anything — including empty bytes — is not
    // destructive: there is no body content to preserve.
    return { ok: true }
  }

  if (nextContent === '') {
    return {
      ok: false,
      code: WriteIntegrityCode.DestructiveEmptyWrite,
      error: destructiveClearMessage(intent),
    }
  }

  const nextBody = stripUtf8Bom(nextContent).body
  if (nextBody.length === 0) {
    return {
      ok: false,
      code: WriteIntegrityCode.DestructiveWhitespaceLikeWrite,
      error: destructiveClearMessage(intent),
    }
  }

  return { ok: true }
}

export interface PostWriteIntegrityInput {
  /** Absolute resolved path that was just written. */
  resolvedPath: string
  /** Display path shown to the caller / model. */
  displayPath: string
  /** The exact bytes the tool intended to persist. */
  expectedContent: string
  /** Which caller performed the write. */
  intent: WriteIntent
  /**
   * Encoding the file was written with (audit fix 2026-07, P1): a UTF-16LE
   * file re-read as UTF-8 produces garbage bytes that can NEVER equal
   * `expectedContent`, so every successful UTF-16 write used to fail this
   * verify and the tool reported an error for a write that landed fine.
   * Callers that round-trip a detected encoding (toolEditFile /
   * toolWriteFile / fs:write-file) must pass it through. Default 'utf-8'.
   */
  encoding?: BufferEncoding
}

export interface PostWriteIntegrityOk {
  ok: true
  /** Re-read disk content — callers may reuse this to avoid a second read. */
  actualContent: string
}

export interface PostWriteIntegrityFail {
  ok: false
  code: WriteIntegrityCode
  error: string
}

export type PostWriteIntegrityResult =
  | PostWriteIntegrityOk
  | PostWriteIntegrityFail

/**
 * Gate run AFTER writing to disk. Re-reads the file and compares it byte-
 * for-byte against what the tool thought it wrote. Catches:
 *
 *   • partial writes (disk full, interrupted fsync)
 *   • filesystem transforms we didn't expect (case folding, junction magic)
 *   • antivirus / EDR intercepting and rewriting the payload
 *   • concurrent writer that raced us inside our own exclusive lock
 *     (shouldn't happen, but verifying is cheap compared to silently
 *     emitting a successful ToolResult for bytes the user didn't author)
 *
 * When this fails, the caller MUST surface an error instead of returning
 * success, so the model / user can retry rather than trust a false-positive
 * "write succeeded" message.
 *
 * Callers that already hold the file contents in memory (e.g. because they
 * just wrote them) can still use this — we always re-read from disk to
 * actually catch the very problems this is designed to detect.
 */
export function verifyPostWriteIntegrity(
  input: PostWriteIntegrityInput,
): PostWriteIntegrityResult {
  const { resolvedPath, displayPath, expectedContent } = input

  let actual: string
  try {
    actual = fs.readFileSync(resolvedPath, input.encoding ?? 'utf-8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      code: WriteIntegrityCode.PostWriteReadFailed,
      error:
        `Post-write verification failed: could not re-read "${displayPath}" ` +
        `to confirm the disk contents (${reason}).`,
    }
  }

  if (actual !== expectedContent) {
    const expectedLen = Buffer.byteLength(expectedContent, 'utf8')
    const actualLen = Buffer.byteLength(actual, 'utf8')
    return {
      ok: false,
      code: WriteIntegrityCode.PostWriteMismatch,
      error:
        `Post-write verification failed for "${displayPath}": disk bytes ` +
        `(${actualLen} bytes) do not match the bytes the tool attempted to ` +
        `write (${expectedLen} bytes). The write did not land as intended; ` +
        `read the file and retry.`,
    }
  }

  return { ok: true, actualContent: actual }
}
