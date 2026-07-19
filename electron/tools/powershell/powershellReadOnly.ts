/**
 * Read-only pipeline heuristic for PowerShell concurrency (upstream readOnlyValidation analogue, subset).
 */

const PS_READ_KEYWORDS = new Set([
  'if',
  'foreach',
  'for',
  'while',
  'switch',
  'try',
  'catch',
  'param',
  'function',
  'filter',
  'class',
  'enum',
  'begin',
  'process',
  'end',
])

/** Cmdlets / aliases considered read-only for parallel tool execution. */
const PS_READ_ONLY_CMDLETS = new Set([
  'get-content',
  'gc',
  'type',
  'cat',
  'get-childitem',
  'gci',
  'ls',
  'dir',
  'get-item',
  'gi',
  'select-string',
  'sls',
  'get-process',
  'gps',
  'get-service',
  'get-location',
  'gl',
  'pwd',
  'test-path',
  'resolve-path',
  'measure-object',
  'compare-object',
  'where-object',
  '?',
  'sort-object',
  'format-list',
  'fl',
  'format-table',
  'ft',
  'format-wide',
  'fw',
  'format-custom',
  'fc',
  'out-string',
  'out-default',
  'out-null',
  'get-date',
  'get-verb',
  'get-command',
  'get-help',
  'get-member',
  'gm',
  'select-object',
  'group-object',
  'select-object',
  'where-object',
  'get-clipboard',
  'get-psdrive',
  'get-psprovider',
  'get-variable',
  'gv',
  'echo',
  'write-host',
  'write-output',
])

function firstCmdletInSegment(segment: string): string | null {
  const t = segment.trim()
  if (!t || t.startsWith('#')) return null
  if (t.startsWith('{')) return null
  const m = t.match(/^\s*(?:\d*>\s*)?(?:&\s*)?([A-Za-z_][\w-]*)/)
  if (!m) return null
  return m[1].toLowerCase()
}

/**
 * True when every `|` / `;` segment starts with an allow-listed read cmdlet (heuristic).
 */
export function isPowerShellPipelineReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const segments = trimmed.split(/\s*[|;]\s*/).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return false
  for (const seg of segments) {
    const cmd = firstCmdletInSegment(seg)
    if (cmd == null) return false
    if (PS_READ_KEYWORDS.has(cmd)) return false
    if (!PS_READ_ONLY_CMDLETS.has(cmd)) return false
  }
  return true
}
