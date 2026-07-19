/**
 * Edit-file tool — replace old_string with new_string using upstream Edit semantics.
 */

import fs from 'node:fs'
import path from 'node:path'
import { notifyWorkspaceFileMutation } from '../fs/workspaceFileNotify'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from './toolExecutionScope'
import { buildChangeSummaryTrailer } from './changeSummary'

/**
 * Audit §3.2 wire-up — shared "record this disk write into the global
 * quota window AND into the per-tool resource delta" hook. Called by
 * both edit branches (create path + edit-in-place path) so the file-rate
 * quota and per-tool snapshot stay accurate.
 */
function recordDiskWriteForEdit(bytesWritten: number): void {
  if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) return
  try {
    getResourceQuotaManager().recordDiskWrite(bytesWritten)
    const toolUseIdForDelta = getToolUseIdFromStopScope()
    if (toolUseIdForDelta) {
      recordToolResourceDelta(toolUseIdForDelta, { diskWriteBytes: bytesWritten })
    }
  } catch (e) {
    // Telemetry must never break a successful edit.
    console.warn('[toolEditFile] quota.recordDiskWrite failed:', e)
  }
}
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { atomicWriteFile } from '../diff/atomicWriter'
import {
  awaitDiskWriteAndFreshDiagnostics,
  DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
} from '../lsp/diskMutationSync'
import { buildLspDiagnosticsTrailer } from '../lsp/lspDiagnosticsTrailer'
import { getWorkspacePath, resolvePathForTool } from '../tools/workspaceState'
import { withExclusiveFileLock } from '../tools/fileLock'
import {
  assertReadBeforeEditByReadId,
  assertReadBeforeWrite,
  buildReadIdRebindNotice,
  buildNextEditTrailer,
  findReadReceiptByReadId,
  hashFileContent,
  recordSelfMutationReadReceipt,
} from '../tools/readFileState'
import type { ToolResult } from '../tools/types'
import {
  readFileSyncWithDetectedEncoding,
  stripUtf8Bom,
} from '../utils/lineEndings'
import { gateFileMutatePath } from '../tools/fileToolValidation'
import { getAgentContext } from '../agents/agentContext'
import {
  computeFileEditResult,
  computeExpectedLineRangeViolation,
  hashReadLine,
  normalizeOneFileEdit,
  MAX_EDIT_FILE_BYTES,
  formatFileSize,
  type ExpectedLineRange,
} from './fileEditSemantics'
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
} from '../tools/writeIntegrityGuard'
import { buildToolFailure } from '../tools/toolErrorFormat'
import { buildFuzzyNotFoundError, editDistance } from '../tools/fuzzyPathError'
import { findSimilarFile } from './toolReadFile'
import {
  buildEllipsisError,
  detectPlaceholderEllipsis,
  tryReadAndExpand,
} from './fileEditPlaceholder'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type HashLineAnchor = {
  startLine: number
  startHash: string
  endLine?: number
  endHash?: string
}

type LineSpan = {
  lineNumber1: number
  start: number
  end: number
  textForHash: string
}

function computeLineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  let lineNumber1 = 1
  while (start <= content.length) {
    const nl = content.indexOf('\n', start)
    const rawEnd = nl === -1 ? content.length : nl
    const textEnd = rawEnd > start && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
    spans.push({
      lineNumber1,
      start,
      end: rawEnd,
      textForHash: content.slice(start, textEnd),
    })
    if (nl === -1) break
    start = nl + 1
    lineNumber1++
  }
  return spans
}

function validateAndResolveHashAnchor(
  content: string,
  anchor: HashLineAnchor,
): { ok: true; start: number; end: number } | { ok: false; error: string } {
  const startLine = anchor.startLine
  const endLine = anchor.endLine ?? anchor.startLine
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { ok: false, error: 'hashAnchor must use 1-based integer lines with startLine <= endLine.' }
  }
  const spans = computeLineSpans(content)
  const startSpan = spans[startLine - 1]
  const endSpan = spans[endLine - 1]
  if (!startSpan || !endSpan) {
    return { ok: false, error: `hashAnchor points outside the file (got lines ${startLine}-${endLine}). Re-read the file and retry.` }
  }
  const actualStartHash = hashReadLine(startSpan.textForHash)
  const actualEndHash = hashReadLine(endSpan.textForHash)
  const expectedStartHash = anchor.startHash.trim().toLowerCase()
  const expectedEndHash = (anchor.endHash ?? anchor.startHash).trim().toLowerCase()
  if (actualStartHash !== expectedStartHash || actualEndHash !== expectedEndHash) {
    return {
      ok: false,
      error:
        `hashAnchor mismatch: expected ${startLine}:${expectedStartHash}` +
        `${endLine !== startLine ? `..${endLine}:${expectedEndHash}` : ''}, ` +
        `but current file has ${startLine}:${actualStartHash}` +
        `${endLine !== startLine ? `..${endLine}:${actualEndHash}` : ''}. ` +
        'The file changed or the anchor is stale; call read_file again and retry with fresh hashes.',
    }
  }
  return { ok: true, start: startSpan.start, end: endSpan.end }
}

function computeHashAnchoredEditResult(
  content: string,
  oldString: string,
  newString: string,
  hashAnchor: HashLineAnchor | undefined,
): { success: true; newContent: string } | { success: false; error: string } | null {
  if (!hashAnchor) return null
  const anchor = validateAndResolveHashAnchor(content, hashAnchor)
  if (!anchor.ok) {
    // upstream alignment Part 3: hashAnchor is a project-local helper that
    // doesn't exist in upstream. A stale or invalid anchor must not block an
    // otherwise valid edit — soft-warn and fall back to unanchored matching.
    // Returning null instead of {success:false} hands control back to
    // `result = anchoredResult ?? unanchoredResult` in the caller.
    console.warn(`[edit_file] hashAnchor invalid; falling back to unanchored match. Original: ${anchor.error}`)
    return null
  }
  const anchoredContent = content.slice(anchor.start, anchor.end)
  const anchoredResult = computeFileEditResult(anchoredContent, oldString, newString, { replaceAll: false })
  if (!anchoredResult.success) {
    // upstream alignment Part 3: anchor is valid but old_string didn't match
    // inside the windowed range. Soft-warn + fall back so the unanchored
    // match (which scans the entire file) gets a chance — same end behavior
    // as upstream (no anchor concept at all).
    console.warn(
      `[edit_file] old_string not found inside hashAnchor range; falling back to unanchored match. Original: ${anchoredResult.error}`,
    )
    return null
  }
  return {
    success: true,
    newContent: content.slice(0, anchor.start) + anchoredResult.newContent + content.slice(anchor.end),
  }
}

function canTreatExpectedLineRangeAsStale(
  violation: ReturnType<typeof computeExpectedLineRangeViolation>,
  expectedLineRange: ExpectedLineRange,
  options: {
    replaceAll?: boolean
    strongReadAnchorPassed: boolean
  },
): boolean {
  if (violation.ok) return false
  if (violation.code !== 'OUT_OF_WINDOW') return false
  if (options.replaceAll === true) return false
  if (!options.strongReadAnchorPassed) return false
  if (!violation.hits || violation.hits.length !== 1) return false

  const [expectedStart, expectedEnd] = expectedLineRange
  const expectedLineCount = expectedEnd - expectedStart + 1
  const hit = violation.hits[0]
  const actualLineCount = hit.maxLine1 - hit.minLine1 + 1
  const overlapsDeclaredRange =
    hit.minLine1 <= expectedEnd && hit.maxLine1 >= expectedStart

  // Treat only "same-sized block moved elsewhere" as a stale line-number
  // signal. If the hit overlaps the declared range at all, keep rejecting:
  // that is the classic boundary-glue shape where old_string starts inside
  // the intended block but leaks into adjacent code.
  return !overlapsDeclaredRange && actualLineCount === expectedLineCount
}

// (was `fsyncFileSync` — removed when this file switched to atomicWriteFile,
// which performs its own fsync on the temp file before the atomic rename
// plus a best-effort parent-dir fsync afterwards on Windows. Keeping a
// duplicate sync here would just be a redundant readback.)

/**
 * Edit a file by replacing old_string with new_string (upstream Edit semantics).
 * Default: single occurrence; set replaceAll to replace every match.
 * Empty old_string on an empty file (or whitespace-only old on empty file) replaces content; empty old on a non-empty file errors.
 */
export async function toolEditFile(
  filePath: string,
  oldString: string,
  newString: string,
  options?: {
    replaceAll?: boolean
    baseReadId?: string
    /**
     * P0 soft cross-boundary guard. Optional 1-based [startLine, endLine].
     * The tool rejects edits whose actual hit lines fall outside this
     * window. Shape is validated upstream in `validateEditTool.ts`.
     */
    expectedLineRange?: ExpectedLineRange
    /**
     * Hashline-lite anchor from read_file output (`line:hash`). When present,
     * the line hashes must still match current disk content. For single edits,
     * the oldString may be resolved inside this anchored line range.
     */
    hashAnchor?: HashLineAnchor
  },
): Promise<ToolResult> {
  try {
    // baseReadId fallback — see `toolMultiEditFile.ts` for the full
    // rationale. Mirror that recovery here so the loosened Zod gate in
    // `editFileInputZod` doesn't translate "missing filePath" into a
    // hard error when the model already gave us enough info via
    // baseReadId to identify the target file.
    if ((typeof filePath !== 'string' || !filePath.trim()) && options?.baseReadId) {
      const brid = options.baseReadId.trim()
      if (brid) {
        const hit = findReadReceiptByReadId(brid)
        if (hit) filePath = hit.record.absPath ?? hit.resolvedPathKey
      }
    }
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return {
        success: false,
        ...buildToolFailure({
          what: 'edit_file: `filePath` is missing or empty.',
          next:
            'Pass a file path (absolute or relative to the workspace root). ' +
            (options?.baseReadId
              ? 'You supplied a baseReadId but it could not be resolved — re-read the file with `read_file` and use the FRESH readId from that response.'
              : 'You can also supply `baseReadId` from a recent read_file response if filePath is hard to round-trip.'),
        }, 'validation'),
      }
    }
    const { body: obEmpty } = stripUtf8Bom(oldString)
    const { body: nbEmpty } = stripUtf8Bom(newString)
    if (obEmpty === '' && nbEmpty === '') {
      return {
        success: false,
        error: 'old_string and new_string cannot both be empty (no-op).',
      }
    }
    // Literal "..." / "…" ellipsis inside old_string is the #1 failure pattern
    // for agentic Edit calls: the model abbreviates long code with a placeholder
    // expecting us to pattern-match, which we deliberately don't do (too risky —
    // a partial-match Edit would silently clobber unrelated code).
    //
    // Detection is **whitespace/comment-bounded** so we don't false-positive on
    // legit JS/TS spread/rest (`(...args)`, `[...arr]`, `{ ...obj }`) or Python
    // function bodies (`def stub(): ...`). Detection rules:
    //   - ASCII `...` flanked by whitespace OR preceded by a comment marker
    //     (`//`, `#`, `/*`, `<!--`).
    //   - Unicode single-char `…` (unambiguous — never legit syntax).
    //
    // When a placeholder is detected we try to **suggest the expanded
    // old_string** by reading the target file and finding a globally-unique
    // prefix-and-suffix anchor pair. If both anchors hit exactly once, the
    // intervening bytes are the AI's intent — we return them in the error so
    // the next retry can paste verbatim instead of doing another read_file
    // round-trip. If anchors are missing/non-unique, we fall back to the
    // original "use read_file first" message.
    //
    // We intentionally do NOT auto-execute the expansion: the suggestion is a
    // hint for the next call, the gate stays "always reject placeholders".
    //
    // Note: we intentionally do NOT reject `old_string === new_string`. That
    // shape is a legitimate idempotent re-application (user/AI replayed a
    // successful edit) and is short-circuited downstream as
    // "No changes to write (file already matches)".
    const detected = detectPlaceholderEllipsis(obEmpty)
    if (detected) {
      const suggestion = tryReadAndExpand(filePath, obEmpty, detected, options?.replaceAll === true)
      return {
        success: false,
        error: buildEllipsisError(detected, suggestion),
      }
    }
    const resolveResult = resolvePathForTool(filePath)
    if (!resolveResult.ok) {
      return { success: false, error: resolveResult.reason }
    }
    const resolvedPath = resolveResult.resolved
    const mutateGate = gateFileMutatePath(filePath, resolvedPath)
    if (!mutateGate.ok) {
      return { success: false, error: mutateGate.error }
    }

    const ext = path.extname(resolvedPath).toLowerCase()
    const exists = fs.existsSync(resolvedPath)

    if (exists) {
      if (ext === '.ipynb') {
        return {
          success: false,
          error:
            'This path is a Jupyter notebook (.ipynb). Use the NotebookEdit tool to edit notebook cells.',
        }
      }
      let st: fs.Stats
      try {
        st = fs.statSync(resolvedPath)
      } catch (e) {
        return { success: false, error: getErrorMessage(e) }
      }
      if (!st.isFile()) {
        return { success: false, error: `Not a file: ${filePath}` }
      }
      if (st.size > MAX_EDIT_FILE_BYTES) {
        return {
          success: false,
          error: `File is too large to edit (${formatFileSize(st.size)}). Maximum editable size is ${formatFileSize(MAX_EDIT_FILE_BYTES)}.`,
        }
      }
    }

    if (!exists) {
      // Path self-healing via the baseReadId receipt: when the model
      // supplies a readId whose receipt points at an EXISTING file whose
      // basename is a near-typo of the requested one (classic long-CJK
      // char-drop, e.g. "中等专业学校" typed as "等专业学校"), redirect the
      // edit to the receipt path instead of bouncing a "Did you mean"
      // back for another turn. Safe because the receipt proves the model
      // READ that exact file, and the recursive call re-runs every gate
      // (mutate-path sandbox, hash anchor, read-before-edit) against the
      // corrected path. Distance is capped at 2 so a receipt for a
      // genuinely different file never hijacks a deliberate new-path edit.
      // Runs BEFORE the expectedLineRange rejection below — a recovered
      // path makes the declared range meaningful again. Create-via-edit
      // (empty old_string) is excluded: a typo'd path there means the model
      // wants a new file at the path it typed, not the one it read.
      if (obEmpty.trim() !== '' && options?.baseReadId) {
        const receipt = findReadReceiptByReadId(options.baseReadId.trim())
        const receiptPath = receipt?.record.absPath
        if (receiptPath && fs.existsSync(receiptPath)) {
          const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
          const isDifferentPath = norm(receiptPath) !== norm(resolvedPath)
          const closeTypo =
            editDistance(
              path.basename(receiptPath).toLowerCase(),
              path.basename(resolvedPath).toLowerCase(),
            ) <= 2
          if (isDifferentPath && closeTypo) {
            const redirected = await toolEditFile(receiptPath, oldString, newString, options)
            if (redirected.success) {
              return {
                ...redirected,
                output:
                  `Note: filePath "${filePath}" does not exist; the edit was applied to ` +
                  `"${receiptPath}" (recovered from baseReadId — your path had a near-miss typo). ` +
                  `Use the corrected path in subsequent calls.\n${redirected.output ?? ''}`,
              }
            }
            // Redirect failed for a content-level reason — surface THAT
            // error (it is about the file the model actually read), not a
            // misleading not-found for the typo'd path.
            return redirected
          }
        }
      }
      // expectedLineRange has no meaning for file-creation (no pre-existing
      // lines to anchor against). Refuse loudly instead of silently ignoring
      // — the model probably has stale state about whether the file exists.
      if (options?.expectedLineRange) {
        return {
          success: false,
          error:
            `Cannot apply expectedLineRange to "${filePath}": the file does not exist yet, so ` +
            `there are no lines to anchor against. Either drop expectedLineRange (this is a ` +
            `create-via-edit), or read_file the target first to confirm it actually exists.`,
        }
      }
      const { body: oldB } = stripUtf8Bom(oldString)
      if (oldB.trim() !== '') {
        // Non-empty old_string + missing file = the model is editing a file
        // that doesn't exist. The "create-via-edit" branch below handles
        // empty old_string. Here we return the rich fuzzy not-found so the
        // model gets BOTH the parent-dir listing (catches typo on the leaf)
        // AND a workspace-wide basename scan hint (catches wrong-folder
        // typos where the right file lives elsewhere).
        const ws = getWorkspacePath()
        const extraNext: string[] = []
        const basename = path.basename(resolvedPath)
        if (basename && basename.length > 2 && ws) {
          try {
            const found = findSimilarFile(basename, ws)
            if (found) {
              const relativeFound = path.relative(ws, found).replace(/\\/g, '/')
              extraNext.push(
                `A file with the same basename exists elsewhere in the workspace: "${relativeFound}". ` +
                  `Use that path if it is what you meant.`,
              )
            }
          } catch { /* ignore suggestion errors */ }
        }
        extraNext.push(
          'To create a NEW file at this path, call edit_file again with `oldString: ""` ' +
            '(empty) and your file contents as `newString`. Otherwise correct `filePath` and retry.',
        )
        return {
          success: false,
          ...buildFuzzyNotFoundError({
            toolName: 'edit_file',
            kind: 'file',
            inputPath: filePath,
            resolvedPath,
            workspace: ws ?? undefined,
            extraNext,
          }),
        }
      }
      const computed = computeFileEditResult('', oldString, newString, options)
      if (!computed.success) {
        return { success: false, error: computed.error }
      }
      if (computed.newContent === '') {
        return { success: false, error: 'Refusing to create an empty file.' }
      }
      const agentCtxCreate = getAgentContext()
      return await withExclusiveFileLock(
        resolvedPath,
        agentCtxCreate?.agentId,
        agentCtxCreate?.sessionAgentType,
        async () => {
          // Symmetric race protection: the pre-lock branch saw a missing file,
          // but another writer may have materialised one by the time we got the
          // lock. Refuse to clobber their bytes — force the agent to Read and
          // re-issue the edit against the observed contents.
          try {
            const st = fs.statSync(resolvedPath)
            if (st.isFile() && st.size > 0) {
              return {
                success: false,
                error:
                  `Refusing to create "${filePath}" via edit_file: the file was concurrently ` +
                  `created with ${st.size} bytes before the lock was acquired. Read it first and ` +
                  `re-issue the edit against the observed contents.`,
              }
            }
          } catch {
            /* still absent — proceed to create as originally intended */
          }
          const dir = path.dirname(resolvedPath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }

          // Create branch — no pre-image to back up (file genuinely
          // doesn't exist), but tracking still records the "absent
          // baseline" so re-edits this session don't try to back up the
          // file we just authored.
          await fileHistoryTrackEdit(resolvedPath)

          // Atomic temp-+-rename write. `expectedContentHash: null`
          // signals brand-new file → atomicWriter skips the pre-write
          // hash check. Symlink resolution + permission preservation
          // (defaults via umask for new files) happen inside.
          //
          // New file → utf-8 (default). The create branch has no prior
          // bytes to detect a UTF-16LE BOM from, so we always create as
          // utf-8 here. Existing-file edits (update branch below) DO
          // round-trip the file's detected encoding.
          const createRes = atomicWriteFile(resolvedPath, {
            expectedContentHash: null,
            newContent: computed.newContent,
          })
          if (!createRes.ok) {
            return {
              success: false,
              error: `${createRes.code}: ${createRes.message}`,
            }
          }

          // Defence-in-depth post-write verify (atomicWriter already
          // checked; this is a second read through the workspace-aware
          // guard for destructive-clear / encoding sanity).
          const postCheckCreate = verifyPostWriteIntegrity({
            resolvedPath,
            displayPath: filePath,
            expectedContent: computed.newContent,
            intent: 'edit',
          })
          if (!postCheckCreate.ok) {
            return { success: false, error: postCheckCreate.error }
          }

          notifyWorkspaceFileMutation(resolvedPath, 'add')
          recordDiskWriteForEdit(Buffer.byteLength(computed.newContent, 'utf8'))
          // Awaitable variant: pushes didChange + didSave to the LSP and
          // waits up to DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS for the next
          // publishDiagnostics so the trailer reflects the SERVER's
          // reaction to the bytes we just wrote — not whatever was in the
          // store from a prior turn. Failures are swallowed; the file is
          // already on disk.
          const lspSync = await awaitDiskWriteAndFreshDiagnostics(
            resolvedPath,
            computed.newContent,
          )
          const refreshedCreate = recordSelfMutationReadReceipt(resolvedPath, computed.newContent)
          const bytes = Buffer.byteLength(computed.newContent, 'utf8')
          // Surface the same next-edit guidance the edit-in-place branch gives,
          // so an immediate follow-up edit on the just-created file echoes the
          // fresh readId (no re-read) — or is told to re-read when the receipt
          // could not be recorded.
          const readIdTrailer = buildNextEditTrailer(refreshedCreate, 'edit_file')
          const trailer = buildLspDiagnosticsTrailer(resolvedPath, {
            lspApplicable: lspSync.lspApplicable,
            diagnosticsArrived: lspSync.diagnosticsArrived,
            timeoutMs: DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
          })
          return {
            success: true,
            output: `Created ${filePath} (${bytes} bytes on disk, UTF-8).${readIdTrailer}${trailer}`,
            diagnosticsAttached: true,
          }
        },
      )
    }

    // BOM-aware read (upstream parity, P1). For UTF-16LE files the
    // bytes-as-utf-8 view would be garbled, so the model's `oldString`
    // taken from a correct read_file would never match. The post-lock
    // re-read inside the critical region (below) is the authoritative
    // copy that drives the actual edit + atomicWriter encoding; this
    // pre-lock read exists purely to satisfy the read-before-write gate.
    let disk = ''
    try {
      disk = readFileSyncWithDetectedEncoding(resolvedPath).content
    } catch {
      disk = ''
    }
    const { body: oldBForGate } = stripUtf8Bom(oldString)
    const { body: nbForGate } = stripUtf8Bom(newString)
    const createIntentOnEmptyBody =
      oldBForGate.trim() === '' && nbForGate.trim() !== '' && disk === ''
    let effectiveBaseReadId = options?.baseReadId
    let reboundFromReadId: string | undefined

    // Plan B: when the caller supplies `baseReadId`, validate against the
    // hash-anchored receipt (stronger than mtime — detects tampering that
    // preserves mtime, and confirms the exact bytes the agent saw contain
    // `old_string`). Falls back to the legacy mtime/window gate otherwise so
    // older callers stay source-compatible.
    if (effectiveBaseReadId && !createIntentOnEmptyBody) {
      const idGate = assertReadBeforeEditByReadId(
        resolvedPath,
        effectiveBaseReadId,
        disk,
        oldString,
        newString,
        options?.replaceAll,
      )
      if (!idGate.ok) {
        // Audit fix (2026-07, P1): the previous behaviour softly fell back to
        // the legacy mtime gate on ANY readId failure. That laundered
        // HASH_MISMATCH / OLD_STRING_NOT_IN_READ / READ_ID_NOT_FOUND — the
        // exact signals the hash-anchored gate exists to catch (edits driven
        // by memory rather than verified disk bytes) — through a gate that
        // never checks `old_string` against what the agent actually saw.
        // Hard-reject instead: every gate error carries explicit recovery
        // guidance (the current valid readId, or "re-read this path").
        return { success: false, error: idGate.error }
      }
      effectiveBaseReadId = idGate.effectiveReadId
      reboundFromReadId = idGate.reboundFromReadId
    } else {
      const gate = createIntentOnEmptyBody
        ? ({ ok: true } as const)
        : assertReadBeforeWrite(resolvedPath, disk)
      if (!gate.ok) {
        return { success: false, error: gate.error }
      }
    }

    const agentCtxEdit = getAgentContext()
    return await withExclusiveFileLock(
      resolvedPath,
      agentCtxEdit?.agentId,
      agentCtxEdit?.sessionAgentType,
      async () => {
        // Post-lock re-read using the SAME encoding the pre-lock read
        // detected. Mixing utf-8 and utf-16le views across the two reads
        // would make the TOCTOU hash comparison surface as HASH_MISMATCH
        // even when the bytes are stable. The pre-lock `diskEncoding`
        // captured the disk's encoding; reuse it here.
        const detected = readFileSyncWithDetectedEncoding(resolvedPath)
        const content = detected.content
        const lockedEncoding = detected.encoding
        let strongReadAnchorPassed = false
        // TOCTOU re-validation (audit Bug A2): a concurrent writer can
        // mutate the file between the pre-lock read-receipt check above
        // and this post-lock re-read. When `baseReadId` is in play we have
        // a content hash anchor — re-run the gate on the authoritative
        // post-lock buffer so the edit either matches the exact bytes the
        // agent saw or fails with HASH_MISMATCH instead of silently
        // applying to new bytes.
        if (effectiveBaseReadId && !createIntentOnEmptyBody) {
          const lockedIdGate = assertReadBeforeEditByReadId(
            resolvedPath,
            effectiveBaseReadId,
            content,
            oldString,
            newString,
            options?.replaceAll,
            { allowExpiredReadIdRebind: false },
          )
          if (!lockedIdGate.ok) {
            // Audit fix (2026-07, P1): symmetric with the pre-lock gate —
            // hard-reject instead of laundering the failure through the
            // weaker mtime gate. A post-lock failure here means a concurrent
            // writer changed the bytes between the pre-lock check and this
            // re-read (TOCTOU); applying the edit anyway is exactly the
            // corruption this anchor exists to prevent.
            return { success: false, error: lockedIdGate.error }
          }
          strongReadAnchorPassed = true
        }

        const ne = normalizeOneFileEdit(resolvedPath, content, oldString, newString, options?.replaceAll)
        const unanchoredResult = computeFileEditResult(content, ne.oldString, ne.newString, { replaceAll: ne.replaceAll })
        const anchoredResult =
          options?.hashAnchor && ne.replaceAll !== true
            ? computeHashAnchoredEditResult(content, ne.oldString, ne.newString, options?.hashAnchor)
            : null
        const result = anchoredResult ?? unanchoredResult
        if (!result.success) {
          return { success: false, error: result.error }
        }

        // P0 — `expectedLineRange` cross-boundary guard. Runs INSIDE the
        // exclusive lock against the post-lock disk buffer so the line
        // numbers we report match exactly what {@link computeFileEditResult}
        // is about to mutate. Skips silently when the model didn't declare
        // a range (full backward compatibility).
        if (options?.expectedLineRange) {
          const violation = computeExpectedLineRangeViolation(
            content,
            oldString,
            newString,
            {
              replaceAll: options?.replaceAll === true,
              expectedLineRange: options.expectedLineRange,
            },
          )
          if (!violation.ok) {
            const canIgnoreStaleRange = canTreatExpectedLineRangeAsStale(
              violation,
              options.expectedLineRange,
              {
                replaceAll: options?.replaceAll,
                strongReadAnchorPassed,
              },
            )
            const canIgnoreNormalizedRange =
              violation.code === 'NORMALIZED_HIT_INCOMPATIBLE' &&
              options?.replaceAll !== true &&
              strongReadAnchorPassed
            if (!canIgnoreStaleRange && !canIgnoreNormalizedRange) {
              // upstream alignment Part 3: upstream has no expectedLineRange
              // concept. A range violation must not block an otherwise valid
              // exact-byte edit (the `result.newContent` has already been
              // computed and represents the intended mutation). Soft-warn so
              // the operator sees the range mismatch in logs, but proceed
              // with the edit — semantically equivalent to upstream behaviour.
              console.warn(`[edit_file] expectedLineRange violation; continuing with edit. Original: ${violation.message}`)
            }
          }
        }

        // Single source of truth for the destructive-clear decision. See
        // writeIntegrityGuard.ts — it covers both the strict `=== ''` case
        // and the post-BOM-strip empty-body case that used to slip through.
        const preCheck = assertPreWriteIntegrity({
          resolvedPath,
          displayPath: filePath,
          previousContent: content,
          nextContent: result.newContent,
          fileExisted: true,
          intent: 'edit',
        })
        if (!preCheck.ok) {
          return { success: false, error: preCheck.error }
        }

        if (result.newContent === content) {
          const readIdRebindNotice = buildReadIdRebindNotice(
            reboundFromReadId,
            effectiveBaseReadId,
            false,
          )
          return {
            success: true,
            output: `No changes to write (file already matches): ${filePath}${readIdRebindNotice}`,
          }
        }

        // Snapshot pre-edit bytes BEFORE the destructive write. Awaited
        // so the backup is durable before we touch disk; failures here
        // are non-fatal (the main write still proceeds) so a clobbered
        // file-history dir never blocks a legitimate edit.
        await fileHistoryTrackEdit(resolvedPath)

        // Atomic temp-+-rename write. `content` is the bytes the inner
        // lock body just re-read from disk, so it's the authoritative
        // pre-image; passing its hash as `expectedContentHash` means
        // atomicWriter refuses if anything (incl. an out-of-lock
        // mutator) modified the file between the inner read and now.
        //
        // `lockedEncoding` carries the BOM-detected encoding (utf-8 or
        // utf16le) from the post-lock re-read so the temp write,
        // pre-write hash, and post-write verify all round-trip in the
        // file's original encoding — preventing the silent utf-16le →
        // utf-8 migration upstream specifically guards against.
        const writeRes = atomicWriteFile(resolvedPath, {
          expectedContentHash: hashFileContent(content),
          newContent: result.newContent,
          encoding: lockedEncoding,
        })
        if (!writeRes.ok) {
          return {
            success: false,
            error: `${writeRes.code}: ${writeRes.message}`,
          }
        }

        const postCheck = verifyPostWriteIntegrity({
          resolvedPath,
          displayPath: filePath,
          expectedContent: result.newContent,
          intent: 'edit',
          // Round-trip the detected encoding — a UTF-16LE file re-read as
          // UTF-8 would spuriously fail this verify on every write.
          encoding: lockedEncoding,
        })
        if (!postCheck.ok) {
          return { success: false, error: postCheck.error }
        }

        notifyWorkspaceFileMutation(resolvedPath, 'change')
        const lspSync = await awaitDiskWriteAndFreshDiagnostics(
          resolvedPath,
          result.newContent,
        )
        const refreshed = recordSelfMutationReadReceipt(resolvedPath, result.newContent)
        const bytes = Buffer.byteLength(result.newContent, 'utf8')
        recordDiskWriteForEdit(bytes)
        // Lead with a newline + the literal `readId for next edit: <id>` label
        // (which is also what the regex matchers in tools.hashAnchoredEdit.test
        // and downstream consumers grep for). The prior format inlined the id
        // mid-sentence at the end, which was easy for a fast-skimming model to
        // miss — so on chained edits the agent often re-echoed the now-stale
        // read_file id and got "baseReadId is unknown or expired". Keeping the
        // line break + REQUIRED tag fixes that without breaking parsers.
        // When the self-mutation receipt could NOT be refreshed (file vanished
        // right after the write), the trailer instead tells the agent the next
        // edit requires a fresh read_file — see buildNextEditTrailer.
        const readIdTrailer = buildNextEditTrailer(refreshed, 'edit_file')
        const changeSummaryTrailer = buildChangeSummaryTrailer(content, result.newContent)
        const lspTrailer = buildLspDiagnosticsTrailer(resolvedPath, {
          lspApplicable: lspSync.lspApplicable,
          diagnosticsArrived: lspSync.diagnosticsArrived,
          timeoutMs: DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
        })
        // Advisory warnings from the edit computation (replace_all boundary
        // collisions, placeholder-introduction). The edit HAS been applied —
        // these exist so the model can self-verify in the same turn.
        const editWarnings = (result as { warnings?: string[] }).warnings ?? []
        const warningsTrailer =
          editWarnings.length > 0
            ? `\n${editWarnings.map((w) => `WARNING: ${w}`).join('\n')}`
            : ''
        const readIdRebindNotice = buildReadIdRebindNotice(
          reboundFromReadId,
          effectiveBaseReadId,
          true,
        )
        return {
          success: true,
          output: `Edited ${filePath} (result ${bytes} bytes on disk, UTF-8).${warningsTrailer}${readIdRebindNotice}${readIdTrailer}${changeSummaryTrailer}${lspTrailer}`,
          diagnosticsAttached: true,
        }
      },
    )
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
