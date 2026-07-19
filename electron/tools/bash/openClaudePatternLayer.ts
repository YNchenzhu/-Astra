/**
 * Regex-level defenses inspired by upstream `BashTool/bashSecurity.ts`
 * (COMMAND_SUBSTITUTION_PATTERNS, ZSH_DANGEROUS_COMMANDS, heredoc-in-subst).
 * We do not ship tree-sitter / full shellQuote here — this is a fail-closed subset.
 */

import type { BashSecurityCode } from './bashCodes'
import { BashSecurityCode as C } from './bashCodes'
import { appendCode } from './commandAnalysis'

const HEREDOC_IN_SUBSTITUTION = /\$\([^)]*<</

const COMMAND_SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /=\(/, message: 'Zsh process substitution =()' },
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, message: 'Zsh equals expansion (=cmd)' },
  { pattern: /\$\[/, message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/, message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/, message: 'Zsh glob qualifier with command execution' },
  {
    pattern: /\}\s*always\s*\{/,
    message: 'Zsh always block (try/always construct)',
  },
  { pattern: /<#/, message: 'PowerShell block comment <# (defense in depth)' },
]

export const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

export function applyOpenClaudeStylePatternDenies(
  command: string,
  codes: BashSecurityCode[],
  reasons: string[],
): void {
  if (HEREDOC_IN_SUBSTITUTION.test(command)) {
    appendCode(codes, C.OC_HEREDOC_IN_SUBST)
    reasons.push('Heredoc inside command substitution — blocked (OpenClaude-class pattern)')
  }

  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(command)) {
      appendCode(codes, C.OC_SHELL_METASYNTAX)
      reasons.push(`Blocked shell metasyntax: ${message}`)
    }
  }
}

export function isZshDangerousBuiltin(basenameLower: string): boolean {
  return ZSH_DANGEROUS_COMMANDS.has(basenameLower)
}
