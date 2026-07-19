/**
 * Grep tool — search file contents with regex support and ripgrep fast-path.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { type ToolResult } from './tools'
import { resolveRipgrepBin } from '../utils/ripgrepBin'
import {
  RG_SPAWNSYNC_TIMEOUT_MS,
  resolveSearchPath,
  gateSessionMemoryInternalSearchDir,
  globToRegex,
  IGNORE_DIRS,
  formatLimitInfo,
  getIgnoreArgsForDir,
  splitGlobPatterns,
} from './advancedToolUtils'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Hard cap on stdout buffered from ripgrep. Matches the historical
 * spawnSync `maxBuffer` so behavior is identical for typical workloads.
 * When exceeded we kill the child and fall back to the JS path; this is
 * the same outcome spawnSync produced (it raised an error → fallback).
 */
const RG_MAX_STDOUT_BYTES = 12 * 1024 * 1024

interface RgRunResult {
  stdout: string
  status: number
  error?: Error
}

/**
 * Run ripgrep with non-blocking spawn + Promise. Replaces the historical
 * `spawnSync` calls so ripgrep no longer pins the main process event loop
 * for 5-30 s on a large monorepo. Output / status semantics match the
 * spawnSync branch exactly so the rest of `toolGrep` doesn't need to know.
 */
function runRipgrep(bin: string, args: string[], baseDir: string): Promise<RgRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, {
        cwd: baseDir,
        windowsHide: true,
      })
    } catch (err) {
      resolve({
        stdout: '',
        status: -1,
        error: err instanceof Error ? err : new Error(String(err)),
      })
      return
    }

    const chunks: Buffer[] = []
    let totalLen = 0
    let killed = false
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }, RG_SPAWNSYNC_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') timeout.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (killed) return
      totalLen += chunk.length
      if (totalLen > RG_MAX_STDOUT_BYTES) {
        killed = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })

    child.stderr?.resume() // drain stderr so the child doesn't stall on a full pipe
    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), status: -1, error: err })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || killed) {
        // Treat oversized / timed-out runs the same as spawnSync's previous
        // ENOBUFS/timeout: caller will fall back to the JS path.
        resolve({
          stdout: '',
          status: -1,
          error: new Error(killed ? 'rg stdout exceeded max buffer' : 'rg timed out'),
        })
        return
      }
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        status: code ?? -1,
      })
    })
  })
}

async function tryRipgrepGrepFilesWithMatches(
  pattern: string,
  baseDir: string,
  effectiveHeadLimit: number,
  caseInsensitive: boolean,
  include?: string,
  exclude?: string,
  multiline?: boolean,
  typeFilter?: string,
): Promise<ToolResult | null> {
  if (process.env.DISABLE_RG_GREP === '1') return null
  const bin = resolveRipgrepBin()
  const args: string[] = ['--hidden', '--no-ignore-vcs', '--files-with-matches', '--sortr=modified', '--no-messages', '--max-columns', '500']
  for (const dir of IGNORE_DIRS) args.push('--glob', `!${dir}`)
  args.push(...getIgnoreArgsForDir(baseDir))
  if (caseInsensitive) args.push('-i')
  if (multiline) args.push('-U', '--multiline-dotall')
  if (typeFilter) args.push('--type', typeFilter)
  const inc = typeof include === 'string' ? include.trim() : ''
  const exc = typeof exclude === 'string' ? exclude.trim() : ''
  if (inc) {
    for (const p of splitGlobPatterns(inc)) args.push('--glob', p)
  }
  if (exc) {
    for (const p of splitGlobPatterns(exc)) args.push('--glob', `!${p}`)
  }
  if (pattern.startsWith('-')) {
    args.push('-e', pattern)
  } else {
    args.push(pattern)
  }
  // Positional search path: ripgrep with NO path argument reads from stdin.
  // Under spawnSync the stdin pipe is closed immediately (EOF), so rg
  // returns status 1 with empty output regardless of disk content. This
  // silently broke `--files-with-matches` against `cwd: baseDir` (test
  // TC01/02/03/04/etc.). Pass `.` so rg searches the cwd we actually want.
  args.push('.')
  const r = await runRipgrep(bin, args, baseDir)
  if (r.error) return null
  const raw = r.stdout.trim()
  if (r.status !== 0 && r.status !== 1) return null
  if (!raw && r.status === 1) {
    return null
  }
  const outLines = raw ? raw.split(/\r?\n/).filter(Boolean) : []
  const rel = outLines.map((abs) => {
    const full = path.isAbsolute(abs) ? abs : path.join(baseDir, abs)
    return path.relative(baseDir, full).replace(/\\/g, '/')
  })
  const headCapped = Number.isFinite(effectiveHeadLimit)
  const capped = headCapped ? rel.slice(0, effectiveHeadLimit) : rel
  if (capped.length === 0) {
    return { success: true, output: `No matches for "${pattern}"` }
  }
  const truncated = headCapped && rel.length >= effectiveHeadLimit
  return {
    success: true,
    output: capped.join('\n') + (truncated ? `\n\n(truncated at ${effectiveHeadLimit} files)` : ''),
    numFiles: capped.length,
    truncated,
  }
}

async function tryRipgrepGrepCount(
  pattern: string,
  baseDir: string,
  effectiveHeadLimit: number,
  caseInsensitive: boolean,
  include?: string,
  exclude?: string,
  multiline?: boolean,
  typeFilter?: string,
): Promise<ToolResult | null> {
  if (process.env.DISABLE_RG_GREP === '1') return null
  const bin = resolveRipgrepBin()
  const args: string[] = ['--hidden', '--no-ignore-vcs', '--count-matches', '--no-messages', '--sortr=modified', '--max-columns', '500']
  for (const dir of IGNORE_DIRS) args.push('--glob', `!${dir}`)
  args.push(...getIgnoreArgsForDir(baseDir))
  if (caseInsensitive) args.push('-i')
  if (multiline) args.push('-U', '--multiline-dotall')
  if (typeFilter) args.push('--type', typeFilter)
  const inc = typeof include === 'string' ? include.trim() : ''
  const exc = typeof exclude === 'string' ? exclude.trim() : ''
  if (inc) {
    for (const p of splitGlobPatterns(inc)) args.push('--glob', p)
  }
  if (exc) {
    for (const p of splitGlobPatterns(exc)) args.push('--glob', `!${p}`)
  }
  if (pattern.startsWith('-')) {
    args.push('-e', pattern)
  } else {
    args.push(pattern)
  }
  // See note in tryRipgrepGrepFilesWithMatches — `.` forces rg to walk cwd
  // instead of waiting on stdin (test TC06).
  args.push('.')
  const r = await runRipgrep(bin, args, baseDir)
  if (r.error) return null
  const raw = r.stdout.trim()
  if (r.status !== 0 && r.status !== 1) return null
  if (!raw && r.status === 1) {
    return { success: true, output: `No matches for "${pattern}"` }
  }
  const lines = raw ? raw.split(/\r?\n/).filter(Boolean) : []
  const headCapped = Number.isFinite(effectiveHeadLimit)
  const capped = headCapped ? lines.slice(0, effectiveHeadLimit) : lines
  const truncated = headCapped && lines.length >= effectiveHeadLimit
  // Parity with the JS fallback path: aggregate total / per-file counts.
  // Without this `r.numMatches` and `r.numFiles` were undefined when the
  // ripgrep fast-path produced the result, breaking callers that branch on
  // the count (test TC06).
  let numMatches = 0
  for (const line of capped) {
    const colonIdx = line.lastIndexOf(':')
    if (colonIdx > 0) {
      const cnt = parseInt(line.substring(colonIdx + 1), 10)
      if (!Number.isNaN(cnt)) numMatches += cnt
    }
  }
  return {
    success: true,
    output: capped.join('\n') + (truncated ? `\n\n(truncated at ${effectiveHeadLimit} files with counts)` : ''),
    numMatches,
    numFiles: capped.length,
  }
}

async function tryRipgrepGrepContent(
  pattern: string,
  baseDir: string,
  effectiveHeadLimit: number,
  caseInsensitive: boolean,
  include: string | undefined,
  exclude: string | undefined,
  /** `-C` / `context` only — asymmetric `-B`/`-A` use separate args (upstream parity). */
  symmetricContext: number,
  beforeLines: number,
  afterLines: number,
  multiline?: boolean,
  typeFilter?: string,
): Promise<ToolResult | null> {
  if (process.env.DISABLE_RG_GREP === '1') return null
  const bin = resolveRipgrepBin()
  const args: string[] = ['--hidden', '--no-ignore-vcs', '--no-heading', '--no-messages', '--sortr=path', '--max-columns', '500']
  for (const dir of IGNORE_DIRS) args.push('--glob', `!${dir}`)
  args.push(...getIgnoreArgsForDir(baseDir))
  if (caseInsensitive) args.push('-i')
  if (multiline) args.push('-U', '--multiline-dotall')
  if (typeFilter) args.push('--type', typeFilter)
  if (symmetricContext > 0) {
    args.push('-C', String(symmetricContext))
  } else {
    if (beforeLines > 0) args.push('-B', String(beforeLines))
    if (afterLines > 0) args.push('-A', String(afterLines))
    if (beforeLines === 0 && afterLines === 0) {
      args.push('-n')
    }
  }
  const inc = typeof include === 'string' ? include.trim() : ''
  const exc = typeof exclude === 'string' ? exclude.trim() : ''
  if (inc) {
    for (const p of splitGlobPatterns(inc)) args.push('--glob', p)
  }
  if (exc) {
    for (const p of splitGlobPatterns(exc)) args.push('--glob', `!${p}`)
  }
  args.push('-e', pattern)
  // See note in tryRipgrepGrepFilesWithMatches — `.` forces rg to walk cwd
  // instead of waiting on stdin (tests TC02/TC05/TC18/TC19/TC20).
  args.push('.')
  const r = await runRipgrep(bin, args, baseDir)
  if (r.error) return null
  const raw = r.stdout
  if (r.status !== 0 && r.status !== 1) return null
  if (!raw.trim() && r.status === 1) {
    return { success: true, output: `No matches for "${pattern}"` }
  }
  const outLines = raw.split(/\r?\n/)
  const headCapped = Number.isFinite(effectiveHeadLimit)
  const kept = headCapped ? outLines.slice(0, effectiveHeadLimit) : outLines
  const truncated = headCapped && outLines.length > effectiveHeadLimit
  return { success: true, output: kept.join('\n').trim() + (truncated ? `\n\n(truncated at ${effectiveHeadLimit} lines)` : '') }
}

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

export async function toolGrep(
  pattern: string,
  cwd?: string,
  options?: {
    include?: string
    exclude?: string
    maxResults?: number
    context?: number
    beforeLines?: number
    afterLines?: number
    caseInsensitive?: boolean
    outputMode?: GrepOutputMode
    headLimit?: number
    offset?: number
    multiline?: boolean
    type?: string
    lineNumbers?: boolean
  }
): Promise<ToolResult> {
  try {
    const resolved = resolveSearchPath(cwd)
    if (!resolved.ok) return resolved.result
    const baseDir = resolved.baseDir
    const singleFileTarget = resolved.singleFileTarget
    const smGateGrep = gateSessionMemoryInternalSearchDir(baseDir, [
      options?.include,
      options?.exclude,
    ])
    if (smGateGrep) return smGateGrep

    const outputMode: GrepOutputMode = options?.outputMode ?? 'files_with_matches'
    const rawHead = options?.headLimit
    const effectiveHeadLimit =
      rawHead === 0
        ? Number.POSITIVE_INFINITY
        : rawHead !== undefined && rawHead !== null
          ? rawHead
          : options?.maxResults !== undefined && options.maxResults !== null
            ? options.maxResults
            : 250
    const skipOffset = options?.offset ?? 0
    const multiline = options?.multiline ?? false
    const typeFilter = options?.type

    /** `context` / `-C` — for files_with_matches & count, -B/-A must NOT disable ripgrep (upstream GrepTool semantics). */
    const symmetricContext = options?.context ?? 0
    const beforeOnly = options?.beforeLines ?? 0
    const afterOnly = options?.afterLines ?? 0
    const contextLines = Math.max(symmetricContext, beforeOnly, afterOnly)
    const flags = options?.caseInsensitive ? 'gi' : 'g'
    /**
     * Ripgrep uses the Rust regex engine; JavaScript `RegExp` differs. Compiling
     * here *before* calling rg falsely rejected valid rg patterns (e.g. some
     * Unicode property escapes without the `u` flag). Only compile when we need
     * the JS directory walk fallback.
     */
    let jsLineRegex: RegExp | undefined
    let jsLineRegexCompileFailed = false
    const getJsLineRegex = (): RegExp | null => {
      if (jsLineRegexCompileFailed) return null
      if (jsLineRegex) return jsLineRegex
      try {
        jsLineRegex = new RegExp(pattern, flags)
        return jsLineRegex
      } catch {
        jsLineRegexCompileFailed = true
        return null
      }
    }

    const includeRegex = options?.include ? globToRegex(options.include) : null
    const excludeRegex = options?.exclude ? globToRegex(options.exclude) : null

    const headCapped = Number.isFinite(effectiveHeadLimit)
    const atMatchCap = (n: number) => headCapped && n >= effectiveHeadLimit

    const MAX_FILES_TO_SCAN = 2000
    let filesScanned = 0

    function shouldStopScanning(): boolean {
      return filesScanned >= MAX_FILES_TO_SCAN
    }

    function readFileLines(filePath: string, relativePath: string): string[] | null {
      if (includeRegex && !includeRegex.test(relativePath)) return null
      if (excludeRegex && excludeRegex.test(relativePath)) return null
      if (shouldStopScanning()) return null

      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        return null
      }
      if (stat.size > 5 * 1024 * 1024) return null

      let content
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch {
        return null
      }
      filesScanned += 1
      return content.split('\n')
    }

    // ----- files_with_matches -----
    if (outputMode === 'files_with_matches') {
      if (symmetricContext === 0 && !singleFileTarget) {
        const rgOut = await tryRipgrepGrepFilesWithMatches(
          pattern,
          baseDir,
          effectiveHeadLimit,
          options?.caseInsensitive ?? false,
          options?.include,
          options?.exclude,
          multiline,
          typeFilter,
        )
        if (rgOut) return rgOut
      }

      const lineRxPre = getJsLineRegex()
      if (!lineRxPre) {
        return {
          success: false,
          error:
            `Invalid regex pattern for built-in search fallback: ${pattern.slice(0, 120)}${pattern.length > 120 ? '…' : ''}. ` +
            'The primary engine is ripgrep (Rust regex). This error appears when ripgrep could not be used and the pattern is not valid JavaScript `RegExp` syntax.',
        }
      }
      const lineRx: RegExp = lineRxPre

      const filePaths: string[] = []

      function searchFilePaths(filePath: string, relativePath: string) {
        if (atMatchCap(filePaths.length)) return
        const lines = readFileLines(filePath, relativePath)
        if (!lines) return

        for (let i = 0; i < lines.length; i++) {
          lineRx.lastIndex = 0
          if (lineRx.test(lines[i])) {
            filePaths.push(relativePath)
            return
          }
        }
      }

      function walkPaths(dir: string, depth: number) {
        if (atMatchCap(filePaths.length) || shouldStopScanning()) return
        if (depth > 20) return

        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }

        for (const entry of entries) {
          if (atMatchCap(filePaths.length) || shouldStopScanning()) break
          if (IGNORE_DIRS.has(entry.name)) continue
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue

          const fullPath = path.join(dir, entry.name)
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            walkPaths(fullPath, depth + 1)
          } else if (entry.isFile()) {
            searchFilePaths(fullPath, relativePath)
          }
        }
      }

      if (singleFileTarget) {
        const rel = path.relative(baseDir, singleFileTarget).replace(/\\/g, '/')
        searchFilePaths(singleFileTarget, rel)
      } else {
        walkPaths(baseDir, 0)
      }

      if (filePaths.length === 0) {
        return { success: true, output: `No matches for "${pattern}"` }
      }

      const stats = filePaths.map(fp => {
        try {
          return { path: fp, mtime: fs.statSync(path.join(baseDir, fp)).mtimeMs }
        } catch {
          return { path: fp, mtime: 0 }
        }
      })
      const sorted = stats
        .sort((a, b) => {
          const timeDiff = b.mtime - a.mtime
          return timeDiff === 0 ? a.path.localeCompare(b.path) : timeDiff
        })
        .map(s => s.path)

      const totalBeforeCap = sorted.length
      const wasTruncated = totalBeforeCap - skipOffset > effectiveHeadLimit
      const capped = sorted.slice(skipOffset, skipOffset + effectiveHeadLimit)
      const appliedLimit = wasTruncated ? effectiveHeadLimit : undefined
      const appliedOffset = skipOffset > 0 ? skipOffset : undefined
      const limitStr = formatLimitInfo(appliedLimit, appliedOffset)
      let note = ''
      if (wasTruncated) note = `\n\n[Showing results with pagination = ${limitStr}]`
      else if (shouldStopScanning()) note = '\n\n(stopped after scanning many files; narrow path or use include/exclude)'
      else if (limitStr) note = `\n\n[limit: ${limitStr}]`
      return { success: true, output: capped.join('\n') + note, numFiles: capped.length }
    }

    // ----- count -----
    if (outputMode === 'count') {
      if (symmetricContext === 0 && !singleFileTarget) {
        const rgCount = await tryRipgrepGrepCount(
          pattern,
          baseDir,
          effectiveHeadLimit,
          options?.caseInsensitive ?? false,
          options?.include,
          options?.exclude,
          multiline,
          typeFilter,
        )
        if (rgCount) return rgCount
      }

      const lineRxCountPre = getJsLineRegex()
      if (!lineRxCountPre) {
        return {
          success: false,
          error:
            `Invalid regex pattern for built-in search fallback: ${pattern.slice(0, 120)}${pattern.length > 120 ? '…' : ''}. ` +
            'The primary engine is ripgrep (Rust regex). This error appears when ripgrep could not be used and the pattern is not valid JavaScript `RegExp` syntax.',
        }
      }
      const lineRxCount: RegExp = lineRxCountPre

      const counts: { file: string; count: number }[] = []

      function searchFileCount(filePath: string, relativePath: string) {
        if (atMatchCap(counts.length)) return
        const lines = readFileLines(filePath, relativePath)
        if (!lines) return

        let c = 0
        for (let i = 0; i < lines.length; i++) {
          lineRxCount.lastIndex = 0
          if (lineRxCount.test(lines[i])) c += 1
        }
        if (c > 0) counts.push({ file: relativePath, count: c })
      }

      function walkCount(dir: string, depth: number) {
        if (atMatchCap(counts.length) || shouldStopScanning()) return
        if (depth > 20) return

        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }

        for (const entry of entries) {
          if (atMatchCap(counts.length) || shouldStopScanning()) break
          if (IGNORE_DIRS.has(entry.name)) continue
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue

          const fullPath = path.join(dir, entry.name)
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            walkCount(fullPath, depth + 1)
          } else if (entry.isFile()) {
            searchFileCount(fullPath, relativePath)
          }
        }
      }

      if (singleFileTarget) {
        const rel = path.relative(baseDir, singleFileTarget).replace(/\\/g, '/')
        searchFileCount(singleFileTarget, rel)
      } else {
        walkCount(baseDir, 0)
      }

      if (counts.length === 0) {
        return { success: true, output: `No matches for "${pattern}"` }
      }

      const linesOut = counts.map(({ file, count }) => `${file}: ${count}`)
      const wasTruncated = counts.length - skipOffset > effectiveHeadLimit
      const finalLines = wasTruncated
        ? linesOut.slice(skipOffset, skipOffset + effectiveHeadLimit)
        : linesOut.slice(skipOffset)
      const appliedLimit = wasTruncated ? effectiveHeadLimit : undefined
      const appliedOffset = skipOffset > 0 ? skipOffset : undefined
      const limitStr = formatLimitInfo(appliedLimit, appliedOffset)
      let totalMatches = 0
      let fileCount = 0
      for (const line of finalLines) {
        const colonIdx = line.lastIndexOf(':')
        if (colonIdx > 0) {
          const cnt = parseInt(line.substring(colonIdx + 1), 10)
          if (!isNaN(cnt)) { totalMatches += cnt; fileCount += 1 }
        }
      }
      let note = ''
      if (wasTruncated) note = `\n\n[Showing results with pagination = ${limitStr}]`
      else if (limitStr) note = `\n\n[limit: ${limitStr}]`
      const summary = `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.${note}`
      return { success: true, output: finalLines.join('\n') + summary, numMatches: totalMatches, numFiles: fileCount }
    }

    // ----- content -----
    interface MatchResult {
      file: string
      line: number
      text: string
    }

    if (!singleFileTarget) {
      const rgContent = await tryRipgrepGrepContent(
        pattern,
        baseDir,
        effectiveHeadLimit,
        options?.caseInsensitive ?? false,
        options?.include,
        options?.exclude,
        symmetricContext,
        beforeOnly,
        afterOnly,
        multiline,
        typeFilter,
      )
      if (rgContent) return rgContent
    }

    const lineRxContentPre = getJsLineRegex()
    if (!lineRxContentPre) {
      return {
        success: false,
        error:
          `Invalid regex pattern for built-in search fallback: ${pattern.slice(0, 120)}${pattern.length > 120 ? '…' : ''}. ` +
          'The primary engine is ripgrep (Rust regex). This error appears when ripgrep could not be used and the pattern is not valid JavaScript `RegExp` syntax.',
      }
    }
    const lineRxContent: RegExp = lineRxContentPre

    const matches: MatchResult[] = []

    function searchFileContent(filePath: string, relativePath: string) {
      if (atMatchCap(matches.length)) return
      const lines = readFileLines(filePath, relativePath)
      if (!lines) return

      const fileMatchLineIdx: number[] = []
      for (let i = 0; i < lines.length; i++) {
        if (atMatchCap(matches.length)) break
        lineRxContent.lastIndex = 0
        if (lineRxContent.test(lines[i])) {
          fileMatchLineIdx.push(i)
        }
      }

      for (const lineIdx of fileMatchLineIdx) {
        if (atMatchCap(matches.length)) break

        const contextBefore: string[] = []
        const contextAfter: string[] = []

        if (contextLines > 0) {
          for (let c = Math.max(0, lineIdx - contextLines); c < lineIdx; c++) {
            contextBefore.push(`${c + 1}\t${lines[c]}`)
          }
          for (let c = lineIdx + 1; c <= Math.min(lines.length - 1, lineIdx + contextLines); c++) {
            contextAfter.push(`${c + 1}\t${lines[c]}`)
          }
        }

        const prefix = contextBefore.length > 0 ? contextBefore.join('\n') + '\n--\n' : ''
        const suffix = contextAfter.length > 0 ? '\n--\n' + contextAfter.join('\n') : ''

        matches.push({
          file: relativePath,
          line: lineIdx + 1,
          text: `${prefix}${lineIdx + 1}\t${lines[lineIdx]}${suffix}`,
        })
      }
    }

    function walkContent(dir: string, depth: number) {
      if (atMatchCap(matches.length) || shouldStopScanning()) return
      if (depth > 20) return

      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (atMatchCap(matches.length) || shouldStopScanning()) break
        if (IGNORE_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue

        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

        if (entry.isDirectory()) {
          walkContent(fullPath, depth + 1)
        } else if (entry.isFile()) {
          searchFileContent(fullPath, relativePath)
        }
      }
    }

    if (singleFileTarget) {
      const rel = path.relative(baseDir, singleFileTarget).replace(/\\/g, '/')
      searchFileContent(singleFileTarget, rel)
    } else {
      walkContent(baseDir, 0)
    }

    if (matches.length === 0) {
      return { success: true, output: `No matches for "${pattern}"` }
    }

    const byFile = new Map<string, MatchResult[]>()
    for (const m of matches) {
      const list = byFile.get(m.file) || []
      list.push(m)
      byFile.set(m.file, list)
    }

    const output: string[] = []
    for (const [file, fileMatches] of byFile) {
      output.push(file)
      for (const m of fileMatches) {
        output.push(`  ${m.line}: ${m.text.trim().split('\n').map(l => l.trim()).join('\n  ')}`)
      }
    }

    const wasTruncated = headCapped && matches.length >= effectiveHeadLimit
    const appliedLimit = wasTruncated ? effectiveHeadLimit : undefined
    const appliedOffset = skipOffset > 0 ? skipOffset : undefined
    const limitStr = formatLimitInfo(appliedLimit, appliedOffset)
    let note = ''
    if (wasTruncated) note = `\n\n[Showing results with pagination = ${limitStr}]`
    else if (shouldStopScanning()) note = '\n\n(stopped after scanning many files; narrow path or use include/exclude)'
    return { success: true, output: output.join('\n') + note, numLines: matches.length }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
