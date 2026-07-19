import path from 'node:path'
import type { BashSecurityCode } from './bashCodes'
import { BashSecurityCode as BC } from './bashCodes'
import type { SecurityVerdict } from './bashCodes'
import {
  analyzeCommand,
  appendCode,
  BASH_STYLE_BACKTICK_SUBSTITUTION,
  countStructuralChainOperators,
  DANGEROUS_COMMANDS,
  READ_ONLY_COMMANDS,
  WARN_COMMANDS,
  type CommandAnalysis,
} from './commandAnalysis'
import { getDestructiveCommandWarning } from './destructiveHints'
import {
  applyOpenClaudeStylePatternDenies,
  isZshDangerousBuiltin,
} from './openClaudePatternLayer'
import { applyDangerousPathDeny, computePerSegmentCwds } from './pathDanger'
import { applyJqSystemDeny, applySedInplaceWarn } from './sedAndJqHeuristics'
import { runCrossPlatformChecks } from './crossPlatformChecks'
import { getPrimaryWorkspaceRoot } from '../../security/workspaceAccess'

export type { CommandAnalysis } from './commandAnalysis'
export { analyzeCommand, countStructuralChainOperators, BASH_STYLE_BACKTICK_SUBSTITUTION }

export interface ValidateBashCommandOptions {
  defaultShell?: 'bash' | 'powershell' | 'cmd' | 'zsh'
  /** Working directory for static path danger checks (rmdir/mv). Defaults to workspace root or `process.cwd()`. */
  cwd?: string
  /**
   * When validating from {@link validatePowerShellCommand}: skip bash-only metasyntax/jq/sed,
   * keep shared chain/env/pipe checks. Avoids false positives on PowerShell syntax.
   */
  companionForPowerShell?: boolean
  /**
   * Override `process.platform` for deterministic testing of the Windows-only
   * cross-platform heuristics (e.g. `python3` on win32). Production callers
   * should leave this undefined so the live platform is used.
   */
  platform?: NodeJS.Platform
}

export interface SecurityAnalysis {
  verdict: SecurityVerdict
  reasons: string[]
  codes: BashSecurityCode[]
  isReadOnly: boolean
  commandAnalysis: CommandAnalysis[]
}

function resolveValidationCwd(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim()) {
    return path.resolve(explicit.trim())
  }
  const root = getPrimaryWorkspaceRoot()
  return root ?? process.cwd()
}

/**
 * Validates shell command safety (chain-of-validators).
 * upstream BashTool uses AST + permissions UI; we implement a main-process-safe subset + path/sed/jq layers.
 */
export function validateBashCommand(
  command: string,
  opts?: ValidateBashCommandOptions,
): SecurityAnalysis {
  const reasons: string[] = []
  const codes: BashSecurityCode[] = []
  let verdict: SecurityVerdict = 'allow'
  let isReadOnly = true

  // Tracks how many of `reasons` are deny-grade (legacy string/command
  // checks). Warn-only findings (e.g. cross-platform heuristics) append a
  // reason but are NOT counted here, so the historical
  // `denyReasonCount > 0 → verdict = 'deny'` rule below stays intact.
  let denyReasonCount = 0
  const add = (code: BashSecurityCode, reason: string): void => {
    appendCode(codes, code)
    reasons.push(reason)
    denyReasonCount += 1
  }
  const addWarn = (code: BashSecurityCode, reason: string): void => {
    appendCode(codes, code)
    reasons.push(reason)
    if (verdict !== 'deny') verdict = 'warn'
  }

  const relaxBackticksForPowerShell =
    opts?.defaultShell === 'powershell' || opts?.companionForPowerShell === true
  const companionPs = opts?.companionForPowerShell === true
  const cwd = resolveValidationCwd(opts?.cwd)

  // Cross-platform executability guards — run first so unparseable commands
  // (unclosed quotes) deny immediately without the later heuristics getting
  // misled by unbalanced tokens. Warn-level findings go through `addWarn`
  // and won't trip the blanket deny rule further down.
  const xpFindings = runCrossPlatformChecks(command, opts?.platform ?? process.platform)
  for (const f of xpFindings) {
    if (f.verdict === 'deny') {
      add(f.code, f.reason)
      verdict = 'deny'
      isReadOnly = false
    } else {
      addWarn(f.code, f.reason)
    }
  }

  if (!relaxBackticksForPowerShell && BASH_STYLE_BACKTICK_SUBSTITUTION.test(command)) {
    add(BC.STRING_BACKTICK, '检测到反引号命令替换 - 可能存在注入风险')
  }
  if (/\$\([^)]*\$\(/.test(command)) {
    add(BC.STRING_NESTED_SUBST, '检测到嵌套命令替换 - 可能存在注入风险')
  }
  if (/\$(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|IFS|PS1|PS2|PROMPT_COMMAND)/.test(command)) {
    add(BC.STRING_SENSITIVE_ENV, '检测到敏感环境变量引用 - 可能存在劫持风险')
  }
  if (relaxBackticksForPowerShell && /\$env\s*:\s*(?:PATH|PATHEXT|PSModulePath|COMSPEC)\b/i.test(command)) {
    add(BC.STRING_SENSITIVE_ENV, 'PowerShell: 引用关键环境驱动器 ($env:PATH 等) — 可能被用于劫持执行路径')
  }
  if (/\|\s*(?:sh|bash|zsh|ksh)(?:\s|$)/.test(command)) {
    add(BC.STRING_PIPE_TO_SHELL, '检测到管道到 shell 解释器 - 高风险')
  }
  if (relaxBackticksForPowerShell) {
    if (/\|\s*(?:pwsh|powershell)(?:\.exe)?\b/i.test(command)) {
      add(BC.STRING_PIPE_TO_SHELL, '检测到管道到 PowerShell 子进程 - 无法静态验证嵌套脚本')
    }
    if (/\|\s*cmd(?:\.exe)?\b/i.test(command)) {
      add(BC.STRING_PIPE_TO_SHELL, '检测到管道到 cmd - 高风险')
    }
  }
  if (/(?:^|\||;|&&|\|\|)\s*(?:\/?(?:usr\/)?(?:local\/)?s?bin\/)?(?:bash|dash|zsh|ksh|sh)\s+-c\s/i.test(command)) {
    add(BC.STRING_PIPE_TO_SHELL, '检测到通过 shell -c 直接执行命令 - 高风险')
  }
  if (/(?:eval|source|\.)\s+\$/.test(command)) {
    add(BC.STRING_EVAL_SOURCE, '检测到 eval/source 动态执行 - 高风险')
  }
  if (/(?:^|\||;|&&|\|\|)\s*eval\s+['"`]/.test(command)) {
    add(BC.STRING_EVAL_SOURCE, '检测到 eval 执行 - 高风险')
  }
  // Audit B-P0-3b (raw-string layer): inline interpreter payloads are often
  // split mid-payload by the segment analyzer (`;` inside quotes), so scan
  // the raw command here in addition to the per-segment check below.
  const rawInlineDestructive = findDestructiveInlineInRawCommand(command)
  if (rawInlineDestructive) {
    add(BC.INLINE_INTERPRETER_DESTRUCTIVE, rawInlineDestructive)
  }

  const chainCount = countStructuralChainOperators(command)
  if (chainCount > 14) {
    add(
      BC.STRING_LONG_CHAIN,
      `检测到过长的命令链（${chainCount} 个链接操作符: ; && || |）- 可能隐藏恶意命令`,
    )
  }

  if (!companionPs) {
    const before = reasons.length
    applyOpenClaudeStylePatternDenies(command, codes, reasons)
    applyJqSystemDeny(command, codes, reasons)
    denyReasonCount += reasons.length - before
  }

  // Audit B-P0-1: single-level `$(...)` bodies get the same hard-deny scans
  // as top-level segments (nested substitution was already denied above,
  // but `echo $(rm -rf /)` used to sail through as read-only `echo`).
  for (const finding of scanCommandSubstitutionBodies(command, companionPs)) {
    add(finding.code, finding.reason)
  }

  if (denyReasonCount > 0) {
    verdict = 'deny'
  }

  const commandAnalysis = analyzeCommand(command)
  // Audit B-P0-4: simulate `cd` so path checks resolve each segment's
  // targets against the directory that segment actually runs in.
  const perSegmentCwds = computePerSegmentCwds(cwd, commandAnalysis)

  if (verdict !== 'deny') {
    if (applyDangerousPathDeny(cwd, commandAnalysis, codes, reasons, perSegmentCwds)) {
      verdict = 'deny'
    }
  }

  for (const analysis of commandAnalysis) {
    const cmdName = analysis.commandBaseName.toLowerCase()

    if (isZshDangerousBuiltin(cmdName)) {
      add(BC.OC_ZSH_DANGEROUS_BUILTIN, `Zsh 危险内建/模块命令: ${cmdName}`)
      verdict = 'deny'
      isReadOnly = false
      continue
    }

    // Audit B-P0-2: wrapper binaries (`command`/`env`/`busybox`/`xargs`/
    // `sudo`/…) forwarding to a blacklisted binary.
    const wrappedDanger = findWrappedDangerousCommand(cmdName, analysis.args, companionPs)
    if (wrappedDanger) {
      add(
        BC.WRAPPED_DANGEROUS_COMMAND,
        `通过包装命令 "${cmdName}" 调用危险命令 "${wrappedDanger}" - 拒绝执行`,
      )
      verdict = 'deny'
      isReadOnly = false
      continue
    }

    // Audit B-P0-3a: `find -delete` / `find -exec rm …`.
    const findDestructive = findDestructiveFindUsage(cmdName, analysis.args)
    if (findDestructive) {
      add(BC.FIND_DESTRUCTIVE, findDestructive)
      verdict = 'deny'
      isReadOnly = false
      continue
    }

    // Audit B-P0-3b: inline interpreter payloads with destructive APIs
    // (`python -c "shutil.rmtree(...)"`, `node -e "fs.rmSync(...)"`, …).
    const inlineDestructive = findDestructiveInlinePayload(cmdName, analysis.args)
    if (inlineDestructive) {
      add(BC.INLINE_INTERPRETER_DESTRUCTIVE, inlineDestructive)
      verdict = 'deny'
      isReadOnly = false
      continue
    }

    if (DANGEROUS_COMMANDS.has(cmdName)) {
      const psRemoveFamily = new Set([
        'rm',
        'rmdir',
        'del',
        'erase',
        'rd',
        'ri',
        'remove-item',
      ])
      if (companionPs && psRemoveFamily.has(cmdName)) {
        /* PowerShell tool only: aliases map to Remove-Item, not Unix rm — path checks in PS validator */
      } else {
        add(BC.DANGEROUS_COMMAND, `命令 "${cmdName}" 在危险命令黑名单中`)
        // Layer the per-command specialty codes here, in addition to the
        // generic DANGEROUS_COMMAND. The standalone checks lower down in
        // this loop (`if (cmdName === 'rm' …)` / `if (cmdName === 'dd')`)
        // were previously unreachable for `rm`/`dd` because this block
        // `continue`s before them, leaving callers / tests / telemetry
        // that branch on `WARN_RM_RECURSIVE` or `DENY_DD` blind. Tests
        // B9 / B15 require both codes on a single result; production
        // permission UIs likewise want the precise reason in addition
        // to the blacklist hit.
        if ((cmdName === 'rm' || cmdName === 'rmdir')
            && analysis.args.some((arg) => arg === '-r' || arg === '-R' || arg === '-rf' || arg === '-fr')) {
          add(BC.WARN_RM_RECURSIVE, '警告：rm -r 递归删除 - 高风险')
        } else if (cmdName === 'dd') {
          add(BC.DENY_DD, '命令 "dd" 可能导致数据丢失 - 拒绝执行')
        }
        verdict = 'deny'
        isReadOnly = false
        continue
      }
    }

    if (WARN_COMMANDS.has(cmdName)) {
      if (cmdName === 'git') {
        const fullCmd = `${analysis.commandName} ${analysis.args.join(' ')}`
        if (/^git\s+(status|log|diff|show|branch|tag|remote)/.test(fullCmd)) {
          continue
        }
      }

      if (cmdName === 'chmod' && analysis.args.some((arg) => arg.includes('777'))) {
        add(BC.WARN_CHMOD_777, '警告：chmod 777 权限过于宽松')
        verdict = verdict === 'deny' ? 'deny' : 'warn'
        isReadOnly = false
        continue
      }

      if (cmdName === 'kill' || cmdName === 'killall' || cmdName === 'pkill') {
        if (analysis.args.some((arg) => arg === '-9')) {
          add(BC.WARN_KILL_SIGKILL, '警告：使用 -9 强制杀进程 - 可能导致数据丢失')
          verdict = verdict === 'deny' ? 'deny' : 'warn'
          isReadOnly = false
          continue
        }
      }

      if (cmdName === 'git' && /^git\s+push/.test(`${analysis.commandName} ${analysis.args.join(' ')}`)) {
        if (analysis.args.some((arg) => arg === '--force' || arg === '-f')) {
          add(BC.WARN_GIT_PUSH_FORCE, '警告：git push --force 可能覆盖他人工作')
          verdict = verdict === 'deny' ? 'deny' : 'warn'
          isReadOnly = false
          continue
        }
      }

      add(BC.WARN_COMMAND, `命令 "${cmdName}" 需要谨慎使用`)
      verdict = verdict === 'deny' ? 'deny' : 'warn'
      isReadOnly = false
      continue
    }

    if (!READ_ONLY_COMMANDS.has(cmdName)) {
      isReadOnly = false
    }

    // NOTE: standalone `rm`/`rmdir`/`dd` blocks used to live here. They
    // were unreachable: those commands are members of DANGEROUS_COMMANDS
    // and the branch above `continue`s before this point. The specialty
    // codes (`WARN_RM_RECURSIVE`, `DENY_DD`) are now layered alongside
    // the generic `DANGEROUS_COMMAND` code in the dangerous-commands
    // branch above (see L192-201 comment). Keeping the dead duplicates
    // here invited drift between the two paths.

    if (companionPs) {
      const psRm = new Set(['remove-item', 'rm', 'rmdir', 'del', 'erase', 'rd', 'ri'])
      if (psRm.has(cmdName)) {
        const a = analysis.args.map((x) => x.toLowerCase())
        const hasRecurse = a.some(
          (x) => x === '-recurse' || x.startsWith('-recur') || (x.startsWith('-') && /^-r[a-z]*e/.test(x)),
        )
        if (hasRecurse) {
          add(BC.WARN_RM_RECURSIVE, '警告：PowerShell Remove-Item -Recurse — 高风险递归删除')
          verdict = verdict === 'deny' ? 'deny' : 'warn'
          isReadOnly = false
        }
      }
    }

    if (cmdName === 'curl' || cmdName === 'wget') {
      if (analysis.args.some((arg) => arg === '-O' || arg === '--output')) {
        isReadOnly = false
      }
    }
  }

  if (commandAnalysis.length > 1) {
    // Structural classification only — `cd dir && cmd` / `ls | sort` are
    // pervasive and benign. Previously this was emitted via `add()`, so
    // whenever ANOTHER check denied the command the chain reason got
    // bundled into the `reasons.join('; ')` payload the model sees, e.g.
    //   "命令中双引号 (\") 未闭合 …; 检测到命令链（2个命令）- 需要逐个验证"
    // The trailing chain clause is pure process-narration that confused
    // agents into thinking the chain length itself was unsafe. Keep the
    // code in `codes` for tests/telemetry, but do NOT push a reason line.
    appendCode(codes, BC.MULTI_COMMAND_CHAIN)
    isReadOnly = false
  }

  if (!companionPs) {
    applySedInplaceWarn(command, codes, reasons)
    if (codes.includes(BC.SED_INPLACE)) {
      isReadOnly = false
      if (verdict === 'allow') {
        verdict = 'warn'
      }
    }
  }

  const destructiveHint = getDestructiveCommandWarning(command)
  if (destructiveHint) {
    add(BC.DESTRUCTIVE_PATTERN_HINT, destructiveHint)
    if (verdict === 'allow') {
      verdict = 'warn'
    }
  }

  return {
    verdict,
    reasons,
    codes,
    isReadOnly,
    commandAnalysis,
  }
}

export function isCommandReadOnly(command: string): boolean {
  const analysis = validateBashCommand(command, {})
  return analysis.isReadOnly && analysis.verdict === 'allow'
}

// ─── Hard-deny helpers (audit B-P0-1…B-P0-4) ───

/**
 * Wrapper binaries that forward their argv to another executable —
 * `command rm`, `env rm`, `busybox rm`, `xargs rm`, `sudo rm`, … all
 * bypassed the basename blacklist because only the wrapper's own name
 * was matched (audit B-P0-2).
 */
const WRAPPER_COMMANDS = new Set([
  'command',
  'env',
  'busybox',
  'nohup',
  'nice',
  'ionice',
  'time',
  'timeout',
  'stdbuf',
  'setsid',
  'xargs',
  'doas',
  'sudo',
])

/** PowerShell remove-family aliases handled by the PS validator's own path checks. */
const PS_REMOVE_FAMILY = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'remove-item'])

function baseNameOf(token: string): string {
  const first = token.trim().split(/\s+/)[0] ?? ''
  return first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first
}

/**
 * Scan a wrapper command's argv for a blacklisted binary. Returns the
 * dangerous basename or null. `command -v xxx` (existence lookup, harmless
 * and common in scripts) is exempted.
 */
export function findWrappedDangerousCommand(
  cmdBaseName: string,
  args: string[],
  companionPs = false,
): string | null {
  const base = cmdBaseName.toLowerCase()
  if (!WRAPPER_COMMANDS.has(base)) return null
  if (base === 'command' && args.some((a) => a === '-v' || a === '-V')) return null
  for (const arg of args) {
    // Tokenizer strips quotes, so `su -c 'rm -rf /'` arrives as one arg
    // "rm -rf /" — check the first word of every arg, not the whole token.
    const inner = baseNameOf(arg).toLowerCase()
    if (!inner) continue
    if (DANGEROUS_COMMANDS.has(inner)) {
      if (companionPs && PS_REMOVE_FAMILY.has(inner)) continue
      return inner
    }
  }
  return null
}

/**
 * `find` is in READ_ONLY_COMMANDS, but `-delete` / `-exec <dangerous>`
 * make it destructive (audit B-P0-3). Returns a deny reason or null.
 */
export function findDestructiveFindUsage(
  cmdBaseName: string,
  args: string[],
): string | null {
  if (cmdBaseName.toLowerCase() !== 'find') return null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-delete') {
      return 'find -delete 会递归删除匹配文件 - 拒绝执行(请改用明确的文件工具或列出后逐个确认)'
    }
    if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
      const target = args[i + 1] ? baseNameOf(args[i + 1]!).toLowerCase() : ''
      if (target && DANGEROUS_COMMANDS.has(target)) {
        return `find ${a} ${target} 会对匹配文件执行危险命令 - 拒绝执行`
      }
    }
  }
  return null
}

/** Inline interpreter flags per binary (python -c / node -e / …). */
const INLINE_INTERPRETER_FLAGS: Record<string, Set<string>> = {
  python: new Set(['-c']),
  python2: new Set(['-c']),
  python3: new Set(['-c']),
  node: new Set(['-e', '--eval', '-p', '--print']),
  nodejs: new Set(['-e', '--eval', '-p', '--print']),
  bun: new Set(['-e', '--eval']),
  deno: new Set(['eval']),
  ruby: new Set(['-e']),
  perl: new Set(['-e', '-E']),
  php: new Set(['-r']),
}

/**
 * Destructive / exec-capable patterns inside an inline interpreter payload.
 * Deliberately narrow: matches concrete destructive APIs, not the mere use
 * of `-c`/`-e` (which stays allow/warn per existing tests — the auto-
 * permission classifier already prompts for those).
 */
const INLINE_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brmtree\b/i,
  /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs|system)\b/i,
  /\bsubprocess\b/i,
  /\brm(?:dir)?Sync\b/,
  // `unlink(` (JS/py call) or perl-style `unlink glob|$var|"…"` — NOT the
  // bare word (npm scripts like `unlink-check` must not trip this).
  /\bunlink(?:Sync)?\s*\(/i,
  /\bunlink\s+(?:glob\b|['"$@])/i,
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bFileUtils\s*\.\s*rm/i,
  /\bFile\s*\.\s*delete\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bshutil\s*\.\s*(?:rmtree|move)\b/i,
]

/**
 * Returns a deny reason when an inline interpreter payload (`python -c "…"`,
 * `node -e "…"`, …) contains destructive APIs — these looked "read-only" to
 * the basename analyzer (audit B-P0-3). Null when not applicable / clean.
 */
export function findDestructiveInlinePayload(
  cmdBaseName: string,
  args: string[],
): string | null {
  const flags = INLINE_INTERPRETER_FLAGS[cmdBaseName.toLowerCase()]
  if (!flags) return null
  const flagIdx = args.findIndex((a) => flags.has(a))
  if (flagIdx < 0) return null
  const payload = args.slice(flagIdx + 1).join(' ')
  if (!payload) return null
  for (const re of INLINE_DESTRUCTIVE_PATTERNS) {
    if (re.test(payload)) {
      return `内联解释器代码 (${cmdBaseName} ${args[flagIdx]}) 包含删除/进程执行调用 (匹配 ${re.source.slice(0, 40)}) - 拒绝执行`
    }
  }
  return null
}

/**
 * Raw-command variant of {@link findDestructiveInlinePayload}. The segment
 * analyzer splits on `;` even inside quotes, so a payload like
 * `python -c "import shutil; shutil.rmtree('/')"` gets cut in half and the
 * per-segment check never sees the destructive call. Here we locate the
 * interpreter + inline flag in the RAW string and scan everything after it
 * (quotes intact). Over-scanning into a chained tail is acceptable: the
 * patterns are specific destructive APIs, and a genuinely dangerous tail
 * would be denied by its own segment checks anyway.
 */
export function findDestructiveInlineInRawCommand(command: string): string | null {
  const m =
    /\b(python[23]?|node(?:js)?|bun|deno|ruby|perl|php)(?:\.exe)?\b[^\n;|&]*?\s(-c|-e|-E|--eval|-p|--print|-r|eval)\s+([\s\S]+)/.exec(
      command,
    )
  if (!m) return null
  const payload = m[3]!
  for (const re of INLINE_DESTRUCTIVE_PATTERNS) {
    if (re.test(payload)) {
      return `内联解释器代码 (${m[1]} ${m[2]}) 包含删除/进程执行调用 (匹配 ${re.source.slice(0, 40)}) - 拒绝执行`
    }
  }
  return null
}

/**
 * Single-level `$(...)` contents were never analyzed — only NESTED
 * substitution was denied, so `echo $(rm -rf /)` passed (audit B-P0-1).
 * Extract every substitution body and run the same hard-deny scans over
 * its segments. Nested forms are already denied before this runs.
 */
export function scanCommandSubstitutionBodies(
  command: string,
  companionPs = false,
): Array<{ code: BashSecurityCode; reason: string }> {
  const findings: Array<{ code: BashSecurityCode; reason: string }> = []
  const re = /\$\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    const inner = m[1]!.trim()
    if (!inner) continue
    for (const seg of analyzeCommand(inner)) {
      const base = seg.commandBaseName.toLowerCase()
      if (DANGEROUS_COMMANDS.has(base) && !(companionPs && PS_REMOVE_FAMILY.has(base))) {
        findings.push({
          code: BC.DANGEROUS_COMMAND,
          reason: `命令替换 $() 内检测到危险命令 "${base}" - 拒绝执行`,
        })
        continue
      }
      if (isZshDangerousBuiltin(base)) {
        findings.push({
          code: BC.OC_ZSH_DANGEROUS_BUILTIN,
          reason: `命令替换 $() 内检测到危险内建命令 "${base}" - 拒绝执行`,
        })
        continue
      }
      const wrapped = findWrappedDangerousCommand(base, seg.args, companionPs)
      if (wrapped) {
        findings.push({
          code: BC.WRAPPED_DANGEROUS_COMMAND,
          reason: `命令替换 $() 内通过 "${base}" 调用危险命令 "${wrapped}" - 拒绝执行`,
        })
        continue
      }
      const findReason = findDestructiveFindUsage(base, seg.args)
      if (findReason) {
        findings.push({ code: BC.FIND_DESTRUCTIVE, reason: `命令替换 $() 内: ${findReason}` })
        continue
      }
      const inlineReason = findDestructiveInlinePayload(base, seg.args)
      if (inlineReason) {
        findings.push({
          code: BC.INLINE_INTERPRETER_DESTRUCTIVE,
          reason: `命令替换 $() 内: ${inlineReason}`,
        })
      }
    }
  }
  return findings
}
