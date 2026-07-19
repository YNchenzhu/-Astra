/**
 * LSP Diagnostic Registry — pending diagnostics from language servers (publishDiagnostics).
 * Ported from upstream LSPDiagnosticRegistry.ts (volume limits + cross-turn dedup).
 */

import { randomUUID } from 'node:crypto'
import type { DiagnosticEntry, DiagnosticFile } from './diagnosticTypes'

const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30
const MAX_DELIVERED_FILES = 500

export type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
}

const pendingDiagnostics = new Map<string, PendingLSPDiagnostic>()
const deliveredDiagnostics = new Map<string, Set<string>>()

function evictDeliveredIfNeeded(): void {
  while (deliveredDiagnostics.size > MAX_DELIVERED_FILES) {
    const first = deliveredDiagnostics.keys().next().value as string | undefined
    if (first === undefined) break
    deliveredDiagnostics.delete(first)
  }
}

function severityToNumber(severity: string | undefined): number {
  switch (severity) {
    case 'Error':
      return 1
    case 'Warning':
      return 2
    case 'Info':
      return 3
    case 'Hint':
      return 4
    default:
      return 4
  }
}

function createDiagnosticKey(diag: DiagnosticEntry): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source ?? null,
    code: diag.code ?? null,
  })
}

function deduplicateDiagnosticFiles(allFiles: DiagnosticFile[]): DiagnosticFile[] {
  const fileMap = new Map<string, Set<string>>()
  const dedupedFiles: DiagnosticFile[] = []

  for (const file of allFiles) {
    if (!fileMap.has(file.uri)) {
      fileMap.set(file.uri, new Set())
      dedupedFiles.push({ uri: file.uri, diagnostics: [] })
    }

    const seenDiagnostics = fileMap.get(file.uri)!
    const dedupedFile = dedupedFiles.find((f) => f.uri === file.uri)!
    const previouslyDelivered = deliveredDiagnostics.get(file.uri) ?? new Set()

    for (const diag of file.diagnostics) {
      const key = createDiagnosticKey(diag)
      if (seenDiagnostics.has(key) || previouslyDelivered.has(key)) {
        continue
      }
      seenDiagnostics.add(key)
      dedupedFile.diagnostics.push(diag)
    }
  }

  return dedupedFiles.filter((f) => f.diagnostics.length > 0)
}

export function registerPendingLSPDiagnostic(params: {
  serverName: string
  files: DiagnosticFile[]
}): void {
  const { serverName, files } = params
  pendingDiagnostics.set(randomUUID(), {
    serverName,
    files,
    timestamp: Date.now(),
    attachmentSent: false,
  })
}

export function checkForLSPDiagnostics(): Array<{
  serverName: string
  files: DiagnosticFile[]
}> {
  const allFiles: DiagnosticFile[] = []
  const serverNames = new Set<string>()
  const diagnosticsToMark: PendingLSPDiagnostic[] = []

  for (const diagnostic of pendingDiagnostics.values()) {
    if (!diagnostic.attachmentSent) {
      allFiles.push(...diagnostic.files)
      serverNames.add(diagnostic.serverName)
      diagnosticsToMark.push(diagnostic)
    }
  }

  if (allFiles.length === 0) {
    return []
  }

  let dedupedFiles: DiagnosticFile[]
  try {
    dedupedFiles = deduplicateDiagnosticFiles(allFiles)
  } catch {
    dedupedFiles = allFiles
  }

  for (const diagnostic of diagnosticsToMark) {
    diagnostic.attachmentSent = true
  }
  for (const [id, diagnostic] of pendingDiagnostics) {
    if (diagnostic.attachmentSent) {
      pendingDiagnostics.delete(id)
    }
  }

  let totalDiagnostics = 0
  for (const file of dedupedFiles) {
    file.diagnostics.sort(
      (a, b) => severityToNumber(a.severity) - severityToNumber(b.severity),
    )

    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    }

    const remainingCapacity = MAX_TOTAL_DIAGNOSTICS - totalDiagnostics
    if (file.diagnostics.length > remainingCapacity) {
      file.diagnostics = file.diagnostics.slice(0, Math.max(0, remainingCapacity))
    }

    totalDiagnostics += file.diagnostics.length
  }

  dedupedFiles = dedupedFiles.filter((f) => f.diagnostics.length > 0)

  for (const file of dedupedFiles) {
    let delivered = deliveredDiagnostics.get(file.uri)
    if (!delivered) {
      delivered = new Set()
    }
    deliveredDiagnostics.delete(file.uri)
    for (const diag of file.diagnostics) {
      delivered.add(createDiagnosticKey(diag))
    }
    deliveredDiagnostics.set(file.uri, delivered)
    evictDeliveredIfNeeded()
  }

  const finalCount = dedupedFiles.reduce((sum, f) => sum + f.diagnostics.length, 0)
  if (finalCount === 0) {
    return []
  }

  return [
    {
      serverName: [...serverNames].join(', '),
      files: dedupedFiles,
    },
  ]
}

export function clearAllLSPDiagnostics(): void {
  pendingDiagnostics.clear()
}

export function resetAllLSPDiagnosticState(): void {
  pendingDiagnostics.clear()
  deliveredDiagnostics.clear()
}

export function clearDeliveredDiagnosticsForFile(fileUri: string): void {
  deliveredDiagnostics.delete(fileUri)
}

export function getPendingLSPDiagnosticCount(): number {
  return pendingDiagnostics.size
}
