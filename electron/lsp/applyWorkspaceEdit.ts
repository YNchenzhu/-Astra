/**
 * Apply an LSP {@link WorkspaceEdit} to the file system.
 *
 * LSP edits can take two shapes:
 *   - `changes`: `{ [uri]: TextEdit[] }` — the simple case we fully support.
 *   - `documentChanges`: a heterogeneous list of `TextDocumentEdit` +
 *     `{Create|Rename|Delete}File` operations — we fully support
 *     `TextDocumentEdit` and silently skip file-op entries with a warning
 *     (they're rare for typical "quick fix" payloads and require renderer
 *     coordination we defer to a later phase).
 *
 * Safety guarantees enforced here:
 *   - All target paths resolve inside the current trusted workspace.
 *   - Writes are atomic per file (temp write + rename) via
 *     {@link atomicWriteFile}; partial failures don't leave half-written files.
 *   - The `notifyWorkspaceFileMutation` helper fires after each successful
 *     write so the renderer file tree + Monaco tab reload pick up the change
 *     through the same mechanism used by `FileWriteTool` today.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'
import { writeFileAtomicUtf8 } from '../fs/atomicWrite'
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { atomicWriteFile } from '../diff/atomicWriter'
import { hashFileContent } from '../tools/readFileState'
import { detectBufferEncoding } from '../utils/lineEndings'
import { notifyWorkspaceFileMutation } from '../fs/workspaceFileNotify'
import { getWorkspacePath } from '../tools/workspaceState'

export interface ApplyWorkspaceEditResult {
  applied: boolean
  filesChanged: string[]
  /** Files created, renamed, or deleted — always absolute paths. */
  filesCreated: string[]
  filesRenamed: Array<{ from: string; to: string }>
  filesDeleted: string[]
  /** File ops we explicitly could not perform (outside workspace, IO error). */
  skippedFileOps: Array<{ kind: string; uri?: string; reason?: string }>
  /** Paths that failed to apply (unreachable URI, outside workspace, IO error). */
  failedPaths: Array<{ uri: string; reason: string }>
}

interface FileOperation {
  kind: 'create' | 'rename' | 'delete'
  uri?: string
  oldUri?: string
  newUri?: string
  options?: {
    overwrite?: boolean
    ignoreIfExists?: boolean
    ignoreIfNotExists?: boolean
    recursive?: boolean
  }
}

/** Convert an LSP URI into an absolute OS path, or null if unusable. */
function uriToPath(uri: string | undefined): string | null {
  if (typeof uri !== 'string' || !uri) return null
  try {
    if (uri.startsWith('file:')) return fileURLToPath(uri)
    return uri
  } catch {
    return null
  }
}

function isInsideWorkspace(absPath: string): boolean {
  const root = getWorkspacePath()
  if (!root) return false
  const normRoot = path.resolve(root)
  const normFile = path.resolve(absPath)
  if (normFile === normRoot) return true
  const sep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep
  return normFile.startsWith(sep)
}

/**
 * Convert a list of LSP TextEdits into the new file content.
 *
 * LSP TextEdits use (line, character) positions where `character` is the
 * offset in the line (utf-16 code units by default). Edits must be applied
 * in *reverse order* to keep earlier offsets valid — the LSP spec allows
 * overlapping edits but forbids them in practice; we detect overlaps and
 * reject the whole batch rather than produce a silently-wrong result.
 */
function applyTextEditsToContent(
  content: string,
  edits: TextEdit[],
): { content: string; ok: boolean; reason?: string } {
  if (!Array.isArray(edits) || edits.length === 0) return { content, ok: true }

  // Compute line-start offsets once.
  const lineStarts: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1) // '\n'
  }

  const offsetOf = (pos: Position): number => {
    const line = Math.max(0, Math.min(pos.line, lineStarts.length - 1))
    const lineStart = lineStarts[line]
    const nextLineStart =
      line + 1 < lineStarts.length ? lineStarts[line + 1] : content.length + 1
    const maxCol = nextLineStart - lineStart - 1 // strip the newline
    const col = Math.max(0, Math.min(pos.character, Math.max(0, maxCol)))
    return lineStart + col
  }

  // Sort edits end-to-start; detect overlaps.
  const resolved = edits
    .map((e) => ({ ...e, _start: offsetOf(e.range.start), _end: offsetOf(e.range.end) }))
    .sort((a, b) => b._start - a._start)

  for (let i = 0; i < resolved.length - 1; i++) {
    const cur = resolved[i]
    const next = resolved[i + 1]
    if (cur._start < next._end) {
      return {
        content,
        ok: false,
        reason: `Overlapping text edits at offsets ${next._end} / ${cur._start}`,
      }
    }
  }

  let out = content
  for (const edit of resolved) {
    out = out.slice(0, edit._start) + (edit.newText ?? '') + out.slice(edit._end)
  }
  return { content: out, ok: true }
}

/**
 * Flatten a WorkspaceEdit into per-URI edit batches. The LSP allows mixing
 * the two representations in a single edit in spec but in practice servers
 * pick one; we handle both regardless.
 */
/**
 * Split a WorkspaceEdit into text edits (per URI) + ordered file operations.
 * File ops preserve server-provided ordering because LSP's spec requires them
 * to be applied in sequence (e.g. create-before-edit for "Move to new file").
 */
function collectPerFileEdits(edit: WorkspaceEdit): {
  perUri: Map<string, TextEdit[]>
  fileOps: FileOperation[]
  skipped: Array<{ kind: string; uri?: string; reason?: string }>
} {
  const perUri = new Map<string, TextEdit[]>()
  const fileOps: FileOperation[] = []
  const skipped: Array<{ kind: string; uri?: string; reason?: string }> = []

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!edits || edits.length === 0) continue
      const existing = perUri.get(uri) ?? []
      existing.push(...edits)
      perUri.set(uri, existing)
    }
  }

  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if ('textDocument' in dc && 'edits' in dc) {
        // TextDocumentEdit
        const uri = dc.textDocument.uri
        const edits = dc.edits
        if (!uri || !edits || edits.length === 0) continue
        const existing = perUri.get(uri) ?? []
        existing.push(...(edits as TextEdit[]))
        perUri.set(uri, existing)
      } else if ('kind' in dc) {
        const op = dc as unknown as FileOperation
        if (op.kind === 'create' || op.kind === 'rename' || op.kind === 'delete') {
          fileOps.push({
            kind: op.kind,
            uri: op.uri,
            oldUri: op.oldUri,
            newUri: op.newUri,
            options: op.options,
          })
        } else {
          skipped.push({
            kind: (dc as { kind: string }).kind,
            reason: 'unknown operation kind',
          })
        }
      }
    }
  }

  return { perUri, fileOps, skipped }
}

async function executeFileOperation(
  op: FileOperation,
  result: ApplyWorkspaceEditResult,
): Promise<void> {
  const ensureInside = (uri?: string): string | null => {
    if (!uri) return null
    const abs = uriToPath(uri)
    if (!abs) return null
    const resolved = path.resolve(abs)
    return isInsideWorkspace(resolved) ? resolved : null
  }

  if (op.kind === 'create') {
    const target = ensureInside(op.uri)
    if (!target) {
      result.skippedFileOps.push({
        kind: 'create',
        uri: op.uri,
        reason: 'target outside trusted workspace',
      })
      return
    }
    // `ignoreIfExists` wins over `overwrite`; both default to false (= error).
    let exists = false
    try {
      await fs.access(target)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      if (op.options?.ignoreIfExists) return
      if (!op.options?.overwrite) {
        result.skippedFileOps.push({
          kind: 'create',
          uri: op.uri,
          reason: 'file exists and overwrite=false',
        })
        return
      }
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      writeFileAtomicUtf8(target, '')
      notifyWorkspaceFileMutation(target, 'add')
      result.filesCreated.push(target)
      result.applied = true
    } catch (err) {
      result.skippedFileOps.push({
        kind: 'create',
        uri: op.uri,
        reason: (err as Error).message,
      })
    }
    return
  }

  if (op.kind === 'rename') {
    const from = ensureInside(op.oldUri)
    const to = ensureInside(op.newUri)
    if (!from || !to) {
      result.skippedFileOps.push({
        kind: 'rename',
        uri: op.oldUri ?? op.newUri,
        reason: 'from/to outside trusted workspace',
      })
      return
    }
    let fromExists = false
    try {
      await fs.access(from)
      fromExists = true
    } catch {
      fromExists = false
    }
    if (!fromExists) {
      if (op.options?.ignoreIfNotExists) return
      result.skippedFileOps.push({
        kind: 'rename',
        uri: op.oldUri,
        reason: 'source does not exist',
      })
      return
    }
    let toExists = false
    try {
      await fs.access(to)
      toExists = true
    } catch {
      toExists = false
    }
    if (toExists && !op.options?.overwrite && !op.options?.ignoreIfExists) {
      result.skippedFileOps.push({
        kind: 'rename',
        uri: op.newUri,
        reason: 'target exists and overwrite=false',
      })
      return
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)
      notifyWorkspaceFileMutation(from, 'unlink')
      notifyWorkspaceFileMutation(to, 'add')
      result.filesRenamed.push({ from, to })
      result.applied = true
    } catch (err) {
      result.skippedFileOps.push({
        kind: 'rename',
        uri: `${op.oldUri} → ${op.newUri}`,
        reason: (err as Error).message,
      })
    }
    return
  }

  if (op.kind === 'delete') {
    const target = ensureInside(op.uri)
    if (!target) {
      result.skippedFileOps.push({
        kind: 'delete',
        uri: op.uri,
        reason: 'target outside trusted workspace',
      })
      return
    }
    let stats
    try {
      stats = await fs.stat(target)
    } catch {
      if (op.options?.ignoreIfNotExists) return
      result.skippedFileOps.push({
        kind: 'delete',
        uri: op.uri,
        reason: 'file does not exist',
      })
      return
    }
    try {
      if (stats.isDirectory()) {
        await fs.rm(target, { recursive: op.options?.recursive === true, force: false })
      } else {
        await fs.unlink(target)
      }
      notifyWorkspaceFileMutation(target, 'unlink')
      result.filesDeleted.push(target)
      result.applied = true
    } catch (err) {
      result.skippedFileOps.push({
        kind: 'delete',
        uri: op.uri,
        reason: (err as Error).message,
      })
    }
  }
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit | null | undefined,
): Promise<ApplyWorkspaceEditResult> {
  const result: ApplyWorkspaceEditResult = {
    applied: false,
    filesChanged: [],
    filesCreated: [],
    filesRenamed: [],
    filesDeleted: [],
    skippedFileOps: [],
    failedPaths: [],
  }
  if (!edit || typeof edit !== 'object') return result

  const { perUri, fileOps, skipped } = collectPerFileEdits(edit)
  result.skippedFileOps = [...skipped]

  // Execute file operations sequentially in server order. LSP requires this
  // ordering because "Move to new file" etc. depends on the create/rename
  // finishing before the subsequent text edit is applied to the new path.
  for (const op of fileOps) {
    await executeFileOperation(op, result)
  }

  if (perUri.size === 0) return result

  for (const [uri, edits] of perUri) {
    const absolute = uriToPath(uri)
    if (!absolute) {
      result.failedPaths.push({ uri, reason: 'unparseable URI' })
      continue
    }
    const resolved = path.resolve(absolute)
    if (!isInsideWorkspace(resolved)) {
      result.failedPaths.push({ uri, reason: 'path outside trusted workspace' })
      continue
    }

    // BOM-aware read so LSP quick-fixes on UTF-16LE files (rare but
    // possible on Windows for legacy .ps1 / .reg / .ini) round-trip in
    // the file's actual encoding instead of silently migrating to utf-8.
    let original: string
    let originalEncoding: BufferEncoding = 'utf-8'
    try {
      const raw = await fs.readFile(resolved)
      originalEncoding = detectBufferEncoding(raw)
      original = Buffer.from(raw).toString(originalEncoding)
    } catch (err) {
      result.failedPaths.push({
        uri,
        reason: `read failed: ${(err as Error).message}`,
      })
      continue
    }

    const applyRes = applyTextEditsToContent(original, edits)
    if (!applyRes.ok) {
      result.failedPaths.push({ uri, reason: applyRes.reason ?? 'edit application failed' })
      continue
    }
    if (applyRes.content === original) continue

    // Snapshot pre-edit bytes the same way the AI Edit tools do. LSP
    // workspace edits (quick fixes, refactors) are "automated edits the
    // user didn't author byte-for-byte", so they belong in the same
    // session-scoped recovery store as AI edits — letting the user revert
    // an unexpected refactor with the same UI surface.
    await fileHistoryTrackEdit(resolved)

    // Use the full atomicWriter (symlink resolution + permission preservation
    // + post-write byte verify) rather than the simpler `writeFileAtomicUtf8`.
    // Critical for LSP edits where the target may be a `0o755` script or a
    // symlinked shared config — those properties must survive a quick-fix.
    // `expectedContentHash` is the bytes we just read, so atomicWriter
    // refuses if a non-LSP-aware process mutated the file between our read
    // and our write.
    const writeRes = atomicWriteFile(resolved, {
      expectedContentHash: hashFileContent(original),
      newContent: applyRes.content,
      encoding: originalEncoding,
    })
    if (!writeRes.ok) {
      result.failedPaths.push({
        uri,
        reason: `write failed (${writeRes.code}): ${writeRes.message}`,
      })
      continue
    }

    try {
      notifyWorkspaceFileMutation(resolved, 'change')
    } catch {
      // Non-fatal: renderer will eventually notice via chokidar.
    }

    result.filesChanged.push(resolved)
    result.applied = true
  }

  return result
}

/** Re-exported for unit tests so we can verify edit application without IO. */
export const __internal = {
  applyTextEditsToContent,
  collectPerFileEdits,
}

/** Keep this symbol so TS doesn't drop the unused type import. */
export type _Range = Range
