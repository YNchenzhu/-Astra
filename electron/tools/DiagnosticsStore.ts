/**
 * Diagnostics Store — Main Process
 *
 * Unified diagnostic model for ReadDiagnostics + AI context:
 * - Renderer (Monaco markers) → setFromRenderer (replaces only `monaco`-sourced rows)
 * - Subprocess LSP (publishDiagnostics) → mergeFromLanguageServer (scoped by `lsp:<server>`)
 */

import path from 'node:path'

export interface DiagnosticEntry {
  file: string
  fileName: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  source: string
  code?: string | number
}

/** Marker source for editor / TypeScript worker diagnostics (single bucket for merge). */
export const MONACO_DIAGNOSTIC_SOURCE = 'monaco'

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) {
    let p = uri.slice(7)
    if (/^\/[a-zA-Z]:\//.test(p)) {
      p = p.slice(1)
    }
    return p
  }
  return uri
}

function normalizeStorePath(p: string): string {
  return path.normalize(uriToFilePath(p))
}

class DiagnosticsStore {
  private byFile = new Map<string, DiagnosticEntry[]>()
  private updatedAtByFile = new Map<string, number>()

  private mapLspRows(
    filePath: string,
    lspDiagnostics: unknown[],
    sourceTag: string,
  ): DiagnosticEntry[] {
    const fileName = filePath.split(/[\\/]/).pop() || filePath
    const severityMap: Record<number, DiagnosticEntry['severity']> = {
      1: 'error',
      2: 'warning',
      3: 'information',
      4: 'hint',
    }

    return lspDiagnostics.map((diag) => {
      const d = (diag ?? {}) as {
        range?: {
          start?: { line?: number; character?: number }
          end?: { line?: number; character?: number }
        }
        severity?: number
        message?: string
        source?: string
        code?: string | number
      }
      return {
        file: filePath,
        fileName,
        line: (d.range?.start?.line ?? -1) + 1,
        column: (d.range?.start?.character ?? -1) + 1,
        endLine: (d.range?.end?.line ?? -1) + 1,
        endColumn: (d.range?.end?.character ?? -1) + 1,
        severity: severityMap[d.severity ?? 1] || 'error',
        message: d.message || '',
        source: sourceTag,
        code: d.code,
      }
    })
  }

  /**
   * Full replace from renderer (Monaco). Removes prior `monaco` rows for this file, keeps `lsp:*`.
   */
  setFromRenderer(uri: string, lspDiagnostics: unknown[]): void {
    const filePath = normalizeStorePath(uri)
    const prev = this.byFile.get(filePath) ?? []
    const kept = prev.filter((e) => e.source !== MONACO_DIAGNOSTIC_SOURCE)
    const monacoRows = this.mapLspRows(filePath, lspDiagnostics, MONACO_DIAGNOSTIC_SOURCE)
    const merged = [...kept, ...monacoRows]

    if (merged.length === 0) {
      this.byFile.delete(filePath)
      this.updatedAtByFile.delete(filePath)
      return
    }

    this.byFile.set(filePath, merged)
    this.updatedAtByFile.set(filePath, Date.now())
  }

  /**
   * Merge diagnostics from a language-server publish. Rows use source prefix `lsp:<serverName>`.
   * Empty array clears only that server's rows for the file.
   */
  mergeFromLanguageServer(
    filePath: string,
    raw: Array<{
      range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }
      severity?: number
      message?: string
      source?: string
      code?: string | number
    }>,
    serverName: string,
  ): void {
    const key = normalizeStorePath(filePath)
    const sourceTag = `lsp:${serverName}`
    const prev = this.byFile.get(key) ?? []
    const filtered = prev.filter((e) => e.source !== sourceTag)

    if (!raw || raw.length === 0) {
      if (filtered.length === 0) {
        this.byFile.delete(key)
        this.updatedAtByFile.delete(key)
      } else {
        this.byFile.set(key, filtered)
        this.updatedAtByFile.set(key, Date.now())
      }
      return
    }

    const rows = this.mapLspRows(key, raw, sourceTag)
    this.byFile.set(key, [...filtered, ...rows])
    this.updatedAtByFile.set(key, Date.now())
  }

  /** @deprecated Use setFromRenderer */
  set(uri: string, lspDiagnostics: unknown[]): void {
    this.setFromRenderer(uri, lspDiagnostics)
  }

  clear(uri: string): void {
    const filePath = normalizeStorePath(uri)
    this.byFile.delete(filePath)
    this.updatedAtByFile.delete(filePath)
  }

  clearAll(): void {
    this.byFile.clear()
    this.updatedAtByFile.clear()
  }

  getAll(): DiagnosticEntry[] {
    const result: DiagnosticEntry[] = []
    for (const diags of this.byFile.values()) {
      result.push(...diags)
    }
    return result
  }

  getForFile(filePath: string): DiagnosticEntry[] {
    const queryPath = filePath.replace(/\\/g, '/')
    const queryLower = queryPath.toLowerCase()

    if (this.byFile.has(filePath)) {
      return this.byFile.get(filePath) || []
    }
    if (this.byFile.has(queryPath)) {
      return this.byFile.get(queryPath) || []
    }

    for (const [key, diags] of this.byFile.entries()) {
      const normalizedKey = key.replace(/\\/g, '/')
      const keyLower = normalizedKey.toLowerCase()

      if (keyLower === queryLower) return diags
      if (normalizedKey.endsWith(queryPath)) return diags
      if (queryPath.endsWith(normalizedKey)) return diags

      const keyBase = normalizedKey.split('/').pop()
      const queryBase = queryPath.split('/').pop()
      if (keyBase && queryBase && keyBase.toLowerCase() === queryBase.toLowerCase()) {
        if (this.countFilesByName(keyBase) === 1) return diags
      }
    }

    return []
  }

  private countFilesByName(basename: string): number {
    let count = 0
    for (const key of this.byFile.keys()) {
      const normalizedKey = key.replace(/\\/g, '/')
      if (normalizedKey.split('/').pop()?.toLowerCase() === basename.toLowerCase()) {
        count++
      }
    }
    return count
  }

  getSummary(): { errorCount: number; warningCount: number; infoCount: number; total: number } {
    const all = this.getAll()
    return {
      errorCount: all.filter((d) => d.severity === 'error').length,
      warningCount: all.filter((d) => d.severity === 'warning').length,
      infoCount: all.filter((d) => d.severity === 'information').length,
      total: all.length,
    }
  }

  getFileCount(): number {
    return this.byFile.size
  }

  getLastUpdatedAtForFile(filePath: string): number {
    const queryPath = filePath.replace(/\\/g, '/')
    const queryLower = queryPath.toLowerCase()

    const direct = this.updatedAtByFile.get(filePath) ?? this.updatedAtByFile.get(queryPath)
    if (typeof direct === 'number') return direct

    for (const [key, updatedAt] of this.updatedAtByFile.entries()) {
      const normalizedKey = key.replace(/\\/g, '/')
      const keyLower = normalizedKey.toLowerCase()
      if (keyLower === queryLower) return updatedAt
      if (normalizedKey.endsWith(queryPath) || queryPath.endsWith(normalizedKey)) {
        return updatedAt
      }
    }

    return 0
  }

  getLatestForFiles(
    filePaths: string[],
  ): Array<{ filePath: string; updatedAt: number; diagnostics: DiagnosticEntry[] }> {
    const seen = new Set<string>()
    const result: Array<{ filePath: string; updatedAt: number; diagnostics: DiagnosticEntry[] }> = []

    for (const filePath of filePaths) {
      const normalized = filePath.replace(/\\/g, '/')
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      const diagnostics = this.getForFile(normalized)
      if (diagnostics.length === 0) continue
      const updatedAt = this.updatedAtByFile.get(diagnostics[0].file) ?? this.updatedAtByFile.get(normalized) ?? 0
      result.push({
        filePath: diagnostics[0].file || normalized,
        updatedAt,
        diagnostics,
      })
    }

    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  buildPromptSummaryForFiles(
    filePaths: string[],
    options?: { maxFiles?: number; maxPerFile?: number; maxChars?: number },
  ): string {
    const maxFiles = Math.max(1, options?.maxFiles ?? 3)
    const maxPerFile = Math.max(1, options?.maxPerFile ?? 3)
    const maxChars = Math.max(300, options?.maxChars ?? 1400)
    const scoped = this.getLatestForFiles(filePaths).slice(0, maxFiles)
    if (scoped.length === 0) return ''

    const parts: string[] = ['Recent LSP diagnostics (latest changed files):']
    for (const fileEntry of scoped) {
      const errors = fileEntry.diagnostics.filter((d) => d.severity === 'error')
      const warnings = fileEntry.diagnostics.filter((d) => d.severity === 'warning')
      const top = fileEntry.diagnostics.slice(0, maxPerFile)
      parts.push(
        `- ${fileEntry.filePath} (errors=${errors.length}, warnings=${warnings.length}, total=${fileEntry.diagnostics.length})`,
      )
      for (const diag of top) {
        parts.push(`  - [${diag.severity}] ${diag.line}:${diag.column} ${diag.message}`)
      }
    }

    const text = parts.join('\n')
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n...[diagnostics summary truncated]`
  }
}

export const diagnosticsStore = new DiagnosticsStore()
