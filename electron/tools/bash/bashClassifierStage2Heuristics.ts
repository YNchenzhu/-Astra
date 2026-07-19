/**
 * Stage-2 style checks for `auto` permission mode (report §5.8 / TRANSCRIPT_CLASSIFIER 等价物).
 * Stage-1 uses static validators; this layer flags **inline interpreters** and a few obfuscation patterns
 * that can still look "read-only" to the primary analyzer but are not safe to auto-approve.
 */

export type Stage2ShellKind = 'posix' | 'powershell'

function normalizeForScan(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * When true, `classifyBashCommand` should treat the command as non-auto-approvable (prompt user).
 */
export function transcriptStyleRiskHeuristic(command: string, shellKind: Stage2ShellKind): boolean {
  const c = normalizeForScan(command)
  if (!c) return false

  if (shellKind === 'powershell') {
    const lower = c.toLowerCase()
    if (/\biex\b/i.test(c) || /\binvoke-expression\b/i.test(lower)) return true
    if (/\bpowershell(?:\.exe)?\b.*\s-(?:enc|e|encodedcommand)\b/i.test(lower)) return true
    if (/\bnode(?:\.exe)?\b.*\s(-e|--eval)\b/i.test(lower)) return true
    if (/\bpython(?:\d+)?(?:\.exe)?\b.*\s-c\b/i.test(lower)) return true
    if (/\bperl(?:\.exe)?\b.*\s-[eE]\b/.test(c)) return true
    if (/\bruby(?:\.exe)?\b.*\s-e\b/i.test(lower)) return true
    if (/\bbase64\b.*\b(?:-d|--decode)\b/i.test(lower)) return true
    return false
  }

  const lower = c.toLowerCase()
  if (/\bpython3?\b[^\n;&|]*\s-c\b/.test(lower)) return true
  if (/\bnode\b[^\n;&|]*\s(--eval|-e)\b/.test(lower)) return true
  if (/\bruby\b[^\n;&|]*\s-e\b/.test(lower)) return true
  if (/\bperl\b[^\n;&|]*\s-[eE]\b/.test(c)) return true
  if (/\bbase64\b[^\n;&|]*\b(?:-d|--decode)\b/.test(lower)) return true
  if (/\beval\b[^\n;&|]*['"`]/.test(lower)) return true
  if (/\$\(\s*base64\s/.test(lower)) return true
  return false
}
