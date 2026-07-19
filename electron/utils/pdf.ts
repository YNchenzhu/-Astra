/**
 * PDF reading utilities for the read_file tool.
 *
 * Mode A: Small PDFs (<5 MB) — read as base64, send to model as document block.
 * Mode B: Large PDFs — use pdftoppm (poppler) to extract pages as JPEG images.
 */

import { readFile, mkdir, rm } from 'fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ToolResult } from '../ai/tools'

const execFileAsync = promisify(execFile)

const PDF_MAX_DIRECT_SIZE = 5 * 1024 * 1024 // 5 MB
const PDF_MAGIC = '%PDF-'

export function isPDFExtension(ext: string): boolean {
  return ext.toLowerCase() === 'pdf'
}

/**
 * Read a PDF file and return it as base64 for the API document block.
 */
export async function readPDF(filePath: string): Promise<ToolResult> {
  try {
    const buffer = await readFile(filePath)

    // Validate PDF header
    const header = buffer.toString('ascii', 0, 5)
    if (header !== PDF_MAGIC) {
      return { success: false, error: `Not a valid PDF file: ${filePath}` }
    }

    if (buffer.length > PDF_MAX_DIRECT_SIZE) {
      // Try page extraction for large PDFs
      const pageCount = await getPDFPageCount(filePath)
      if (pageCount !== null && pageCount > 0) {
        return {
          success: false,
          error: `PDF is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, ${pageCount} pages). ` +
            `Use offset/limit to read specific page ranges, or extract text with a bash command.`,
        }
      }
      return {
        success: false,
        error: `PDF is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max ${(PDF_MAX_DIRECT_SIZE / 1024 / 1024).toFixed(0)} MB for direct reading.`,
      }
    }

    const base64 = buffer.toString('base64')
    return {
      success: true,
      output: `[PDF: ${filePath} (${buffer.length} bytes, ${base64.length} base64)]`,
      contentBlocks: [{ type: 'pdf', base64, originalSize: buffer.length }],
    }
  } catch (error) {
    return { success: false, error: `Failed to read PDF: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Get PDF page count using pdfinfo (from poppler-utils).
 */
async function getPDFPageCount(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath], { timeout: 10000 })
    const match = stdout.match(/Pages:\s+(\d+)/)
    return match ? parseInt(match[1], 10) : null
  } catch {
    return null
  }
}

/**
 * Extract specific pages from a PDF as JPEG images using pdftoppm.
 * Returns image content blocks for each page.
 */
export async function extractPDFPages(
  filePath: string,
  firstPage: number,
  lastPage: number,
): Promise<ToolResult> {
  const outputDir = path.join(tmpdir(), `pdf-extract-${randomUUID()}`)

  try {
    await mkdir(outputDir, { recursive: true })

    await execFileAsync('pdftoppm', [
      '-jpeg', '-r', '150',
      '-f', String(firstPage),
      '-l', String(lastPage),
      filePath,
      path.join(outputDir, 'page'),
    ], { timeout: 60000 })

    // Collect generated JPEG files
    const { readdirSync } = await import('fs')
    const files = readdirSync(outputDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()

    if (files.length === 0) {
      return { success: false, error: 'pdftoppm produced no output. Is poppler-utils installed?' }
    }

    const contentBlocks: ToolResult['contentBlocks'] = []
    for (const file of files) {
      const buffer = await readFile(path.join(outputDir, file))
      contentBlocks.push({
        type: 'image',
        base64: buffer.toString('base64'),
        mediaType: 'image/jpeg',
      })
    }

    return {
      success: true,
      output: `[PDF pages ${firstPage}-${lastPage}: ${files.length} pages extracted as images]`,
      contentBlocks,
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, error: 'pdftoppm not found. Install poppler-utils for PDF page extraction.' }
    }
    return { success: false, error: `PDF extraction failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    try { await rm(outputDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
