/**
 * NotebookEdit Tool — edit Jupyter Notebook (.ipynb) cells.
 *
 * Supports three modes: replace cell content, insert new cell, delete cell.
 * Requires reading the file first (read-before-edit safety).
 */

import fs from 'node:fs'
import { readFileSyncWithDetectedEncoding } from '../utils/lineEndings'
import path from 'node:path'
import { resolvePathForTool } from './workspaceState'
import { buildTool } from './buildTool'
import { withExclusiveFileLock } from './fileLock'
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { atomicWriteFile } from '../diff/atomicWriter'
import {
  awaitDiskWriteAndFreshDiagnostics,
  DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
} from '../lsp/diskMutationSync'
import { buildLspDiagnosticsTrailer } from '../lsp/lspDiagnosticsTrailer'
import {
  assertReadBeforeWrite,
  hashFileContent,
  recordSelfMutationReadReceipt,
} from './readFileState'
import { notebookEditInputZod } from './toolInputZod'
import { getAgentContext } from '../agents/agentContext'

export const notebookEditTool = buildTool({
  name: 'NotebookEdit',
  searchHint: 'edit jupyter ipynb notebook cell replace insert delete',
  zInputSchema: notebookEditInputZod,
  description:
    'Edit a Jupyter Notebook (.ipynb) file. Supports replacing cell content, inserting new cells, and deleting cells. ' +
    'The notebook_path must be an absolute path. cell_id is the ID of the cell to edit (for insert, specifies position). ' +
    'new_source is the new cell source code. edit_mode: "replace" (default), "insert", or "delete".',
  inputSchema: [
    { name: 'notebook_path', type: 'string', description: 'Absolute path to the .ipynb file', required: true },
    { name: 'cell_id', type: 'string', description: 'Cell ID to edit. For insert mode, specifies which cell to insert after.' },
    { name: 'new_source', type: 'string', description: 'New source content for the cell', required: true },
    { name: 'cell_type', type: 'string', description: 'Cell type: "code" or "markdown". Required for insert mode.', enum: ['code', 'markdown'] },
    { name: 'edit_mode', type: 'string', description: 'Edit mode: "replace" (default), "insert", or "delete"', enum: ['replace', 'insert', 'delete'] },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ notebook_path, cell_id, new_source, cell_type, edit_mode }) {
    const mode = edit_mode || 'replace'

    const resolveResult = resolvePathForTool(notebook_path)
    if (!resolveResult.ok) {
      return { success: false, error: resolveResult.reason }
    }
    const resolvedPath = resolveResult.resolved

    if (!resolvedPath.endsWith('.ipynb')) {
      return { success: false, error: 'File must be a .ipynb file' }
    }

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${resolvedPath}` }
    }

    let diskPreview = ''
    try {
      // BOM-aware (P1): notebooks ARE almost always utf-8 (Jupyter spec),
      // but some Windows tooling has saved them as utf-16le. Detect and
      // decode in the file's actual encoding so the read_before_write gate
      // compares the same byte semantics the lock-body uses.
      diskPreview = readFileSyncWithDetectedEncoding(resolvedPath).content
    } catch {
      diskPreview = ''
    }
    const gate = assertReadBeforeWrite(resolvedPath, diskPreview)
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    try {
      const agentCtx = getAgentContext()
      return await withExclusiveFileLock(resolvedPath, agentCtx?.agentId, agentCtx?.sessionAgentType, async () => {
        type NotebookCell = {
          id?: string
          cell_type?: string
          metadata?: Record<string, unknown>
          source?: string | string[]
          execution_count?: number | null
          outputs?: unknown[]
        }
        type NotebookDoc = { cells?: NotebookCell[] } & Record<string, unknown>

        // Post-lock authoritative read in the file's actual encoding —
        // captured here so the atomicWriter below writes back the same
        // encoding (no silent utf-16le → utf-8 migration).
        const detected = readFileSyncWithDetectedEncoding(resolvedPath)
        const raw = detected.content
        const lockedEncoding = detected.encoding
        const nb = JSON.parse(raw) as NotebookDoc

        if (!nb.cells || !Array.isArray(nb.cells)) {
          return { success: false, error: 'Invalid notebook: missing cells array' }
        }

        if (mode === 'delete') {
          if (!cell_id) {
            return { success: false, error: 'cell_id is required for delete mode' }
          }
          const idx = nb.cells.findIndex((c) => c.id === cell_id)
          if (idx === -1) {
            return { success: false, error: `Cell not found: ${cell_id}` }
          }
          nb.cells.splice(idx, 1)
        } else if (mode === 'insert') {
          if (!cell_type) {
            return { success: false, error: 'cell_type is required for insert mode' }
          }
          const newCell: Record<string, unknown> = {
            id: `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            cell_type,
            metadata: {},
            source: new_source || '',
          }
          if (cell_type === 'code') {
            newCell.execution_count = null
            newCell.outputs = []
          }
          if (cell_id) {
            const idx = nb.cells.findIndex((c) => c.id === cell_id)
            if (idx === -1) {
              return { success: false, error: `Cell not found: ${cell_id}` }
            }
            nb.cells.splice(idx + 1, 0, newCell as NotebookCell)
          } else {
            nb.cells.push(newCell as NotebookCell)
          }
        } else {
          if (!cell_id) {
            return { success: false, error: 'cell_id is required for replace mode' }
          }
          const cell = nb.cells.find((c) => c.id === cell_id)
          if (!cell) {
            return { success: false, error: `Cell not found: ${cell_id}` }
          }
          cell.source = new_source || ''
          if (cell.cell_type === 'code') {
            cell.execution_count = null
            cell.outputs = []
          }
        }

        const out = JSON.stringify(nb, null, 1)

        // Pre-write file-history backup. upstream-parity: notebook edits are
        // file mutations, so they MUST snapshot pre-edit bytes the same way
        // edit_file / write_file do. Awaited so the backup is durable before
        // the destructive write — failure is non-fatal (main write proceeds).
        await fileHistoryTrackEdit(resolvedPath)

        // Atomic temp-+-rename write via the shared atomicWriter. `raw` is
        // the lock-protected pre-image we computed `nb` from, so passing
        // its hash as `expectedContentHash` catches the impossible-but-
        // defensive case where a non-lock-aware process mutated the file
        // between the inner read and now. Also: symlink resolution (a
        // common pattern for shared notebook configs) + permission
        // preservation are wired automatically inside atomicWriter.
        const writeRes = atomicWriteFile(resolvedPath, {
          expectedContentHash: hashFileContent(raw),
          newContent: out,
          encoding: lockedEncoding,
        })
        if (!writeRes.ok) {
          return {
            success: false,
            error: `${writeRes.code}: ${writeRes.message}`,
          }
        }

        const lspSync = await awaitDiskWriteAndFreshDiagnostics(resolvedPath, out)
        recordSelfMutationReadReceipt(resolvedPath, out)

        const lspTrailer = buildLspDiagnosticsTrailer(resolvedPath, {
          lspApplicable: lspSync.lspApplicable,
          diagnosticsArrived: lspSync.diagnosticsArrived,
          timeoutMs: DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
        })
        return {
          success: true,
          output: `Successfully ${mode === 'delete' ? 'deleted' : mode === 'insert' ? 'inserted' : 'updated'} cell in ${path.basename(resolvedPath)}${lspTrailer}`,
          diagnosticsAttached: true,
        }
      })
    } catch (error) {
      return {
        success: false,
        error: `Failed to edit notebook: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})
