/**
 * Write-file tool — write content to a file with integrity checks,
 * line-ending preservation, and structured diff output.
 */

import fs from 'node:fs'
import path from 'node:path'
import { notifyWorkspaceFileMutation } from '../fs/workspaceFileNotify'
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { atomicWriteFile } from '../diff/atomicWriter'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from './toolExecutionScope'
import { buildSimpleDiff, buildChangeSummaryTrailerFromHunks } from './changeSummary'
import {
  awaitDiskWriteAndFreshDiagnostics,
  DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
} from '../lsp/diskMutationSync'
import { buildLspDiagnosticsTrailer } from '../lsp/lspDiagnosticsTrailer'
import { getWorkspacePath, resolvePathForTool } from '../tools/workspaceState'
import { withExclusiveFileLock } from '../tools/fileLock'
import {
  assertReadBeforeWrite,
  findReadReceiptByReadId,
  hashFileContent,
  recordSelfMutationReadReceipt,
} from '../tools/readFileState'
import type { ToolResult } from '../tools/types'
// Line-ending and BOM helpers from '../utils/lineEndings' are intentionally
// NOT imported here: this tool now writes `content` verbatim (see the
// `toWrite = content` decision below). The helpers are still used by
// toolEditFile / toolMultiEditFile, where substring-replacement semantics
// require preserving the file's existing style.
//
// `detectBufferEncoding` IS imported because we still need to round-trip
// utf-16le files in their original encoding (Notepad-saved .reg, some
// legacy .ps1, etc.). For utf-8 (≈99% of repo content) it returns 'utf-8'
// unchanged so this is effectively a no-op fast path on the common case.
import { readFileSyncWithDetectedEncoding } from '../utils/lineEndings'
import { gateFileMutatePath } from '../tools/fileToolValidation'
import { getAgentContext } from '../agents/agentContext'
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
} from '../tools/writeIntegrityGuard'
import { preflightWriteToolWithDisk } from '../tools/writeToolPreflightGate'
import { buildToolFailure } from '../tools/toolErrorFormat'
import {
  buildFuzzyNotFoundError,
  findClosestName,
  findExistingParentDir,
  listDirEntries,
} from '../tools/fuzzyPathError'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Synchronously flush file data and metadata to disk.
 * On Windows NTFS, fs.writeFileSync returns before the filesystem fully
 * commits data and metadata (mtime), causing ripgrep (Grep tool) to see
 * stale metadata. Using fsyncSync ensures subsequent rg reads always
 * see fresh content and updated modification times.
 */
export function fsyncFileSync(absolutePath: string): void {
  const fd = fs.openSync(absolutePath, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Optional knobs for {@link toolWriteFile}. Added for the baseReadId
 * fallback (mirrors the `options.baseReadId` field on `toolEditFile` /
 * `toolMultiEditFile`); existing callers that pass only the first two
 * positional args are unaffected.
 */
export interface WriteFileOptions {
  /**
   * Path-recovery fallback. When `filePath` is empty / whitespace but
   * the model supplied a `baseReadId` from a recent `read_file`, the
   * tool walks `findReadReceiptByReadId(baseReadId)` to recover the
   * resolved path. Same pattern as `edit_file` / `multi_edit_file` —
   * see `toolMultiEditFile.ts` for the full rationale.
   *
   * Unknown or expired readIds produce a clear "re-read with read_file"
   * error rather than a generic "missing filePath" rejection.
   */
  baseReadId?: string
}

/**
 * Write content to a file. Creates parent directories if needed.
 * Serialized per resolved path with other Write/Edit/NotebookEdit on that path.
 */
export async function toolWriteFile(
  filePath: string,
  content: string,
  options?: WriteFileOptions,
): Promise<ToolResult> {
  try {
    // baseReadId fallback — see `toolMultiEditFile.ts` for the full
    // rationale. The loosened `writeFileInputZod` gate accepts payloads
    // that drop `filePath` but supply `baseReadId`; this is where the
    // recovery actually happens. If the readId can't be resolved, fall
    // through to the standard missing-filePath error with an explicit
    // mention so the model knows to re-read.
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
          what: 'write_file: `filePath` is missing or empty.',
          next:
            'Pass a file path (absolute or relative to the workspace root). ' +
            (options?.baseReadId
              ? 'You supplied a baseReadId but it could not be resolved — re-read the file with `read_file` and use the FRESH readId from that response.'
              : 'You can also supply `baseReadId` from a recent read_file response if filePath is hard to round-trip.'),
        }, 'validation'),
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
    // Refuse to overwrite a directory with a file — a common AI confusion
    // when `filePath` was meant to be a new filename under an existing dir.
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      return {
        success: false,
        ...buildToolFailure({
          what: `write_file: \`filePath\` is an existing directory, not a file: ${filePath}`,
          tried: [resolvedPath],
          next: 'Pass a filename inside that directory, or choose a different path.',
        }, 'validation'),
      }
    }
    const existed = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()

    // Parent-directory typo guard. Today the mkdir below silently creates
    // any missing parent tree — convenient for new modules, but catastrophic
    // for typos. If the model writes `src/comonents/Foo.tsx` (typo of
    // `components`), we'd materialise an orphaned `src/comonents/` dir
    // that the model would never find on its next read attempt.
    //
    // Heuristic: walk up to the deepest existing ancestor of the parent
    // dir. If the first missing segment has a Levenshtein-close sibling
    // there, refuse the write with a fuzzy not-found error pointing at
    // the likely correct sibling. When there's no close match, the new
    // tree looks intentional and we fall through to the recursive mkdir.
    //
    // Only fires when the file did NOT already exist on disk — overwriting
    // a file inside an existing dir is the common case and never triggers
    // this branch.
    if (!existed) {
      const dir = path.dirname(resolvedPath)
      if (!fs.existsSync(dir)) {
        const ancestor = findExistingParentDir(dir)
        if (ancestor) {
          const relFromAncestor = path
            .relative(ancestor, dir)
            .split(/[\\/]+/)
            .filter(Boolean)
          const firstMissingSegment = relFromAncestor[0]
          if (firstMissingSegment) {
            const siblings = listDirEntries(ancestor, 'dirs').map((e) =>
              e.endsWith('/') ? e.slice(0, -1) : e,
            )
            const closest = findClosestName(firstMissingSegment, siblings)
            if (closest && closest !== firstMissingSegment) {
              const ws = getWorkspacePath()
              const ancestorRel = ws
                ? path.relative(ws, ancestor).replace(/\\/g, '/') || '.'
                : ancestor
              return {
                success: false,
                ...buildFuzzyNotFoundError({
                  toolName: 'write_file',
                  kind: 'directory',
                  inputPath: filePath,
                  resolvedPath: dir,
                  workspace: ws ?? undefined,
                  extraNext: [
                    `Parent directory "${firstMissingSegment}" does not exist under "${ancestorRel}/", but a Levenshtein-close sibling "${closest}" does. This looks like a typo, not an intentional new directory tree.`,
                    'If you really meant to create a brand-new directory tree at this path, list_files the parent first to confirm the intended layout, then retry with the corrected path. write_file does NOT have a "force create" override — typos must be corrected.',
                  ],
                }),
              }
            }
          }
        }
      }
    }

    let originalContent: string | null = null
    if (existed) {
      let disk = ''
      try {
        disk = fs.readFileSync(resolvedPath, 'utf-8')
      } catch {
        disk = ''
      }
      originalContent = disk || null
      // Hard gate: write_file is ONLY for creating NEW files. ANY existing
      // file on disk — even a zero-byte empty file — must go through
      // edit_file so changes are expressed as precise old_string→new_string.
      //
      // Run this BEFORE assertReadBeforeWrite so the AI does not waste a
      // round-trip on Read just to learn it should have used edit_file
      // anyway. Routed through the shared writeToolPreflightGate so the
      // streaming executor's early-reject path and this defense-in-depth
      // check return byte-identical error wording.
      const diskPreflight = preflightWriteToolWithDisk({
        displayPath: filePath,
        diskContent: disk,
      })
      if (!diskPreflight.ok) {
        // Audit fix D1: spread the structured failure fields so the
        // renderer's `StructuredErrorView` can render the "use edit_file
        // instead" recovery hint as a real bulleted list. The flat
        // `error` string is preserved in the spread for legacy consumers.
        const { ok: _ok, resolvedPath: _rp, existingFileSize: _sz, ...failure } = diskPreflight
        return { success: false, ...failure }
      }
      // Defense-in-depth: even though preflight above rejects every
      // existing file today, keep the read-before-write check wired so
      // a future code path that bypasses preflight still can't clobber
      // unread bytes.
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
        // Re-validate staleness inside the lock to close TOCTOU window.
        // Another process or concurrent write may have modified the file
        // between the pre-lock check and now.
        //
        // CRITICAL: pass the current disk contents as the snapshot-compare
        // argument, mirroring the pre-lock call above. Without it, `mtime`
        // equality is the ONLY permissible verdict — and `mtimeMs` is not
        // stable across back-to-back fs.statSync calls on Windows NTFS
        // (100-ns filesystem time → IEEE-754 millisecond float → the
        // low-order bits flutter). The pre-lock check tolerates that
        // flutter because it falls back to "snapshot === disk" equality;
        // if we don't hand the in-lock check the same fallback it raises
        // a spurious "File has been modified on disk since it was read
        // (mtime changed)" on workflows that nothing actually modified,
        // such as creating a brand-new file via Write / Edit-with-empty-
        // old_string then re-writing it in the same session.
        if (existed) {
          let diskInLock = ''
          try {
            diskInLock = fs.readFileSync(resolvedPath, 'utf-8')
          } catch {
            diskInLock = ''
          }
          const reGate = assertReadBeforeWrite(resolvedPath, diskInLock)
          if (!reGate.ok) {
            return { success: false, error: reGate.error }
          }
        } else if (content === '') {
          // Inverted race: pre-lock the file didn't exist so we expected a new
          // empty-file creation, but by the time we acquired the lock a
          // concurrent writer materialised it with (potentially non-empty)
          // content. An unconditional empty write here would silently clobber
          // their bytes — require an explicit Read-first from the agent
          // (which re-runs this whole function with `existed = true` against
          // the disk state they observed).
          let appearedSize = 0
          try {
            const st = fs.statSync(resolvedPath)
            if (st.isFile()) appearedSize = st.size
          } catch {
            /* still absent — will be created below as an empty file (legit) */
          }
          if (appearedSize > 0) {
            return {
              success: false,
              error:
                `Refusing empty write: "${filePath}" did not exist when the write was scheduled, ` +
                `but another process or tool call created it with ${appearedSize} bytes before the ` +
                `lock was acquired. Read the file first, then decide whether to overwrite.`,
            }
          }
        }
        // Write is a FULL content replacement — the model authored the bytes,
        // including its choice of line endings and BOM. We write `content`
        // verbatim and do NOT (a) re-apply the existing file's CRLF/LF style
        // nor (b) re-prepend a UTF-8 BOM the model didn't include.
        //
        // History: previously we did both. The line-ending re-normalisation
        // silently corrupted bash scripts overwritten on Linux when the prior
        // version happened to be CRLF (`bad interpreter: /bin/sh^M`), and the
        // BOM re-prepend forced a magic UTF-8 BOM on every rewrite of files
        // that had one historically, even when the model deliberately produced
        // BOM-less output. This is the same lesson the upstream /
        // upstream FileWriteTool documents (`FileWriteTool.ts` L300-304):
        // "Write is a full content replacement — the model sent explicit line
        // endings in `content` and meant them. Do not rewrite them."
        //
        // Edit / MultiEdit are different: they perform substring replacement
        // and MUST keep the file's surrounding line ending style. That logic
        // lives in `computeFileEditResult` and is unaffected.
        //
        // ── Encoding detection ───────────────────────────────────────────
        // We DO preserve the file's existing encoding (utf-8 vs utf-16le).
        // Reading a UTF-16LE file as 'utf-8' returns garbage, and writing
        // it back as 'utf-8' silently migrates the encoding so Windows-
        // native tools (registry importer, older PowerShell hosts) can no
        // longer parse the file — that's a different class of silent
        // corruption from the line-ending one above, and the right fix is
        // round-tripping in the original encoding. upstream
        // `readFileSyncWithMetadata` + `writeTextContent(..., enc, 'LF')`
        // does exactly this.
        const toWrite = content
        let previous = ''
        let diskEncoding: BufferEncoding = 'utf-8'
        if (existed) {
          // Centralised BOM-aware read so this path and Edit / MultiEdit /
          // Notebook / IPC-save / LSP all share identical semantics.
          // Returns content with any leading BOM kept as `\uFEFF`; the
          // `hashFileContent` helper used below normalises that away so
          // a model-stripped-BOM rewrite isn't a false hash mismatch.
          const detected = readFileSyncWithDetectedEncoding(resolvedPath)
          previous = detected.content
          diskEncoding = detected.encoding
        }

        // Single source of truth for the destructive-clear decision —
        // `assertPreWriteIntegrity` runs the same rules every other writer in
        // the app uses (see electron/tools/writeIntegrityGuard.ts). Feed it
        // the *post-normalisation* `toWrite` so lone-BOM / lone-CRLF payloads
        // that collapse to an empty body can't slip past the strict `=== ''`
        // check the way they used to.
        const preCheck = assertPreWriteIntegrity({
          resolvedPath,
          displayPath: filePath,
          previousContent: previous,
          nextContent: toWrite,
          fileExisted: existed,
          intent: 'write',
        })
        if (!preCheck.ok) {
          return { success: false, error: preCheck.error }
        }

        if (existed && previous === toWrite) {
          return {
            success: true,
            output: `No changes to write (file already matches): ${filePath}`,
          }
        }

        const pathExisted = fs.existsSync(resolvedPath)
        const dir = path.dirname(resolvedPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        // Snapshot pre-edit content (upstream-style fileHistory). Awaited so
        // the destructive write below can rely on the backup being durable.
        // Failures are non-fatal: the main write still proceeds.
        await fileHistoryTrackEdit(resolvedPath)

        // Atomic temp-+-rename write via the shared atomicWriter.
        //
        // We pass `expectedContentHash` so the write refuses if disk
        // content drifted between our lock-protected read above and the
        // moment the temp file is renamed in — defense-in-depth on top of
        // the lock itself (catches the impossible-but-possible case where
        // a non-lock-aware process mutated the file mid-write).
        //
        // `encoding` is the BOM-detected encoding from above; for new
        // files it's the utf-8 default. atomicWriter uses it for write,
        // pre-write read, and post-write verify so the round-trip never
        // mixes encodings.
        //
        // For brand-new files (`!existed`) we pass `null` so atomicWriter
        // skips the pre-write hash check.
        const writeRes = atomicWriteFile(resolvedPath, {
          expectedContentHash: existed ? hashFileContent(previous) : null,
          newContent: toWrite,
          encoding: diskEncoding,
        })
        if (!writeRes.ok) {
          return {
            success: false,
            error: `${writeRes.code}: ${writeRes.message}`,
          }
        }

        // Defence-in-depth post-write verify. atomicWriter already
        // performed its own readback (HASH_MISMATCH_POST_WRITE); this is
        // a separate read through the workspace-aware integrity guard so
        // its own destructive-clear / encoding sanity checks still apply.
        const postCheck = verifyPostWriteIntegrity({
          resolvedPath,
          displayPath: filePath,
          expectedContent: toWrite,
          intent: 'write',
          // Round-trip the detected encoding (UTF-16LE parity with atomicWriter).
          encoding: diskEncoding,
        })
        if (!postCheck.ok) {
          return { success: false, error: postCheck.error }
        }

        notifyWorkspaceFileMutation(resolvedPath, pathExisted ? 'change' : 'add')
        // Audit §3.2 wire-up — record this write into both the global disk-rate
        // window (`ResourceQuotaManager.recordDiskWrite`) AND the per-tool
        // resource delta (`recordToolResourceDelta(toolUseId, { diskWriteBytes })`).
        // Before this, the `maxDiskWriteBytesPerSecond` quota stayed at 0 forever
        // because no caller fed the window; admission would never trip. The
        // per-tool delta lets snapshot consumers see "this tool wrote N bytes"
        // for telemetry / debugging without re-parsing tool outputs.
        try {
          const bytesWritten = Buffer.byteLength(toWrite, (diskEncoding as BufferEncoding) || 'utf-8')
          if (bytesWritten > 0) {
            getResourceQuotaManager().recordDiskWrite(bytesWritten)
            const toolUseIdForDelta = getToolUseIdFromStopScope()
            if (toolUseIdForDelta) {
              recordToolResourceDelta(toolUseIdForDelta, { diskWriteBytes: bytesWritten })
            }
          }
        } catch (e) {
          // Telemetry must never break the write completion path.
          console.warn('[toolWriteFile] quota.recordDiskWrite failed:', e)
        }
        const lspSync = await awaitDiskWriteAndFreshDiagnostics(resolvedPath, toWrite)
        // The agent just authored this content; refresh (not clear) the read
        // receipt so a follow-up Write/Edit by the same agent is not blocked
        // by a spurious "file has not been read" rejection.
        recordSelfMutationReadReceipt(resolvedPath, toWrite)

        // Build structured output like upstream's outputSchema
        const writeType = existed ? 'update' : 'create'
        const structuredPatch = originalContent !== null
          ? buildSimpleDiff(originalContent, toWrite)
          : []
        // Durable one-line "what changed" breadcrumb. Only meaningful when we
        // overwrote existing content (a fresh file's diff is the whole body).
        const changeSummaryTrailer = originalContent !== null
          ? buildChangeSummaryTrailerFromHunks(structuredPatch)
          : ''
        const lspTrailer = buildLspDiagnosticsTrailer(resolvedPath, {
          lspApplicable: lspSync.lspApplicable,
          diagnosticsArrived: lspSync.diagnosticsArrived,
          timeoutMs: DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
        })
        return {
          success: true,
          output: `Wrote ${toWrite.length} characters to ${filePath}${changeSummaryTrailer}${lspTrailer}`,
          writeType,
          originalFile: originalContent,
          structuredPatch,
          diagnosticsAttached: true,
        }
      },
    )
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}

// `buildSimpleDiff` moved to `./changeSummary` so the post-compact
// `<modified-files>` attachment can share it without an ai↔context import
// cycle. Re-exported here (from the local import above) for backward
// compatibility with existing callers.
export { buildSimpleDiff }
