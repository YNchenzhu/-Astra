/**
 * Read-file tool — read a single file with line numbers, image/PDF handling,
 * streamed windows for large files, and read-deduplication.
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
  open as openAsync,
  mkdir,
  rm,
} from 'fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { getWorkspacePath, resolvePathForTool } from '../tools/workspaceState'
import {
  buildFileUnchangedStub,
  recordSuccessfulRead,
  SMALL_FILE_FULL_READ_LINE_THRESHOLD,
  tryConsumeReadDedup,
} from '../tools/readFileState'
import type { ToolResult } from '../tools/types'
import { stripUtf8Bom } from '../utils/lineEndings'
import { decodeTextFileBuffer, fileStartsWithUtf16Bom } from '../utils/fileTextDecode'
import { IMAGE_SHARP_THRESHOLD_BYTES, IMAGE_SHARP_MAX_EDGE } from '../constants/apiLimits'
import { IMAGE_EXTENSIONS } from '../constants/files'
import { gateFileReadPath } from '../tools/fileToolValidation'
import { buildToolFailure } from '../tools/toolErrorFormat'
import { formatReadLineWithHash } from './fileEditSemantics'
import { IGNORE_DIRS } from './advancedToolUtils'
import { getAgentContext } from '../agents/agentContext'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ========== PDF helpers ==========

const execFileAsync = promisify(execFile)
const PDF_MAX_PAGES_PER_READ = 20
const PDF_AT_MENTION_INLINE_THRESHOLD = 5
const PDF_MAGIC = '%PDF-'

/** Parse a pages parameter like "1-5", "3", "10-20". */
function parsePDFPageRange(pagesStr: string): { firstPage: number; lastPage: number } | null {
  const trimmed = pagesStr.trim()
  if (!trimmed) return null
  if (trimmed.includes('-')) {
    const parts = trimmed.split('-').map(s => s.trim())
    if (parts.length !== 2) return null
    const first = parseInt(parts[0], 10)
    const last = parts[1] === '' ? Infinity : parseInt(parts[1], 10)
    if (isNaN(first) || first < 1) return null
    if (!isNaN(last) && last < first) return null
    return { firstPage: first, lastPage: isNaN(last) ? Infinity : last }
  }
  const page = parseInt(trimmed, 10)
  if (isNaN(page) || page < 1) return null
  return { firstPage: page, lastPage: page }
}

/** Get PDF page count using pdfinfo (from poppler-utils). */
async function getPDFPageCount(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath], { timeout: 10000 })
    const match = stdout.match(/Pages:\s+(\d+)/)
    return match ? parseInt(match[1], 10) : null
  } catch {
    return null
  }
}

/** Extract specific pages from a PDF as JPEG images using pdftoppm. */
async function extractPDFPagesAsImages(
  filePath: string,
  firstPage: number,
  lastPage: number,
): Promise<{ success: true; images: Array<{ base64: string; mediaType: string }> } | { success: false; error: string }> {
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

    const files = (await readdirAsync(outputDir)).filter(f => f.endsWith('.jpg')).sort()
    if (files.length === 0) {
      return { success: false, error: 'pdftoppm produced no output. Is poppler-utils installed?' }
    }

    const images: Array<{ base64: string; mediaType: string }> = []
    for (const file of files) {
      const buffer = await readFileAsync(path.join(outputDir, file))
      images.push({ base64: buffer.toString('base64'), mediaType: 'image/jpeg' })
    }
    return { success: true, images }
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (code === 'ENOENT') {
      return { success: false, error: 'pdftoppm not found. Install poppler-utils for PDF page extraction.' }
    }
    return { success: false, error: `PDF extraction failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    try { await rm(outputDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ========== Device path blocking ==========

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console',
  '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  if (filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') || filePath.endsWith('/fd/1') || filePath.endsWith('/fd/2'))) {
    return true
  }
  return false
}

/**
 * Skip VCS/build/cache dirs but DO descend into convention dot-dirs the
 * user actually puts source-of-truth files in: `.cursor/`, `.claude/`,
 * `.agents/`, `.github/`, etc. Without this, auto-discovery couldn't find
 * a `SKILL.md` the model guessed at the wrong skills root
 * (`.cursor/skills/...` vs `.claude/skills/...`) and the model got the
 * generic "no file matching … guess again" hint instead of the corrected
 * path. Reuses {@link IGNORE_DIRS} so the denylist stays in one place.
 */
function shouldSkipDirForSimilarSearch(name: string): boolean {
  return IGNORE_DIRS.has(name)
}

/** Simple similar-file finder: walks from baseDir up to maxDepth looking for a filename containing the query. */
/** Like {@link findSimilarFile} but returns ALL matches (up to 10). */
export function findAllSimilarFiles(baseName: string, baseDir: string, maxDepth: number = 6): string[] {
  const lowerQuery = baseName.toLowerCase()
  const results: string[] = []
  function walk(dir: string, depth: number) {
    if (results.length >= 10 || depth > maxDepth) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (results.length >= 10) break
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile()) {
        if (entry.name.toLowerCase().includes(lowerQuery) || lowerQuery.includes(entry.name.toLowerCase())) {
          results.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        if (shouldSkipDirForSimilarSearch(entry.name)) continue
        walk(fullPath, depth + 1)
      }
    }
  }
  walk(baseDir, 0)
  return results
}

export function findSimilarFile(baseName: string, baseDir: string, maxDepth: number = 8): string | null {
  const lowerQuery = baseName.toLowerCase()
  const results: string[] = []
  function walk(dir: string, depth: number) {
    if (results.length >= 5 || depth > maxDepth) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (results.length >= 5) break
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile()) {
        if (entry.name.toLowerCase().includes(lowerQuery) || lowerQuery.includes(entry.name.toLowerCase())) {
          results.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        if (shouldSkipDirForSimilarSearch(entry.name)) continue
        walk(fullPath, depth + 1)
      }
    }
  }
  walk(baseDir, 0)
  return results.length > 0 ? results[0] : null
}

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
const STREAM_READ_THRESHOLD = 1024 * 1024

function mimeForImageExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

async function maybeResizeRasterForTool(
  buf: Buffer,
  ext: string,
): Promise<{ buf: Buffer; mediaType: string; note?: string }> {
  if (buf.length <= IMAGE_SHARP_THRESHOLD_BYTES) {
    return { buf, mediaType: mimeForImageExt(ext) }
  }
  if (ext === '.gif') {
    return { buf, mediaType: mimeForImageExt(ext), note: 'GIF not resized; large file.' }
  }
  try {
    const sharpMod = await import('sharp')
    const sharp = sharpMod.default
    let pipeline = sharp(buf, { failOn: 'none' }).resize({
      width: IMAGE_SHARP_MAX_EDGE,
      height: IMAGE_SHARP_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    if (ext === '.png') {
      pipeline = pipeline.png({ compressionLevel: 9 })
    } else if (ext === '.webp') {
      pipeline = pipeline.webp({ quality: 82 })
    } else {
      pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true })
    }
    const out = await pipeline.toBuffer()
    const mediaType =
      ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return {
      buf: out,
      mediaType,
      note: `Resized from ${buf.length} bytes for context budget (max edge ${IMAGE_SHARP_MAX_EDGE}px).`,
    }
  } catch {
    return { buf, mediaType: mimeForImageExt(ext), note: 'sharp resize failed; sending original.' }
  }
}

function summarizeIpynbForRead(
  strippedUtf8: string,
  cellLineBudget: number,
):
  | { ok: true; summary: string; body: string; cellCount: number }
  | { ok: false; error: string } {
  let nb: { cells?: Array<{ cell_type?: string; source?: string | string[] }> }
  try {
    nb = JSON.parse(strippedUtf8) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> }
  } catch (e) {
    return { ok: false, error: `Invalid .ipynb JSON: ${(e as Error).message}` }
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : []
  const lines: string[] = [
    `Jupyter notebook (${cells.length} cells) — structured summary; on-disk JSON preserved for edit.`,
  ]
  let used = 1
  for (let i = 0; i < cells.length && used < cellLineBudget; i++) {
    const c = cells[i]
    const src = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '')
    const lineCount = src.split('\n').length
    const head = src.split('\n').slice(0, 6).join('\n').slice(0, 500)
    lines.push(`--- cell [${i}] ${c.cell_type ?? 'unknown'} (${lineCount} lines) ---`)
    lines.push(head + (src.length > head.length ? '\n…' : ''))
    used += 2 + head.split('\n').length
  }
  if (cells.length > 0 && lines.length < 3) {
    lines.push('(empty or minimal cells)')
  }
  return { ok: true, summary: lines.join('\n'), body: strippedUtf8, cellCount: cells.length }
}

/**
 * Lightweight top-level symbol outline for common source file types.
 */
function buildReadOutline(lines: string[], resolvedPath: string): string {
  const ext = path.extname(resolvedPath).toLowerCase()
  const MAX_ENTRIES = 12
  const entries: Array<{ line1: number; label: string }> = []

  const push = (line1: number, label: string) => {
    if (entries.length >= MAX_ENTRIES) return
    entries.push({ line1, label: label.length > 80 ? `${label.slice(0, 77)}…` : label })
  }

  const isJsLike = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)
  const isPyLike = ext === '.py'
  const isGoLike = ext === '.go'
  const isRustLike = ext === '.rs'
  const isRubyLike = ext === '.rb'
  const isJavaLike = ext === '.java' || ext === '.kt' || ext === '.kts'

  const jsRe =
    /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:async\s+)?(?:(?:function\*?|class|interface|type|enum|const|let|var)\s+)([A-Za-z_$][\w$]*)/
  const pyRe = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/
  const goRe = /^\s*(?:func(?:\s+\([^)]*\))?|type)\s+([A-Za-z_][\w]*)/
  const rustRe = /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w]*)/
  const rubyRe = /^\s*(?:def|class|module)\s+([A-Za-z_][\w:]*)/
  const javaRe = /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|open|override|\s)*\s*(?:class|interface|enum|object|record|fun)\s+([A-Za-z_][\w]*)/

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined) continue
    const line = raw
    if (line.length > 400) continue
    let m: RegExpMatchArray | null = null
    if (isJsLike) m = line.match(jsRe)
    else if (isPyLike) m = line.match(pyRe)
    else if (isGoLike) m = line.match(goRe)
    else if (isRustLike) m = line.match(rustRe)
    else if (isRubyLike) m = line.match(rubyRe)
    else if (isJavaLike) m = line.match(javaRe)
    if (m && m[1]) {
      push(i + 1, `${m[1]} — ${line.trim()}`)
      if (entries.length >= MAX_ENTRIES) break
    }
  }

  if (entries.length === 0) return ''
  const head =
    entries.length >= MAX_ENTRIES
      ? `Top ${MAX_ENTRIES}+ symbols`
      : `Top symbols`
  const body = entries.map((e) => `  L${e.line1}: ${e.label}`).join('\n')
  return `\n\n${head}:\n${body}`
}

async function readTextLineWindow(
  resolvedPath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number }> {
  const lines: string[] = []
  let lineIdx = 0
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(resolvedPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    rl.on('line', (line) => {
      const body = line.replace(/\r$/, '')
      if (lineIdx >= offset && lineIdx < offset + limit) {
        lines.push(body)
      }
      lineIdx++
    })
    rl.on('close', () => resolve())
    rl.on('error', (e) => reject(e))
  })
  return { lines, totalLines: lineIdx }
}

// ── Consecutive read_file failure gate (audit fix A-7: per-agent scope) ──
// When the model hallucinates paths, it tends to retry with small variations.
// After 2 failures in the same turn, block further reads and force discovery.
//
// Audit fix A-7 (2026-05): the counter used to be a single
// module-level integer, which meant a sibling sub-agent's failed
// reads (e.g. an Explore agent guessing paths in parallel) could
// trip "read_file BLOCKED: 3rd consecutive failed read" for the main
// agent — even though the main agent has zero failures of its own in
// its transcript. Counter is now keyed by the same conv+agent
// `scopeKey` that `readFileState.ts` uses for read receipts, so each
// agent / conversation independently tracks its own miss streak.
const failuresByScope = new Map<string, number>()

function readFailScopeKey(): string {
  const ctx = getAgentContext()
  const conv = ctx?.streamConversationId?.trim() || 'default'
  const agent = ctx?.agentId?.trim() || 'main'
  return `${conv}::${agent}`
}

function getFailures(): number {
  return failuresByScope.get(readFailScopeKey()) ?? 0
}

function bumpFailures(): number {
  const key = readFailScopeKey()
  const next = (failuresByScope.get(key) ?? 0) + 1
  failuresByScope.set(key, next)
  return next
}

function clearFailures(): void {
  failuresByScope.delete(readFailScopeKey())
}

/**
 * @deprecated Self-audit follow-up (2026-05) — `clearFailures()` resolves
 * its scope key from the active ALS context. This function is historically
 * called from `streamHandler.ts` BEFORE `runWithAgentContextAsync`
 * establishes the context, so the resolved key is the fallback
 * `'default::main'` — NOT the `'${conversationId}::main'` key that the
 * agentic loop will actually use. The result: this reset became a no-op
 * once A-7 split the single integer counter into a per-scope Map.
 *
 * Existing callers are migrated to {@link resetReadFailCountersForConversation}
 * which takes the conversation id explicitly. This export is preserved
 * because two test files (`tools.readFailGate.test.ts`,
 * `toolListFiles.test.ts`) call it from within their own ALS-mocked
 * context where the legacy semantic still works.
 */
export function resetReadFailCounter(): void {
  clearFailures()
}

/**
 * Self-audit follow-up (2026-05) — clear all per-agent fail counters
 * registered under `conversationId` (regardless of which sub-agent
 * scope key the entry lives under). Call this at the user-turn
 * boundary in `streamHandler` so a hallucinated-path streak from the
 * prior turn cannot carry over.
 */
export function resetReadFailCountersForConversation(conversationId: string): void {
  const conv = conversationId.trim() || 'default'
  const prefix = `${conv}::`
  for (const key of failuresByScope.keys()) {
    if (key.startsWith(prefix)) failuresByScope.delete(key)
  }
}

/** Call after a successful glob, list_files, or read_file to reset the counter. */
export function noteSuccessfulDiscovery(): void {
  clearFailures()
}

/**
 * Cross-tool path-guessing tracker. Incremented when `list_files` (or any other discovery
 * tool that opts in) hits a non-existent path. Returns the new count so the caller can
 * decide whether to escalate to a hard-block message.
 *
 * Shared with the read_file consecutive-failure counter on purpose:
 * AI guessing across `read_file` → `list_files` → `read_file` should
 * still trip the threshold; otherwise it can ping-pong between tools
 * and never get blocked. Scoped per-agent via {@link readFailScopeKey}.
 */
export function noteFailedDiscovery(): number {
  return bumpFailures()
}

/** For tests / fail-counter peeks. Read-only. */
export function getConsecutiveReadFailures(): number {
  return getFailures()
}

/** @internal — test seam: drop ALL per-scope counters. */
export function __resetAllReadFailCountersForTests(): void {
  failuresByScope.clear()
}

export async function toolReadFile(
  filePath: string,
  options?: { offset?: number; limit?: number; maxSizeBytes?: number; maxTokens?: number; pages?: string },
): Promise<ToolResult> {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return {
        success: false,
        ...buildToolFailure({
          what: 'read_file: `filePath` is missing or empty.',
          next: 'Pass a file path (absolute or relative to the workspace root).',
        }, 'validation'),
      }
    }
    const resolveResult = resolvePathForTool(filePath)
    if (!resolveResult.ok) {
      return { success: false, error: resolveResult.reason }
    }
    const resolvedPath = resolveResult.resolved
    const readGate = gateFileReadPath(filePath, resolvedPath)
    if (!readGate.ok) {
      return { success: false, error: readGate.error }
    }

    // Block device files that would hang (infinite output or blocking input)
    if (isBlockedDevicePath(resolvedPath)) {
      return {
        success: false,
        ...buildToolFailure({
          what: `read_file: cannot read device file '${filePath}' (would block or emit infinite output).`,
          next: 'Pass a regular file instead.',
        }, 'validation'),
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      const failureCount = bumpFailures()

      const ws = getWorkspacePath()
      const nextLines: string[] = []
      const basename = path.basename(resolvedPath)

      // ── Consecutive-failure gate: after 2+ failures this turn, block hard ──
      if (failureCount >= 2) {
        // Interpolate the actual missing basename into the glob hint —
        // a concrete `**/<filename>` lands far more reliably than a
        // generic placeholder. The test for this path explicitly checks
        // that the suggested pattern uses the failing filename.
        const concreteGlobHint = basename
          ? `Use glob with the filename pattern (e.g. glob pattern:"**/${basename}") to find the real path.`
          : 'Use glob with the filename pattern (e.g. glob pattern:"**/somefile.ext") to find the real path.'
        return {
          success: false,
          ...buildToolFailure({
            what: `read_file BLOCKED: ${filePath} does not exist — and this is the ${failureCount}th consecutive failed read. Do NOT retry with another guessed path.`,
            tried: [resolvedPath],
            context: { workspace: ws ?? '(none)' },
            next: [
              'You are guessing paths that do not exist. STOP guessing.',
              concreteGlobHint,
              'Or use list_files to explore the project structure first.',
              'Only call read_file again AFTER you have confirmed the path exists.',
            ],
          }, 'not_found'),
        }
      }

      // ── Auto-discovery: find the real file(s) so the model doesn't waste turns guessing ──
      let discoveredPaths: string[] = []
      if (basename && basename.length > 2 && ws) {
        try {
          // Walk from workspace root (broader and more likely to find the real file
          // than the guessed directory). Cap at a shallow depth for speed.
          discoveredPaths = findAllSimilarFiles(basename, ws, 6)
        } catch { /* ignore discovery errors */ }
      } else if (basename && basename.length > 2) {
        try {
          discoveredPaths = findAllSimilarFiles(basename, path.dirname(resolvedPath), 6)
        } catch { /* ignore */ }
      }

      if (discoveredPaths.length > 0) {
        const relativePaths = discoveredPaths
          .slice(0, 5)
          .map((p) => (ws ? path.relative(ws, p).replace(/\\/g, '/') : p))
        if (relativePaths.length === 1) {
          nextLines.push(`The file DOES exist at: "${relativePaths[0]}". Use that path instead.`)
        } else {
          nextLines.push(
            `Files matching "${basename}" found in workspace:` +
              relativePaths.map((p) => `\n    - ${p}`).join(''),
          )
        }
      } else {
        if (basename) {
          const guessedDir = ws
            ? path.relative(ws, path.dirname(resolvedPath)).replace(/\\/g, '/') || '.'
            : path.dirname(resolvedPath)
          nextLines.push(
            `No file matching "${basename}" found anywhere in the workspace. ` +
              `The directory "${guessedDir}" may not exist either. ` +
              `Use list_files to explore the actual project structure before guessing paths.`,
          )
        }
      }

      nextLines.push(
        ws
          ? 'Use a path relative to the workspace root, or an absolute path. Do NOT retry with another guessed path.'
          : 'No workspace is open; pass an absolute path.',
      )

      return {
        success: false,
        ...buildToolFailure({
          what: `read_file: file not found: ${filePath}`,
          tried: [resolvedPath],
          context: { workspace: ws ?? '(none)' },
          next: nextLines,
        }, 'not_found'),
      }
    }
    // Successful path — reset the fail counter so future reads aren't blocked
    clearFailures()

    const stat = await statAsync(resolvedPath)
    if (!stat.isFile()) {
      // Directory-instead-of-file is a frequent model mistake (~30% of reads in
      // exploration flows). Instead of bouncing the model to `list_files` (one
      // wasted turn), inline the directory listing right here so the next call
      // can target a concrete file. Error semantics stay unchanged — shape-lock
      // test + telemetry still see a `validation` failure mentioning list_files.
      let dirEntries: string[] = []
      try {
        const entries = await readdirAsync(resolvedPath, { withFileTypes: true })
        dirEntries = entries
          .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      } catch { /* unreadable dir — fall back to the plain pointer below */ }

      const MAX_INLINE_DIR_ENTRIES = 30
      const shown = dirEntries.slice(0, MAX_INLINE_DIR_ENTRIES)
      const omitted = dirEntries.length - shown.length
      const nextLines: string[] =
        shown.length > 0
          ? [
              'This directory\'s contents are inlined below — call read_file on one of these FILES directly. Do NOT call `list_files` on this same path (that would be redundant):',
              ...shown,
              ...(omitted > 0
                ? [`… and ${omitted} more entries (use \`list_files\` on this path only if none of the above match).`]
                : []),
            ]
          : ['The directory is empty (or unreadable). Use the `list_files` tool to inspect another directory, or pass a specific file path.']

      return {
        success: false,
        ...buildToolFailure({
          what: `read_file: \`filePath\` is a directory, not a file: ${filePath}`,
          tried: [resolvedPath],
          next: nextLines,
        }, 'validation'),
      }
    }
    const maxBytesCap =
      typeof options?.maxSizeBytes === 'number' && options.maxSizeBytes > 0
        ? Math.min(options.maxSizeBytes, MAX_TEXT_FILE_BYTES)
        : MAX_TEXT_FILE_BYTES
    if (stat.size > maxBytesCap) {
      const sizeMb = (stat.size / 1024 / 1024).toFixed(1)
      const capMb = (maxBytesCap / 1024 / 1024).toFixed(0)
      return {
        success: false,
        ...buildToolFailure({
          what: `read_file: file too large (${sizeMb} MB, cap ${capMb} MB): ${filePath}`,
          next: [
            `Pass \`offset\` + \`limit\` to read a window of this file.`,
            `If you need the whole file, raise \`maxSizeBytes\` (but context windows have a hard limit too).`,
          ],
        }, 'validation'),
      }
    }

    const offset = options?.offset ?? 0
    let limit = options?.limit ?? 2000
    if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
      limit = Math.min(limit, Math.max(1, Math.floor(options.maxTokens)))
    }
    const ext = path.extname(resolvedPath).toLowerCase()

    const dedupResult = tryConsumeReadDedup(resolvedPath, stat.mtimeMs, offset, limit)
    if (dedupResult.dedup) {
      if (dedupResult.repeatStop) {
        return {
          success: true,
          output:
            `[readId: ${dedupResult.readId ?? '?'}] — READ SKIPPED: this exact file/window has already been returned from cache ${dedupResult.strikeCount} times in this agent run.\n\n` +
            `Do NOT call read_file again for ${filePath} with offset=${offset}, limit=${limit}. Use the content already returned above and produce your findings/final report now.`,
        }
      }
      // When the AI has requested the same file 4+ times, deliver cached
      // content instead of a stub — this breaks the 3-dedups-then-real-read
      // cycle that causes 10+ repeated reads of the same file.
      if (dedupResult.cachedContent) {
        const lines = dedupResult.cachedContent.split('\n')
        const totalLines = lines.length
        const sourceReadOffset = dedupResult.sourceReadOffset ?? 0
        const relativeStart = Math.max(0, offset - sourceReadOffset)
        const shownLines = Math.min(limit, Math.max(0, totalLines - relativeStart))
        const displayed = lines.slice(relativeStart, relativeStart + shownLines)
        const output = displayed
          .map((line, idx) => formatReadLineWithHash(offset + idx + 1, line))
          .join('\n')
        const sourceTag = dedupResult.crossAgent
          ? ` (cached from sibling agent ${dedupResult.sourceAgentId ?? '?'} in this conversation — file unchanged on disk)`
          : ` (from cache — file unchanged)`
        const rangeNote = offset > 0 || shownLines < totalLines
          ? `showing lines ${offset + 1}-${offset + shownLines} of ${totalLines}${sourceTag}`
          : `showing full file: ${totalLines} lines${sourceTag}`
        const banner = dedupResult.crossAgent
          ? `[readId: ${dedupResult.readId ?? '?'}] — file already read by sibling agent ${dedupResult.sourceAgentId ?? '?'}; no disk re-read.\n`
          : (dedupResult.readId
              ? `[readId: ${dedupResult.readId}] — file unchanged since last read.\n`
              : '')
        return {
          success: true,
          output:
            banner +
            output +
            `\n\n(${rangeNote}${dedupResult.readId ? `; readId: ${dedupResult.readId}` : ''})`,
        }
      }
      const stubMsg = buildFileUnchangedStub(dedupResult.readId, dedupResult.contentPreview)
      return { success: true, output: stubMsg }
    }

    // --- PDF ---
    if (ext === '.pdf') {
      const buffer = await readFileAsync(resolvedPath)
      const header = buffer.toString('ascii', 0, 5)
      if (header !== PDF_MAGIC) {
        return { success: false, error: `Not a valid PDF file: ${filePath}` }
      }

      const pageCount = await getPDFPageCount(resolvedPath)
      const pagesParam = options?.pages

      if (pagesParam && pageCount !== null) {
        const parsed = parsePDFPageRange(pagesParam)
        if (!parsed) {
          return { success: false, error: `Invalid pages parameter: "${pagesParam}". Use formats like "1-5", "3", or "10-20".` }
        }
        const rangeSize = parsed.lastPage === Infinity ? PDF_MAX_PAGES_PER_READ + 1 : parsed.lastPage - parsed.firstPage + 1
        if (rangeSize > PDF_MAX_PAGES_PER_READ) {
          return { success: false, error: `Page range "${pagesParam}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request.` }
        }
        const firstP = Math.max(1, parsed.firstPage)
        const lastP = pageCount !== null ? Math.min(parsed.lastPage === Infinity ? pageCount : parsed.lastPage, pageCount) : (parsed.lastPage === Infinity ? firstP + PDF_MAX_PAGES_PER_READ - 1 : parsed.lastPage)
        const extractResult = await extractPDFPagesAsImages(resolvedPath, firstP, lastP)
        if (!extractResult.success) return { success: false, error: extractResult.error }

        recordSuccessfulRead(resolvedPath, {
          mtimeMs: stat.mtimeMs,
          isPartialView: true,
          readOffset: offset,
          readLimit: limit,
        })
        return {
          success: true,
          output: `[PDF] ${filePath} (${buffer.length} bytes, ${pageCount} pages) — ${extractResult.images.length} page(s) extracted as images.`,
          contentBlocks: extractResult.images.map(img => ({ type: 'image' as const, base64: img.base64, mediaType: img.mediaType })),
        }
      }

      if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
        return {
          success: false,
          error: `This PDF has ${pageCount} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request).`,
        }
      }

      // Small PDF: send as base64
      const base64 = buffer.toString('base64')
      recordSuccessfulRead(resolvedPath, {
        mtimeMs: stat.mtimeMs,
        isPartialView: false,
        readOffset: offset,
        readLimit: limit,
      })
      return {
        success: true,
        output: `[PDF] ${filePath} (${buffer.length} bytes, ${pageCount ?? '?'} pages)`,
        contentBlocks: [{ type: 'pdf', base64, originalSize: buffer.length }],
      }
    }

    if (ext === '.ipynb') {
      const rawFile = await readFileAsync(resolvedPath, 'utf-8')
      const { body } = stripUtf8Bom(rawFile)
      const ipynb = summarizeIpynbForRead(body, 220)
      if (!ipynb.ok) {
        return { success: false, error: ipynb.error }
      }
      recordSuccessfulRead(resolvedPath, {
        mtimeMs: stat.mtimeMs,
        isPartialView: false,
        fullFileContent: ipynb.body,
        readOffset: offset,
        readLimit: limit,
      })
      return { success: true, output: ipynb.summary }
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      const buf = await readFileAsync(resolvedPath)
      const { buf: outBuf, mediaType, note } = await maybeResizeRasterForTool(buf, ext)
      const b64 = outBuf.toString('base64')
      recordSuccessfulRead(resolvedPath, {
        mtimeMs: stat.mtimeMs,
        isPartialView: false,
        readOffset: offset,
        readLimit: limit,
      })
      return {
        success: true,
        output: `[Image] ${filePath} (${buf.length} bytes)${note ? ` — ${note}` : ''} — see content_blocks for base64.`,
        contentBlocks: [
          {
            type: 'image',
            base64: b64,
            mediaType,
            originalSize: buf.length,
          },
        ],
      }
    }

    let lines: string[]
    let totalLines: number
    let fullDecodedForRecord: string | undefined
    let effectiveOffset = offset
    let effectiveLimit = limit

    const head = Buffer.alloc(Math.min(4, stat.size))
    if (head.length > 0) {
      const fdHead = await openAsync(resolvedPath, 'r')
      try {
        await fdHead.read(head, 0, head.length, 0)
      } finally {
        await fdHead.close()
      }
    }

    const utf16 = fileStartsWithUtf16Bom(head)

    if (utf16) {
      const buf = await readFileAsync(resolvedPath)
      const body = decodeTextFileBuffer(buf)
      const split = body.split(/\r?\n/).map((line) => line.replace(/\r$/, ''))
      totalLines = split.length
      if (totalLines <= SMALL_FILE_FULL_READ_LINE_THRESHOLD) {
        effectiveOffset = 0
        effectiveLimit = totalLines
        lines = split
      } else {
        lines = split.slice(offset, offset + limit)
      }
      fullDecodedForRecord = body
    } else if (stat.size > STREAM_READ_THRESHOLD) {
      const w = await readTextLineWindow(resolvedPath, offset, limit)
      lines = w.lines
      totalLines = w.totalLines
    } else {
      const buf = await readFileAsync(resolvedPath)
      const body = decodeTextFileBuffer(buf)
      const split = body.split(/\r?\n/).map((line) => line.replace(/\r$/, ''))
      totalLines = split.length
      if (totalLines <= SMALL_FILE_FULL_READ_LINE_THRESHOLD) {
        effectiveOffset = 0
        effectiveLimit = totalLines
        lines = split
      } else {
        lines = split.slice(offset, offset + limit)
      }
      fullDecodedForRecord = body
    }

    const output = lines
      .map((line, idx) => formatReadLineWithHash(effectiveOffset + idx + 1, line))
      .join('\n')

    const isPartialView =
      effectiveOffset > 0 || effectiveOffset + effectiveLimit < totalLines
    const widened = effectiveOffset !== offset || effectiveLimit !== limit
    const lastShown = Math.min(effectiveOffset + lines.length, totalLines)

    const metaParts: string[] = []
    if (isPartialView) {
      metaParts.push(
        `showing lines ${effectiveOffset + 1}-${lastShown} of ${totalLines}`,
      )
    } else {
      metaParts.push(`showing full file: ${totalLines} lines`)
    }
    if (widened) {
      metaParts.push(
        `auto-widened from offset=${offset}, limit=${limit} (file is small, full body returned so you can pick old_string without guessing a line range)`,
      )
    }

    const fullFileContent =
      !isPartialView && fullDecodedForRecord !== undefined ? fullDecodedForRecord : undefined

    const { readId } = recordSuccessfulRead(resolvedPath, {
      mtimeMs: stat.mtimeMs,
      isPartialView,
      fullFileContent:
        fullFileContent !== undefined ? stripUtf8Bom(fullFileContent).body : undefined,
      viewedContent: isPartialView ? lines.join('\n') : undefined,
      readOffset: effectiveOffset,
      readLimit: effectiveLimit,
    })

    const outline = !isPartialView ? buildReadOutline(lines, resolvedPath) : ''

    const readIdBanner = `[readId: ${readId}] — REQUIRED: pass this exact readId as baseReadId when you edit this file.\n`
    const suffix =
      `\n\n(${metaParts.join('; ')}; readId: ${readId})` +
      outline

    return { success: true, output: readIdBanner + output + suffix }
  } catch (error) {
    // Audit fix A-5 (2026-05) — unexpected errors used to surface as a
    // bare errno string ("EACCES: permission denied, open ..."), which
    // the model would retry with the same args because there was no
    // `Next:` guidance. Wrap in the canonical structured-failure
    // envelope so the renderer + model see the same "What / Tried /
    // Context / Next" shape as every other tool failure.
    const msg = getErrorMessage(error)
    return {
      success: false,
      ...buildToolFailure({
        what: `read_file failed unexpectedly: ${msg}`,
        tried: [typeof filePath === 'string' && filePath ? filePath : '<unknown path>'],
        context: { errorClass: 'unknown_read_failure' },
        next: [
          'If the path exists and the error mentions permissions (EACCES / EPERM), verify the file is readable by this process.',
          'If the error mentions ENOENT, the file was deleted between discovery and read — re-run `glob` to confirm the current name.',
          'If the error is transient (EBUSY / EMFILE), retry once; if it persists, surface the raw message to the user rather than silently looping.',
        ],
      }),
    }
  }
}
