/**
 * LSP result formatters and gitignore filters.
 *
 * Extracted from LSPTool.ts to keep the tool definition file small.
 */

import path from 'node:path'
import type { SemanticTokensLegend, ServerCapabilities } from 'vscode-languageserver-protocol'
import type { ToolResult } from './types'
import type { LSPOperation } from './LSPTool'

interface LspLocation {
  uri: string
  range: { start: { line: number; character: number } }
}

function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // Use undecoded if malformed
  }
  return filePath
}

function formatUri(uri: string | undefined, cwd?: string): string {
  if (!uri) return '<unknown location>'
  const filePath = uriToFilePath(uri)
  if (cwd) {
    const relativePath = path.relative(cwd, filePath).replaceAll('\\\\', '/')
    if (relativePath.length < filePath.length && !relativePath.startsWith('../../')) {
      return relativePath
    }
  }
  return filePath.replaceAll('\\\\', '/')
}

function formatLocation(loc: { uri: string; range: { start: { line: number; character: number } } }, cwd?: string): string {
  const filePath = formatUri(loc.uri, cwd)
  const line = loc.range.start.line + 1
  const character = loc.range.start.character + 1
  return `${filePath}:${line}:${character}`
}

function toLocation(item: Record<string, unknown>): LspLocation | null {
  if ('targetUri' in item) {
    return {
      uri: item.targetUri as string,
      range: (item.targetSelectionRange || item.targetRange) as LspLocation['range'],
    }
  }
  if ('uri' in item && 'range' in item) {
    return item as unknown as LspLocation
  }
  return null
}

function symbolKindToString(kind: number): string {
  const kinds: Record<number, string> = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
    6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
    11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String',
    16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
    21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator',
    26: 'TypeParameter',
  }
  return kinds[kind] || 'Unknown'
}

function formatGoToDefinition(result: unknown, cwd?: string): string {
  if (!result) {
    return 'No definition found. The cursor may not be on a symbol, or the definition is in an external library.'
  }

  const raw = Array.isArray(result)
    ? (result as unknown[]).map((r) => toLocation(r as Record<string, unknown>))
    : [toLocation(result as Record<string, unknown>)]

  const locations = raw.filter((loc): loc is LspLocation => loc !== null)
  if (locations.length === 0) return 'No definition found.'
  if (locations.length === 1) return `Defined in ${formatLocation(locations[0], cwd)}`

  const list = locations.map(loc => `  ${formatLocation(loc, cwd)}`).join('\n')
  return `Found ${locations.length} definitions:\n${list}`
}

function formatFindReferences(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No references found.'
  }

  const locations = (result as LspLocation[]).filter(loc => loc && loc.uri)
  const byFile = new Map<string, LspLocation[]>()
  for (const loc of locations) {
    const filePath = formatUri(loc.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(loc)
    else byFile.set(filePath, [loc])
  }

  const lines: string[] = [`Found ${locations.length} references across ${byFile.size} files:`]
  for (const [filePath, locs] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locs) {
      const range = loc.range
      lines.push(`  Line ${range.start.line + 1}:${range.start.character + 1}`)
    }
  }
  return lines.join('\n')
}

function formatHover(result: unknown, _cwd?: string): string {
  if (!result) return 'No hover information available.'

  const hover = result as Record<string, unknown>
  const contents = hover.contents
  let text = ''

  if (typeof contents === 'string') {
    text = contents
  } else if (Array.isArray(contents)) {
    text = (contents as Array<Record<string, unknown> | string>)
      .map(item => typeof item === 'string' ? item : (item as Record<string, unknown>).value as string || '')
      .join('\n\n')
  } else if (contents && typeof contents === 'object') {
    text = (contents as Record<string, unknown>).value as string || ''
  }

  if (hover.range) {
    const range = hover.range as { start: { line: number; character: number } }
    return `Hover info at ${range.start.line + 1}:${range.start.character + 1}:\n\n${text}`
  }
  return text
}

function formatDocumentSymbolNode(symbol: Record<string, unknown>, indent: number = 0): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  const kind = symbolKindToString(symbol.kind as number)
  let line = `${prefix}${symbol.name} (${kind})`
  if (symbol.detail) line += ` ${symbol.detail}`
  const range = symbol.range as { start: { line: number } }
  line += ` - Line ${range.start.line + 1}`
  lines.push(line)

  const children = symbol.children as Record<string, unknown>[] | undefined
  if (children && children.length > 0) {
    for (const child of children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }
  return lines
}

function formatDocumentSymbol(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No symbols found in document.'
  }

  const symbols = result as Record<string, unknown>[]
  // Check if SymbolInformation format (has 'location')
  if (symbols[0] && 'location' in symbols[0]) {
    return formatWorkspaceSymbol(result, cwd)
  }

  const lines: string[] = ['Document symbols:']
  for (const symbol of symbols) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }
  return lines.join('\n')
}

function formatWorkspaceSymbol(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No symbols found in workspace.'
  }

  const symbols = (result as Record<string, unknown>[])
    .filter(s => s.location && (s.location as Record<string, unknown>).uri)

  if (symbols.length === 0) return 'No symbols found in workspace.'

  const byFile = new Map<string, Record<string, unknown>[]>()
  for (const sym of symbols) {
    const loc = sym.location as Record<string, unknown>
    const filePath = formatUri(loc.uri as string, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(sym)
    else byFile.set(filePath, [sym])
  }

  const lines: string[] = [`Found ${symbols.length} symbol(s) in workspace:`]
  for (const [filePath, syms] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const sym of syms) {
      const kind = symbolKindToString(sym.kind as number)
      const loc = sym.location as Record<string, unknown>
      const range = loc.range as { start: { line: number } }
      let symLine = `  ${sym.name} (${kind}) - Line ${range.start.line + 1}`
      if (sym.containerName) symLine += ` in ${sym.containerName}`
      lines.push(symLine)
    }
  }
  return lines.join('\n')
}

function formatCallHierarchyItem(item: Record<string, unknown>, cwd?: string): string {
  if (!item.uri) return `${item.name} (${symbolKindToString(item.kind as number)}) - <unknown location>`
  const filePath = formatUri(item.uri as string, cwd)
  const range = item.range as { start: { line: number } }
  let result = `${item.name} (${symbolKindToString(item.kind as number)}) - ${filePath}:${range.start.line + 1}`
  if (item.detail) result += ` [${item.detail}]`
  return result
}

function formatPrepareCallHierarchy(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No call hierarchy item found at this position.'
  }
  const items = result as Record<string, unknown>[]
  if (items.length === 1) return `Call hierarchy item: ${formatCallHierarchyItem(items[0], cwd)}`
  return `Found ${items.length} call hierarchy items:\n${items.map(i => `  ${formatCallHierarchyItem(i, cwd)}`).join('\n')}`
}

function formatIncomingCalls(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No incoming calls found (nothing calls this function).'
  }

  const calls = result as Record<string, unknown>[]
  const byFile = new Map<string, Record<string, unknown>[]>()
  for (const call of calls) {
    const from = call.from as Record<string, unknown> | undefined
    if (!from) continue
    const filePath = formatUri(from.uri as string, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(call)
    else byFile.set(filePath, [call])
  }

  const lines: string[] = [`Found ${calls.length} incoming call(s):`]
  for (const [filePath, fileCalls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of fileCalls) {
      const from = call.from as Record<string, unknown>
      const kind = symbolKindToString(from.kind as number)
      const range = from.range as { start: { line: number; character: number } }
      let callLine = `  ${from.name} (${kind}) - Line ${range.start.line + 1}`
      const fromRanges = call.fromRanges as Array<{ start: { line: number; character: number } }> | undefined
      if (fromRanges && fromRanges.length > 0) {
        const sites = fromRanges.map(r => `${r.start.line + 1}:${r.start.character + 1}`).join(', ')
        callLine += ` [calls at: ${sites}]`
      }
      lines.push(callLine)
    }
  }
  return lines.join('\n')
}

function formatOutgoingCalls(result: unknown, cwd?: string): string {
  if (!result || !Array.isArray(result) || (result as unknown[]).length === 0) {
    return 'No outgoing calls found (this function calls nothing).'
  }

  const calls = result as Record<string, unknown>[]
  const byFile = new Map<string, Record<string, unknown>[]>()
  for (const call of calls) {
    const to = call.to as Record<string, unknown> | undefined
    if (!to) continue
    const filePath = formatUri(to.uri as string, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(call)
    else byFile.set(filePath, [call])
  }

  const lines: string[] = [`Found ${calls.length} outgoing call(s):`]
  for (const [filePath, fileCalls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of fileCalls) {
      const to = call.to as Record<string, unknown>
      const kind = symbolKindToString(to.kind as number)
      const range = to.range as { start: { line: number; character: number } }
      let callLine = `  ${to.name} (${kind}) - Line ${range.start.line + 1}`
      const fromRanges = call.fromRanges as Array<{ start: { line: number; character: number } }> | undefined
      if (fromRanges && fromRanges.length > 0) {
        const sites = fromRanges.map(r => `${r.start.line + 1}:${r.start.character + 1}`).join(', ')
        callLine += ` [called from: ${sites}]`
      }
      lines.push(callLine)
    }
  }
  return lines.join('\n')
}

// ── Extended LSP operations (completion, codeAction, etc.) ─────────────────

const COMPLETION_ITEM_KIND: Record<number, string> = {
  1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field',
  6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property',
  11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet',
  16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember',
  21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
}

function truncateForToolOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} characters total)`
}

function markupToPlain(markup: unknown): string {
  if (markup == null) return ''
  if (typeof markup === 'string') return markup
  if (typeof markup === 'object' && 'value' in (markup as object)) {
    return String((markup as { value?: string }).value ?? '')
  }
  return String(markup)
}

function summarizeWorkspaceEdit(edit: unknown, cwd: string): string {
  const e = edit as Record<string, unknown>
  const parts: string[] = []
  const changes = e.changes as Record<string, unknown[]> | undefined
  if (changes) {
    const uris = Object.keys(changes)
    parts.push(`${uris.length} file(s) in changes`)
    for (const u of uris.slice(0, 5)) {
      const edits = changes[u] ?? []
      parts.push(`  ${formatUri(u, cwd)}: ${edits.length} text edit(s)`)
    }
    if (uris.length > 5) parts.push(`  … ${uris.length - 5} more file(s)`)
  }
  const docChanges = e.documentChanges as unknown[] | undefined
  if (docChanges?.length) parts.push(`${docChanges.length} structured document change(s)`)
  return parts.join('\n') || 'workspace edit'
}

function formatCodeActionResult(result: unknown, cwd: string): string {
  if (result == null || (Array.isArray(result) && result.length === 0)) {
    return 'No code actions available for this range.'
  }
  const items = result as Record<string, unknown>[]
  const lines: string[] = [`${items.length} code action(s):`]
  const limit = 40
  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const a = items[i]!
    const title = String(a.title ?? '(no title)')
    const kind = a.kind != null ? ` [${a.kind}]` : ''
    const command = a.command != null ? ' (command)' : ''
    const editHint = a.edit != null ? ' (workspace edit)' : ''
    lines.push(`${i + 1}. ${title}${kind}${command}${editHint}`)
    if (a.edit) {
      lines.push(`   ${summarizeWorkspaceEdit(a.edit, cwd).split('\n').join('\n   ')}`)
    }
  }
  if (items.length > limit) lines.push(`… and ${items.length - limit} more`)
  return lines.join('\n')
}

function formatCompletionResult(result: unknown, _cwd: string): string {
  if (result == null) return 'No completions returned.'
  const list = result as { isIncomplete?: boolean; items?: Record<string, unknown>[] }
  const items = list.items ?? (Array.isArray(result) ? (result as Record<string, unknown>[]) : [])
  if (items.length === 0) return 'Empty completion list.'
  const lines: string[] = [
    `Completions (${items.length}${list.isIncomplete ? ', incomplete' : ''}):`,
  ]
  const maxShow = 50
  for (let i = 0; i < Math.min(items.length, maxShow); i++) {
    const it = items[i]!
    const kind = typeof it.kind === 'number' ? ` ${COMPLETION_ITEM_KIND[it.kind] ?? it.kind}` : ''
    const label = String(it.label ?? '')
    const detail = it.detail != null ? ` — ${truncateForToolOutput(String(it.detail), 120)}` : ''
    let doc = ''
    if (it.documentation != null) {
      doc = `\n     ${truncateForToolOutput(markupToPlain(it.documentation), 300).split('\n').join('\n     ')}`
    }
    lines.push(`${i + 1}. ${label}${kind}${detail}${doc}`)
  }
  if (items.length > maxShow) lines.push(`… and ${items.length - maxShow} more`)
  return lines.join('\n')
}

function formatSignatureHelpResult(result: unknown): string {
  if (result == null) return 'No signature help at this position.'
  const sh = result as {
    signatures?: Record<string, unknown>[]
    activeSignature?: number
    activeParameter?: number
  }
  const sigs = sh.signatures ?? []
  if (sigs.length === 0) return 'No signatures available.'
  const active = sh.activeSignature ?? 0
  const lines: string[] = []
  lines.push(
    `Active signature: ${active + 1}/${sigs.length}, active parameter index: ${sh.activeParameter ?? 0}`,
  )
  sigs.forEach((sig, idx) => {
    const label = String(sig.label ?? '')
    const docs = sig.documentation != null ? `\n  ${markupToPlain(sig.documentation)}` : ''
    lines.push(`${idx + 1}. ${label}${docs}`)
    const params = sig.parameters as Record<string, unknown>[] | undefined
    if (params?.length) {
      for (const p of params) {
        lines.push(`   - ${String(p.label ?? '')}`)
      }
    }
  })
  return lines.join('\n')
}

function formatRangeOneBased(r: {
  start: { line: number; character: number }
  end: { line: number; character: number }
}): string {
  return `${r.start.line + 1}:${r.start.character + 1}–${r.end.line + 1}:${r.end.character + 1}`
}

function formatFormattingResult(result: unknown): string {
  if (result == null || !Array.isArray(result) || result.length === 0) {
    return 'No formatting edits returned (file may already be formatted or server declined).'
  }
  const edits = result as Record<string, unknown>[]
  const lines: string[] = [
    `${edits.length} text edit(s) (not applied automatically — use Edit/Write if you want changes on disk):`,
  ]
  for (let i = 0; i < edits.length; i++) {
    const ed = edits[i]!
    const range = ed.range as
      | { start: { line: number; character: number }; end: { line: number; character: number } }
      | undefined
    const newText = String(ed.newText ?? '')
    const rangeStr = range ? formatRangeOneBased(range) : '?'
    lines.push(`${i + 1}. Range ${rangeStr}`)
    lines.push(
      truncateForToolOutput(newText, 1500)
        .split('\n')
        .map((l) => `   | ${l}`)
        .join('\n'),
    )
  }
  return lines.join('\n')
}

function formatRenameResult(result: unknown, cwd: string): string {
  if (result == null) return 'No rename result (symbol may not be renamable at this position).'
  const edit = result as Record<string, unknown>
  const summary = summarizeWorkspaceEdit(edit, cwd)
  return `Workspace rename edit:\n${summary}\n\nJSON (truncated):\n${truncateForToolOutput(JSON.stringify(edit, null, 2), 4000)}`
}

function formatFoldingRangeResult(result: unknown): string {
  if (result == null || !Array.isArray(result) || result.length === 0) {
    return 'No folding ranges.'
  }
  const ranges = result as Record<string, unknown>[]
  const lines: string[] = [`${ranges.length} folding range(s) (1-based lines):`]
  for (const r of ranges.slice(0, 200)) {
    const start = (r.startLine as number) + 1
    const end = (r.endLine as number) + 1
    const kind = r.kind != null ? ` [${r.kind}]` : ''
    lines.push(`  L${start}–L${end}${kind}`)
  }
  if (ranges.length > 200) lines.push(`… ${ranges.length - 200} more`)
  return lines.join('\n')
}

function extractSemanticLegend(caps: ServerCapabilities | undefined): SemanticTokensLegend | undefined {
  const p = caps?.semanticTokensProvider
  if (p == null || typeof p !== 'object') return undefined
  return (p as { legend?: SemanticTokensLegend }).legend
}

function decodeSemanticTokensData(
  data: number[],
  legend: SemanticTokensLegend,
): Array<{ line: number; char: number; len: number; type: string; mods: string }> {
  const out: Array<{ line: number; char: number; len: number; type: string; mods: string }> = []
  let prevLine = 0
  let prevStartChar = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!
    const deltaStartChar = data[i + 1]!
    const length = data[i + 2]!
    const tokenType = data[i + 3]!
    const tokenModifiers = data[i + 4]!
    const line = prevLine + deltaLine
    const char = deltaLine === 0 ? prevStartChar + deltaStartChar : deltaStartChar
    prevLine = line
    prevStartChar = char
    const typeName = legend.tokenTypes[tokenType] ?? `type#${tokenType}`
    const modNames: string[] = []
    let bit = 1
    const modifiers = legend.tokenModifiers ?? []
    for (let m = 0; m < modifiers.length; m++) {
      if (tokenModifiers & bit) modNames.push(modifiers[m]!)
      bit *= 2
    }
    out.push({
      line: line + 1,
      char: char + 1,
      len: length,
      type: typeName,
      mods: modNames.join(','),
    })
  }
  return out
}

function formatSemanticTokensResult(result: unknown, caps: ServerCapabilities | undefined): string {
  if (result == null || typeof result !== 'object') return 'No semantic tokens result.'
  const data = (result as { data?: number[] }).data
  if (!data || !Array.isArray(data) || data.length === 0) {
    return 'Semantic tokens result has no data (server may not support this file).'
  }
  const legend = extractSemanticLegend(caps)
  if (!legend?.tokenTypes?.length) {
    return `Raw semantic token data: ${data.length} numbers (server did not advertise a semantic tokens legend).\nFirst values: ${data.slice(0, 30).join(', ')}…`
  }
  const decoded = decodeSemanticTokensData(data, legend)
  return `Decoded ${decoded.length} token(s):\n${decoded
    .slice(0, 80)
    .map(
      (t) =>
        `  L${t.line}:${t.char} len=${t.len} ${t.type}${t.mods ? ` [${t.mods}]` : ''}`,
    )
    .join('\n')}${decoded.length > 80 ? `\n… ${decoded.length - 80} more` : ''}`
}

function filterWorkspaceEditByGitignore(
  edit: Record<string, unknown>,
  isIgnored: (abs: string) => boolean,
): Record<string, unknown> {
  const changes = edit.changes as Record<string, unknown[]> | undefined
  if (!changes) return edit
  const next: Record<string, unknown[]> = {}
  for (const [uri, textEdits] of Object.entries(changes)) {
    const abs = path.normalize(uriToFilePath(uri))
    if (!isIgnored(abs)) next[uri] = textEdits
  }
  return { ...edit, changes: next }
}

export function formatResult(
  operation: LSPOperation,
  result: unknown,
  cwd: string,
  serverCaps?: ServerCapabilities,
): string {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return formatGoToDefinition(result, cwd)
    case 'findReferences':
      return formatFindReferences(result, cwd)
    case 'hover':
      return formatHover(result, cwd)
    case 'documentSymbol':
      return formatDocumentSymbol(result, cwd)
    case 'workspaceSymbol':
      return formatWorkspaceSymbol(result, cwd)
    case 'prepareCallHierarchy':
      return formatPrepareCallHierarchy(result, cwd)
    case 'incomingCalls':
      return formatIncomingCalls(result, cwd)
    case 'outgoingCalls':
      return formatOutgoingCalls(result, cwd)
    case 'codeAction':
      return formatCodeActionResult(result, cwd)
    case 'completion':
      return formatCompletionResult(result, cwd)
    case 'signatureHelp':
      return formatSignatureHelpResult(result)
    case 'formatting':
      return formatFormattingResult(result)
    case 'rename':
      return formatRenameResult(result, cwd)
    case 'foldingRange':
      return formatFoldingRangeResult(result)
    case 'semanticTokens':
      return formatSemanticTokensResult(result, serverCaps)
  }
}

export function filterLspResultByGitignore(
  operation: LSPOperation,
  result: unknown,
  isIgnored: (abs: string) => boolean,
): unknown {
  if (result == null) return result
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation': {
      const raw = Array.isArray(result) ? result : [result]
      const kept = raw.filter((item) => {
        const loc = toLocation(item as Record<string, unknown>)
        if (!loc) return true
        return !isIgnored(path.normalize(uriToFilePath(loc.uri)))
      })
      return Array.isArray(result) ? kept : kept[0] ?? null
    }
    case 'findReferences': {
      const locs = (result as LspLocation[]) || []
      return locs.filter(
        (loc) => loc?.uri && !isIgnored(path.normalize(uriToFilePath(loc.uri))),
      )
    }
    case 'workspaceSymbol': {
      const syms = (result as Record<string, unknown>[]) || []
      return syms.filter((sym) => {
        const loc = sym.location as { uri?: string } | undefined
        if (!loc?.uri) return true
        return !isIgnored(path.normalize(uriToFilePath(loc.uri)))
      })
    }
    case 'incomingCalls':
    case 'outgoingCalls': {
      const calls = (result as Record<string, unknown>[]) || []
      return calls.filter((call) => {
        const from = call.from as { uri?: string } | undefined
        const to = call.to as { uri?: string } | undefined
        const u = from?.uri || to?.uri
        if (!u) return true
        return !isIgnored(path.normalize(uriToFilePath(u)))
      })
    }
    case 'rename': {
      if (result == null || typeof result !== 'object') return result
      return filterWorkspaceEditByGitignore(result as Record<string, unknown>, isIgnored)
    }
    case 'formatting':
    case 'codeAction': {
      // codeAction items may embed workspace edits; leave as-is (summaries are formatted in output).
      return result
    }
    default:
      return result
  }
}

export function noLspServerResult(operation: LSPOperation, absolutePath: string): ToolResult {
  return {
    success: false,
    error:
      `No LSP server available for ${path.extname(absolutePath)} files. ` +
      `Operation '${operation}' requires a configured language server.\n` +
      'Configure servers in .lsp.json or the Settings dialog.',
  }
}
