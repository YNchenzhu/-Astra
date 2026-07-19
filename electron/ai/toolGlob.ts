/**
 * Glob tool — file pattern matching with ripgrep fast-path and JS fallback.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { type ToolResult } from './tools'
import { resolveRipgrepBin } from '../utils/ripgrepBin'
import { noteSuccessfulDiscovery } from './toolReadFile'
import { getWorkspacePath } from '../tools/workspaceState'
import { buildFuzzyNotFoundError } from '../tools/fuzzyPathError'
import {
  RG_SPAWNSYNC_TIMEOUT_MS,
  resolveSearchPath,
  gateSessionMemoryInternalSearchDir,
  globToRegex,
  collectIgnorePatternsForDir,
  matchesIgnorePattern,
  IGNORE_DIRS,
  getIgnoreArgsForDir,
} from './advancedToolUtils'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Hard cap on stdout buffered from ripgrep. Matches the historical
 * spawnSync `maxBuffer` so behavior is identical for typical workloads.
 */
const RG_MAX_STDOUT_BYTES = 12 * 1024 * 1024

/**
 * Run ripgrep with non-blocking spawn + Promise. Replaces the historical
 * `spawnSync` call so ripgrep no longer pins the Electron main process
 * event loop for up to RG_SPAWNSYNC_TIMEOUT_MS on a large monorepo.
 * Mirrors the helper used by `toolGrep.ts`.
 */
function runRipgrep(
  bin: string,
  args: string[],
  baseDir: string,
): Promise<{ stdout: string; status: number; error?: Error }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { cwd: baseDir, windowsHide: true })
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

    child.stderr?.resume()
    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), status: -1, error: err })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || killed) {
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

async function tryRipgrepGlobFiles(
  pattern: string,
  baseDir: string,
  maxResults: number,
): Promise<ToolResult | null> {
  if (process.env.DISABLE_RG_GLOB === '1') return null
  const bin = resolveRipgrepBin()
  const args: string[] = ['--files', '--glob', pattern, '--sortr=modified', '--no-messages']
  // Mirror the JS fallback's dotfile policy: exclude any path that contains
  // a hidden segment, then re-allow `.env.example` (the one whitelisted
  // dotfile in `walk()` at L119). Without this the ripgrep fast-path leaked
  // every `.hidden` file while the JS path quietly hid them — same tool,
  // two different visibilities for the same workspace (test G10).
  args.push('--glob', '!**/.*', '--glob', '**/.env.example')
  // Add .gitignore-derived exclusions
  args.push(...getIgnoreArgsForDir(baseDir))
  const r = await runRipgrep(bin, args, baseDir)
  if (r.error) return null
  const raw = r.stdout.trim()
  if (r.status !== 0 && !raw) return null
  const lines = raw ? raw.split(/\r?\n/).filter(Boolean) : []
  if (lines.length === 0) {
    return { success: true, output: `No files matching "${pattern}"` }
  }
  const capped = lines.slice(0, maxResults)
  const rel = capped.map((abs) => {
    const full = path.isAbsolute(abs) ? abs : path.join(baseDir, abs)
    return path.relative(baseDir, full).replace(/\\/g, '/')
  })
  const truncated = lines.length >= maxResults
  return {
    success: true,
    output: rel.join('\n') + (truncated ? `\n\n(truncated at ${maxResults} results)` : ''),
    numFiles: rel.length,
    truncated,
  }
}

export async function toolGlob(
  pattern: string,
  cwd?: string,
  options?: { maxResults?: number; includeDirs?: boolean }
): Promise<ToolResult> {
  noteSuccessfulDiscovery()
  try {
    const resolved = resolveSearchPath(cwd)
    if (!resolved.ok) return resolved.result
    if (resolved.singleFileTarget) {
      const base = resolved.baseDir
      const fileName = path.basename(resolved.singleFileTarget)
      const regex = globToRegex(pattern)
      const matches = regex.test(fileName)
      return {
        success: true,
        output: matches ? path.relative(base, resolved.singleFileTarget).replace(/\\/g, '/') : '(no match)',
        numFiles: matches ? 1 : 0,
      }
    }
    const baseDir = resolved.baseDir
    const smGate = gateSessionMemoryInternalSearchDir(baseDir, [pattern])
    if (smGate) return smGate
    if (!fs.existsSync(baseDir)) {
      return {
        success: false,
        ...buildFuzzyNotFoundError({
          toolName: 'glob',
          kind: 'directory',
          inputPath: cwd ?? baseDir,
          resolvedPath: baseDir,
          workspace: getWorkspacePath() ?? undefined,
        }),
      }
    }

    const maxResults = options?.maxResults || 200
    const includeDirs = options?.includeDirs ?? false

    if (!includeDirs) {
      const rgOut = await tryRipgrepGlobFiles(pattern, baseDir, maxResults)
      if (rgOut) return rgOut
    }

    const regex = globToRegex(pattern)
    const ignorePatterns = collectIgnorePatternsForDir(baseDir)
    const results: string[] = []

    function walk(dir: string, depth: number) {
      if (results.length >= maxResults) return
      if (depth > 20) return

      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break
        if (IGNORE_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue

        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

        if (matchesIgnorePattern(relativePath, ignorePatterns)) continue

        if (entry.isDirectory()) {
          if (includeDirs && regex.test(relativePath)) {
            results.push(relativePath + '/')
          }
          walk(fullPath, depth + 1)
        } else if (entry.isFile()) {
          if (regex.test(relativePath)) {
            results.push(relativePath)
          }
        }
      }
    }

    walk(baseDir, 0)

    if (results.length === 0) {
      return { success: true, output: `No files matching "${pattern}"` }
    }

    results.sort((a, b) => {
      try {
        const sa = fs.statSync(path.join(baseDir, a))
        const sb = fs.statSync(path.join(baseDir, b))
        return sb.mtimeMs - sa.mtimeMs
      } catch {
        return a.localeCompare(b)
      }
    })

    const truncated = results.length >= maxResults
    const output = results.join('\n')
    return {
      success: true,
      output: output + (truncated ? `\n\n(truncated at ${maxResults} results)` : ''),
      numFiles: results.length,
      truncated,
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
