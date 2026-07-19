/**
 * Batch / multi-edit tool — applies an ordered array of `{oldString, newString}`
 * edits to a single file in a single locked transaction, with a single
 * post-write readId rotation.
 *
 * The semantics are a 1:1 port of upstream's internal `getPatchForEdits`
 * (FileEditTool/utils.ts), which was the array-capable inner loop behind their
 * single-edit `Edit` tool but never surfaced as its own tool. Exposing it
 * directly avoids the readId-rotation tax on chained refactors: the agent
 * authors N edits, we apply them atomically against a single read of disk,
 * and we emit ONE fresh readId for the whole batch.
 *
 * Safety contract (mirrors {@link toolEditFile} where applicable, except for
 * per-edit anchoring which is fundamentally incompatible with multi-edit):
 *
 *   1.  All the prologue gates of {@link toolEditFile} run once for the
 *       file: gateFileMutatePath (DANGEROUS dirs/files, UNC, glob),
 *       .ipynb redirect, size cap, baseReadId hash-anchored gate (or the
 *       legacy mtime/window gate when no readId is provided).
 *   2.  Placeholder-ellipsis detection — upstream alignment stage 0 turned
 *       {@link detectPlaceholderEllipsis} into a no-op, so `...` / `…`
 *       inside `old_string` is now treated as literal text and only matches
 *       files that actually contain those characters at that position. The
 *       call site below still invokes the gate so a future re-enable can
 *       land without re-plumbing; today the call always falls through.
 *   3.  The actual content mutation goes through
 *       {@link computeFileEditResultMulti}, which carries the upstream
 *       invariants (appliedNewStrings substring guard, per-edit no-op
 *       refusal, final-batch no-op refusal).
 *   4.  The write itself is inside {@link withExclusiveFileLock} with
 *       TOCTOU re-validation against the post-lock disk buffer (same shape
 *       as toolEditFile), followed by {@link assertPreWriteIntegrity},
 *       fsynced single writeFileSync, and {@link verifyPostWriteIntegrity}.
 *   5.  On success: {@link recordSelfMutationReadReceipt} rotates the
 *       readId to a single fresh value for chained edits. The previous
 *       readId is invalidated.
 *
 * What we deliberately do NOT support:
 *
 *   - Per-edit `expectedLineRange` / `hashAnchor`. After edit #1 lands in
 *     memory, edit #2's line numbers and line hashes shift, so those
 *     anchors stop being meaningful. The file-level `baseReadId` hash is
 *     the single source of truth for "the bytes the agent saw still match
 *     disk".
 *   - Creating a brand-new file. multi-edit is for refactoring an existing
 *     file; for create use `write_file` or single `edit_file`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { notifyWorkspaceFileMutation } from '../fs/workspaceFileNotify'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from './toolExecutionScope'
import { buildChangeSummaryTrailer } from './changeSummary'
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
  computeFileEditResultMulti,
  type MultiEditOne,
  MAX_EDIT_FILE_BYTES,
  formatFileSize,
} from './fileEditSemantics'
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
} from '../tools/writeIntegrityGuard'
import { buildToolFailure } from '../tools/toolErrorFormat'
import { buildFuzzyNotFoundError } from '../tools/fuzzyPathError'
import { findSimilarFile } from './toolReadFile'
import {
  buildEllipsisError,
  detectPlaceholderEllipsis,
} from './fileEditPlaceholder'
import { findReadReceiptByReadId } from '../tools/readFileState'

/**
 * Recover the resolved file path from a baseReadId when the model
 * omitted `filePath` from the tool_use payload. Common failure mode:
 * on long multi-edit batches the model reasons "baseReadId already
 * uniquely identifies the file" and drops `filePath`, which the
 * loosened Zod gate now accepts. The receipt's `absPath` is the
 * OS-cased path that was passed to `resolvePathForTool` at read time,
 * so feeding it back round-trips cleanly on case-sensitive filesystems
 * (Linux) where the lowercased Map key would not resolve.
 *
 * Returns `undefined` when the readId can't be resolved — caller falls
 * through to the standard "filePath missing" error path.
 */
function recoverFilePathFromBaseReadId(baseReadId: string | undefined): string | undefined {
  if (!baseReadId || !baseReadId.trim()) return undefined
  const hit = findReadReceiptByReadId(baseReadId.trim())
  if (!hit) return undefined
  return hit.record.absPath ?? hit.resolvedPathKey
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Partial-view batch containment (audit fix 2026-07, P1): every edit's
 * `old_string` must be visible in the window the agent actually read. The
 * batch is simulated sequentially so an edit that targets text introduced
 * by an earlier edit's `new_string` still validates — mirroring how
 * {@link computeFileEditResultMulti} applies the batch to disk.
 *
 * 2026-07 drift-elimination: the simulation now runs through the REAL
 * per-edit applier (`computeFileEditResult`) instead of a raw
 * `String.includes` + `replace`, so every matching tier the batch applier
 * would accept on disk (quote/fullwidth drift, read-output artifacts,
 * whitespace-tolerant matching) is also accepted against the window. The
 * previous hand-rolled check was STRICTER than the applier and bounced
 * payloads that would have applied fine.
 */
function verifyAllEditsVisibleInSnapshot(
  snapshot: string,
  edits: ReadonlyArray<MultiEditOne>,
): { ok: true } | { ok: false; error: string } {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let sim = norm(snapshot)
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!
    if (norm(e.oldString) === '') continue // empty-old semantics are validated by the batch applier
    const r = computeFileEditResult(sim, e.oldString, e.newString, {
      replaceAll: e.replaceAll === true,
    })
    if (!r.success) {
      if (r.error.startsWith('The old_string was not found')) {
        return {
          ok: false,
          error:
            `Edit #${i + 1}: old_string does not appear in the content you read (partial-view baseReadId window). ` +
            `Call read_file on this path with NO offset/limit (full read), then retry the batch with the fresh readId.`,
        }
      }
      // Duplicate / ambiguity inside the window implies the same failure on
      // the full file (window ⊆ file) — surface the applier's own, more
      // actionable message instead of a misleading "not visible" one.
      return { ok: false, error: `Edit #${i + 1} (validated against your read window): ${r.error}` }
    }
    sim = r.newContent
  }
  return { ok: true }
}

// (was `fsyncFileSync` — removed when this file switched to atomicWriteFile,
// which performs its own fsync on the temp file before the atomic rename
// plus a best-effort parent-dir fsync afterwards on Windows. See
// {@link atomicWriteFile} in `electron/diff/atomicWriter.ts`.)

export interface MultiEditFileOptions {
  /** Optional readId from the last read_file / edit_file response for hash-anchored validation. */
  baseReadId?: string
}

/**
 * Apply an ordered batch of edits to a single file.
 *
 * @param filePath  Path to the file. Absolute or workspace-relative. A
 *                  directory or non-existent file is rejected (multi-edit
 *                  does NOT create files; use `write_file` or
 *                  `edit_file` for that).
 * @param edits     Ordered array of edits. Empty array is an error.
 * @param options   See {@link MultiEditFileOptions}.
 */
export async function toolMultiEditFile(
  filePath: string,
  edits: ReadonlyArray<MultiEditOne>,
  options?: MultiEditFileOptions,
): Promise<ToolResult> {
  try {
    // baseReadId fallback: when the model dropped `filePath` from its
    // tool_use payload but supplied a `baseReadId`, recover the path
    // from the read receipt. The Zod gate above (`multiEditFileInputZod`)
    // already lets this case through; this is where the recovery
    // actually happens. If the readId is unknown or expired, fall
    // through to the standard missing-filePath error so the model
    // gets a clear next-step message.
    let effectiveFilePath = filePath
    if ((typeof effectiveFilePath !== 'string' || !effectiveFilePath.trim()) && options?.baseReadId) {
      const recovered = recoverFilePathFromBaseReadId(options.baseReadId)
      if (recovered) effectiveFilePath = recovered
    }
    if (typeof effectiveFilePath !== 'string' || !effectiveFilePath.trim()) {
      return {
        success: false,
        ...buildToolFailure({
          what: 'multi_edit_file: `filePath` is missing or empty.',
          next:
            'Pass a file path (absolute or relative to the workspace root). ' +
            (options?.baseReadId
              ? 'You supplied a baseReadId but it could not be resolved — re-read the file with `read_file` and use the FRESH readId from that response.'
              : 'You can also supply `baseReadId` from a recent read_file response if filePath is hard to round-trip.'),
        }, 'validation'),
      }
    }
    filePath = effectiveFilePath
    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        success: false,
        ...buildToolFailure({
          what: 'multi_edit_file: `edits` is missing or empty.',
          next: 'Provide at least one edit, e.g. `{edits: [{oldString, newString}]}`. For batch refactors, prefer multi_edit_file over chained edit_file calls so the whole batch lands atomically.',
        }, 'validation'),
      }
    }

    // -----------------------------------------------------------------------
    // Per-edit placeholder-ellipsis gate. Runs BEFORE path resolution so a
    // model that submits a fully-placeholder batch gets the same canonical
    // error wording as edit_file, without us doing any disk I/O. We do NOT
    // attempt prefix/suffix auto-expand here because the disk content drifts
    // between edits within the batch — the suggestion would only be valid
    // for the first edit and misleading for the rest.
    // -----------------------------------------------------------------------
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!
      const { body: obEmpty } = stripUtf8Bom(edit.oldString)
      const detected = detectPlaceholderEllipsis(obEmpty)
      if (detected) {
        return {
          success: false,
          error: `Edit #${i + 1}: ${buildEllipsisError(detected, null)}`,
        }
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

    // -----------------------------------------------------------------------
    // multi_edit_file requires an existing file. We could in principle accept
    // a single `{oldString: '', newString: '<content>'}` to create-then-noop
    // (matching edit_file's create branch), but the multi-edit invariants
    // (substring guard, per-edit no-op refusal) are designed for refactoring
    // existing content. For create we want the agent to pick the obvious
    // tool — write_file or single edit_file — instead of a degenerate
    // 1-element multi_edit.
    // -----------------------------------------------------------------------
    if (!fs.existsSync(resolvedPath)) {
      // Rich fuzzy not-found instead of a bare "file not found" string.
      // Models commonly mis-type the leaf filename or the parent folder, and
      // multi_edit_file is unusually expensive to retry (the model has
      // already authored every edit in the batch); a single self-correctable
      // round-trip is worth the extra parent-dir + workspace-wide listing.
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
        'multi_edit_file refactors an EXISTING file. To create a new file use write_file ' +
          '(for new content) or edit_file with empty oldString (for create-via-edit).',
      )
      return {
        success: false,
        ...buildFuzzyNotFoundError({
          toolName: 'multi_edit_file',
          kind: 'file',
          inputPath: filePath,
          resolvedPath,
          workspace: ws ?? undefined,
          extraNext,
        }),
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
    if (resolvedPath.toLowerCase().endsWith('.ipynb')) {
      return {
        success: false,
        error:
          'This path is a Jupyter notebook (.ipynb). Use the NotebookEdit tool to edit notebook cells.',
      }
    }
    if (st.size > MAX_EDIT_FILE_BYTES) {
      return {
        success: false,
        error: `File is too large to edit (${formatFileSize(st.size)}). Maximum editable size is ${formatFileSize(MAX_EDIT_FILE_BYTES)}.`,
      }
    }

    // Pre-lock read for the baseReadId / mtime gate. Same pattern as
    // toolEditFile — the inner lock body re-reads from disk to defeat
    // TOCTOU races.
    //
    // BOM-aware (upstream parity, P1): UTF-16LE files are decoded with
    // their real encoding so model `oldString`s taken from a correct
    // read_file actually match. The in-lock re-read below is the
    // authoritative copy that drives the batch and the atomicWriter
    // encoding round-trip.
    let disk = ''
    try {
      disk = readFileSyncWithDetectedEncoding(resolvedPath).content
    } catch (e) {
      return { success: false, error: getErrorMessage(e) }
    }
    let effectiveBaseReadId = options?.baseReadId
    let reboundFromReadId: string | undefined

    // baseReadId branch — when the agent supplies one, validate against
    // the hash-anchored receipt. A well-formed expired id may be rebound to
    // the current receipt for this exact target path, but it still passes
    // the same disk-hash + visible-old_string checks below; every other
    // unknown id remains a hard failure. For multi-edit the containment check
    // would need to span ALL edits' oldStrings against the snapshot, so we
    // intentionally skip the per-edit `old_string` containment check at
    // this layer — the post-lock substring check inside
    // {@link computeFileEditResultMulti} catches the same class of bug.
    if (effectiveBaseReadId) {
      // We call assertReadBeforeEditByReadId with the FIRST edit's strings
      // so the receipt's content snapshot is verified to contain something
      // the agent actually intends to edit. This matches upstream's
      // behaviour where the first edit anchors the whole batch.
      const firstEdit = edits[0]!
      const idGate = assertReadBeforeEditByReadId(
        resolvedPath,
        effectiveBaseReadId,
        disk,
        firstEdit.oldString,
        firstEdit.newString,
        false,
      )
      if (!idGate.ok) {
        // Audit fix (2026-07, P1): hard-reject instead of laundering the
        // failure through the weaker mtime gate — see toolEditFile.ts.
        return { success: false, error: `Edit #1: ${idGate.error}` }
      }
      effectiveBaseReadId = idGate.effectiveReadId
      reboundFromReadId = idGate.reboundFromReadId
      // Audit fix (2026-07, P1): the idGate only anchors the FIRST edit.
      // For a PARTIAL-VIEW receipt, edits 2..n could target file regions
      // the agent never saw (the disk hash matches the full file, so
      // computeFileEditResultMulti would happily apply them). Verify every
      // edit's old_string against the snapshot window, simulating the
      // batch sequentially so edits that target text introduced by an
      // earlier edit's new_string still validate. Full-read receipts skip
      // this: hash match ⟹ disk == what the agent read, and the batch
      // applier validates each old_string against disk anyway (also
      // avoids false rejects from the 512 KB snapshot truncation cap).
      const receiptForWindowCheck = findReadReceiptByReadId(effectiveBaseReadId)
      if (
        receiptForWindowCheck?.record.isPartialView &&
        receiptForWindowCheck.record.contentSnapshot !== undefined
      ) {
        const windowCheck = verifyAllEditsVisibleInSnapshot(
          receiptForWindowCheck.record.contentSnapshot,
          edits,
        )
        if (!windowCheck.ok) {
          return { success: false, error: windowCheck.error }
        }
      }
    } else {
      const gate = assertReadBeforeWrite(resolvedPath, disk)
      if (!gate.ok) {
        return { success: false, error: gate.error }
      }
    }

    const agentCtx = getAgentContext()
    return await withExclusiveFileLock(
      resolvedPath,
      agentCtx?.agentId,
      agentCtx?.sessionAgentType,
      async () => {
        // Post-lock fresh read — the authoritative buffer the batch applies
        // against. Defeats TOCTOU between the pre-lock gate above and the
        // moment we actually mutate. BOM-aware: same encoding flows into
        // atomicWriter below so UTF-16LE files round-trip in their original
        // encoding instead of silently becoming UTF-8.
        const detected = readFileSyncWithDetectedEncoding(resolvedPath)
        const content = detected.content
        const lockedEncoding = detected.encoding

        // Post-lock TOCTOU re-validation. Mirrors toolEditFile.ts. We use
        // the FIRST edit's strings for the receipt containment check, same
        // as the pre-lock branch — keeping the two checks symmetric so a
        // race window between them is closed without changing semantics.
        if (effectiveBaseReadId) {
          const firstEdit = edits[0]!
          const lockedIdGate = assertReadBeforeEditByReadId(
            resolvedPath,
            effectiveBaseReadId,
            content,
            firstEdit.oldString,
            firstEdit.newString,
            false,
            { allowExpiredReadIdRebind: false },
          )
          if (!lockedIdGate.ok) {
            // Audit fix (2026-07, P1): symmetric hard reject (TOCTOU) —
            // see toolEditFile.ts.
            return { success: false, error: lockedIdGate.error }
          }
        }

        const batch = computeFileEditResultMulti(content, edits)
        if (!batch.success) {
          return { success: false, error: batch.error }
        }

        // Single source of truth for destructive-clear guarding. The
        // post-batch newContent must clear the same bar a single-edit
        // would; rules live in writeIntegrityGuard.ts.
        const preCheck = assertPreWriteIntegrity({
          resolvedPath,
          displayPath: filePath,
          previousContent: content,
          nextContent: batch.newContent,
          fileExisted: true,
          intent: 'edit',
        })
        if (!preCheck.ok) {
          return { success: false, error: preCheck.error }
        }

        // computeFileEditResultMulti already rejects whole-batch no-ops, so
        // this branch is defensive only — guarding the case where disk
        // changed under us between the post-lock read and now (which the
        // hash gate above should already have caught).
        if (batch.newContent === content) {
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

        // Snapshot pre-batch bytes BEFORE the destructive write. Awaited
        // so the backup is durable before any of the N edits land on
        // disk. Idempotent per (session, filePath), so repeated multi-
        // edits in the same session reuse the existing v1 backup —
        // exactly the recovery target we want ("rewind to first touch").
        await fileHistoryTrackEdit(resolvedPath)

        // Atomic temp-+-rename write. `content` is the lock-protected
        // post-TOCTOU disk buffer the batch was computed against, so
        // its hash is the authoritative pre-image for the pre-write
        // gate. Symlink resolution + permission preservation happen
        // inside atomicWriter. `lockedEncoding` carries the BOM-detected
        // encoding so UTF-16LE files round-trip in their own encoding.
        const writeRes = atomicWriteFile(resolvedPath, {
          expectedContentHash: hashFileContent(content),
          newContent: batch.newContent,
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
          expectedContent: batch.newContent,
          intent: 'edit',
          // Round-trip the detected encoding (UTF-16LE parity with atomicWriter).
          encoding: lockedEncoding,
        })
        if (!postCheck.ok) {
          return { success: false, error: postCheck.error }
        }

        notifyWorkspaceFileMutation(resolvedPath, 'change')
        const lspSync = await awaitDiskWriteAndFreshDiagnostics(
          resolvedPath,
          batch.newContent,
        )
        const refreshed = recordSelfMutationReadReceipt(resolvedPath, batch.newContent)
        const bytes = Buffer.byteLength(batch.newContent, 'utf8')
        // Audit §3.2 wire-up — feed the global disk-rate quota window and
        // the per-tool resource delta so quota.admit's
        // `maxDiskWriteBytesPerSecond` actually fires under heavy
        // multi-edit bursts; mirror of the hook in toolEditFile.ts.
        try {
          if (bytes > 0) {
            getResourceQuotaManager().recordDiskWrite(bytes)
            const toolUseIdForDelta = getToolUseIdFromStopScope()
            if (toolUseIdForDelta) {
              recordToolResourceDelta(toolUseIdForDelta, { diskWriteBytes: bytes })
            }
          }
        } catch (e) {
          console.warn('[toolMultiEditFile] quota.recordDiskWrite failed:', e)
        }
        // Same trailer format as toolEditFile.ts so chained tools agree on
        // how to parse the "use this id next" hint. CRITICAL: a model that
        // sees a different layout here would not learn to re-echo it. When the
        // receipt could not be refreshed, the trailer instead instructs a fresh
        // read_file before the next edit — see buildNextEditTrailer.
        const readIdTrailer = buildNextEditTrailer(refreshed, 'edit_file / multi_edit_file')
        const changeSummaryTrailer = buildChangeSummaryTrailer(content, batch.newContent)
        const lspTrailer = buildLspDiagnosticsTrailer(resolvedPath, {
          lspApplicable: lspSync.lspApplicable,
          diagnosticsArrived: lspSync.diagnosticsArrived,
          timeoutMs: DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
        })
        // Advisory per-edit warnings (already prefixed `Edit #N:` by
        // computeFileEditResultMulti). The batch HAS been applied.
        const warningsTrailer =
          batch.warnings && batch.warnings.length > 0
            ? `\n${batch.warnings.map((w) => `WARNING: ${w}`).join('\n')}`
            : ''
        const readIdRebindNotice = buildReadIdRebindNotice(
          reboundFromReadId,
          effectiveBaseReadId,
          true,
        )
        return {
          success: true,
          output: `Applied ${batch.appliedEdits} edit${batch.appliedEdits === 1 ? '' : 's'} to ${filePath} (result ${bytes} bytes on disk, UTF-8).${warningsTrailer}${readIdRebindNotice}${readIdTrailer}${changeSummaryTrailer}${lspTrailer}`,
          diagnosticsAttached: true,
        }
      },
    )
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
