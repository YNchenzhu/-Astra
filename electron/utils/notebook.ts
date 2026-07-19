/**
 * Jupyter Notebook (.ipynb) reader for the read_file tool.
 *
 * Parses .ipynb JSON and extracts cells with their outputs.
 * No external dependencies — pure JSON parsing.
 */

import { readFile } from 'fs/promises'
import type { ToolResult } from '../ai/tools'

export function isNotebookExtension(ext: string): boolean {
  return ext.toLowerCase() === 'ipynb'
}

interface NotebookCell {
  cellType: string
  executionCount?: number
  source: string
  outputs: Array<{
    text?: string
    imageBase64?: string
    imageMediaType?: string
  }>
}

export async function readNotebook(filePath: string): Promise<ToolResult> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    // Minimal structural view over a Jupyter notebook document. Only the
    // fields we actually read are declared — unknown fields pass through
    // via the intersection with `Record<string, unknown>`.
    type NotebookOutput = {
      output_type?: string
      text?: string | string[]
      data?: Record<string, string | string[]>
      traceback?: string | string[]
      evalue?: string
      ename?: string
    }
    type NotebookCellRaw = {
      cell_type?: string
      execution_count?: number | null
      source?: string | string[]
      outputs?: NotebookOutput[]
    }
    type NotebookDoc = {
      cells?: NotebookCellRaw[]
      metadata?: {
        kernelspec?: { language?: string }
        language_info?: { name?: string }
      }
    }

    let nb: NotebookDoc

    try {
      nb = JSON.parse(raw) as NotebookDoc
    } catch {
      return { success: false, error: `Invalid JSON in notebook: ${filePath}` }
    }

    if (!nb.cells || !Array.isArray(nb.cells)) {
      return { success: false, error: `Invalid notebook format (missing cells): ${filePath}` }
    }

    const language = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python'
    const cells: NotebookCell[] = []

    for (const cell of nb.cells) {
      const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '')
      const cellType = cell.cell_type || 'code'
      const executionCount = cell.execution_count ?? undefined

      const outputs: NotebookCell['outputs'] = []

      if (Array.isArray(cell.outputs)) {
        for (const output of cell.outputs) {
          if (output.output_type === 'stream' && output.text) {
            const text = Array.isArray(output.text) ? output.text.join('') : output.text
            if (text.length <= 2000) {
              outputs.push({ text })
            } else {
              outputs.push({ text: text.slice(0, 2000) + `\n...(truncated, ${text.length} chars total)` })
            }
          } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
            const data = output.data || {}
            // Prefer text, then check for images
            if (data['text/plain']) {
              const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain']
              outputs.push({ text })
            }
            // Extract embedded images
            for (const mimeType of ['image/png', 'image/jpeg']) {
              if (data[mimeType]) {
                const b64 = Array.isArray(data[mimeType]) ? data[mimeType].join('') : data[mimeType]
                outputs.push({ imageBase64: b64.replace(/\s/g, ''), imageMediaType: mimeType })
              }
            }
          } else if (output.output_type === 'error') {
            const traceback = Array.isArray(output.traceback)
              // Matching ESC (U+001B) is the whole point here — stripping the
              // ANSI colour escape sequences that Jupyter tracebacks emit.
              // eslint-disable-next-line no-control-regex
              ? output.traceback.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
              : (output.evalue || output.ename || 'Unknown error')
            outputs.push({ text: `Error: ${traceback}` })
          }
        }
      }

      cells.push({ cellType, executionCount, source, outputs })
    }

    // Build text representation
    const parts: string[] = [`Notebook: ${filePath} (${cells.length} cells, language: ${language})\n`]
    const contentBlocks: ToolResult['contentBlocks'] = []

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      const countStr = cell.executionCount != null ? ` [${cell.executionCount}]` : ''
      parts.push(`--- Cell ${i + 1} (${cell.cellType}${countStr}) ---`)

      if (cell.cellType === 'code') {
        parts.push('```' + language)
        parts.push(cell.source)
        parts.push('```')
      } else {
        parts.push(cell.source)
      }

      for (const output of cell.outputs) {
        if (output.text) {
          parts.push(`Output: ${output.text}`)
        }
        if (output.imageBase64 && output.imageMediaType) {
          parts.push(`[Embedded image: ${output.imageMediaType}]`)
          contentBlocks.push({
            type: 'image',
            base64: output.imageBase64,
            mediaType: output.imageMediaType,
          })
        }
      }
      parts.push('')
    }

    return {
      success: true,
      output: parts.join('\n'),
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    }
  } catch (error) {
    return { success: false, error: `Failed to read notebook: ${error instanceof Error ? error.message : String(error)}` }
  }
}
