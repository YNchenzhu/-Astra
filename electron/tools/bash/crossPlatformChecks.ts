/**
 * Cross-platform executability checks — orchestration-layer guards that fire
 * BEFORE a shell is spawned so the model receives an actionable, deterministic
 * error instead of a silent `Task <id> failed (exit …):` from the child.
 *
 * These checks exist because we observed agents burning retries on:
 *
 *   - `python3 -c "…"` on Windows where only `python` / `py` exist (spawn
 *     succeeds via shell resolution but exits 9009 with empty stderr).
 *   - `<cmd> -c "multi\nline"` written bash-style but routed to PowerShell /
 *     cmd, where the embedded newline breaks the tokenizer silently.
 *   - Unclosed quotes / backticks that even bash refuses to parse but the
 *     runner used to swallow the parse error.
 *
 * Each helper returns `null` when the command looks clean, or an object
 * describing a warn/deny verdict and a machine-readable code.
 */

import { BashSecurityCode as BC, type BashSecurityCode } from './bashCodes'
import type { SecurityVerdict } from './bashCodes'

export type CrossPlatformFinding = {
  code: BashSecurityCode
  reason: string
  verdict: SecurityVerdict
}

/**
 * `python3` is the default interpreter name on Linux / macOS, but on default
 * Windows installs only `python` or `py` exist. The ambiguity alone would be
 * harmless, but when the child exits 9009 ("program not found") with empty
 * stderr it looks identical to a transient failure and the model retries.
 *
 * We intentionally DON'T match quoted occurrences (e.g. `echo "python3"`),
 * only an actual command-position token.
 */
export function checkPython3OnWindows(
  command: string,
  platform: NodeJS.Platform,
): CrossPlatformFinding | null {
  if (platform !== 'win32') return null
  // Match `python3` as a command-position token: start of line, after a
  // pipe/chain operator, or after `&&` / `||` / `;` / leading whitespace.
  // Exclude quoted contexts by requiring the token be followed by end-of-input,
  // whitespace, or a command arg.
  const re = /(?:^|[|;&]|&&|\|\||\s)\s*python3(?:\.exe)?(?=\s|$|")/i
  // Quick reject if `python3` doesn't appear at all.
  if (!/python3/i.test(command)) return null
  // Also skip when it only appears inside a quoted string whose owner is NOT
  // `python3` itself (e.g. `echo "use python3 -c"`). Heuristic: strip single
  // and double quoted substrings, THEN re-check.
  const dequoted = command
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  if (!re.test(dequoted)) return null
  return {
    code: BC.XP_PYTHON3_ON_WINDOWS,
    verdict: 'warn',
    reason:
      'Windows 默认仅安装 `python` 或 `py` — `python3` 常不存在且会以 exit 9009 + 空 stderr 失败。' +
      '请改用 `python` 或 `py -3`（或先用 `where python3` 确认存在）。',
  }
}

/**
 * Detect `<interpreter> -c "..."` where the quoted body contains a literal
 * newline. Bash-style multi-line heredoc-in-a-string is valid POSIX but gets
 * mangled when the tool routing picks PowerShell / cmd (different escape
 * rules, different line-continuation semantics).
 *
 * Warn rather than deny: single-line `-c` calls are fine, and some multi-line
 * uses ARE intentional when the caller knows the shell.
 */
export function checkMultilineDashC(command: string): CrossPlatformFinding | null {
  // Match `<name> -c "..."` or `<name> -c '...'` where the body contains \n.
  const re = /\b([A-Za-z_][\w.-]*)\s+-c\s+(["'])([\s\S]*?)\2/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    const body = m[3]
    if (body.includes('\n') || body.includes('\r')) {
      return {
        code: BC.XP_MULTILINE_DASH_C,
        verdict: 'warn',
        reason:
          `检测到 \`${m[1]} -c\` 带多行字符串 — 不同 shell（PowerShell / cmd / bash）对内嵌换行和 ` +
          `转义的处理规则不同，容易在 Windows 上静默失败。请改写为单行（用 \`;\` 分隔语句）或写成一个脚本文件再执行。`,
      }
    }
  }
  return null
}

/**
 * Detect syntactically unclosed quotes. We count unescaped `"` and `'`
 * occurrences and flag an odd total as unparseable. `\"` and `\'` are ignored.
 * Dollar-single-quoted strings (`$'...'`) count as single-quoted.
 *
 * False-positive-avoidance: ignore a lone apostrophe inside a double-quoted
 * string (e.g. `"it's"`), by tokenising quotes with a small state machine.
 */
export function checkUnclosedQuotes(command: string): CrossPlatformFinding | null {
  let i = 0
  let state: 'none' | 'sq' | 'dq' | 'bt' = 'none'
  while (i < command.length) {
    const c = command[i]
    if (state === 'none') {
      if (c === '\\' && i + 1 < command.length) {
        // Escape in unquoted context — skip next char.
        i += 2
        continue
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'bt'
    } else if (state === 'sq') {
      // POSIX single quotes have no escaping — `\` is literal.
      if (c === "'") state = 'none'
    } else if (state === 'dq') {
      if (c === '\\' && i + 1 < command.length) {
        i += 2
        continue
      }
      if (c === '"') state = 'none'
    } else if (state === 'bt') {
      if (c === '\\' && i + 1 < command.length) {
        i += 2
        continue
      }
      if (c === '`') state = 'none'
    }
    i += 1
  }
  if (state !== 'none') {
    const label =
      state === 'sq' ? '单引号 (\')' : state === 'dq' ? '双引号 (")' : '反引号 (`)'
    return {
      code: BC.XP_UNCLOSED_QUOTE,
      verdict: 'deny',
      reason:
        `命令中${label}未闭合 — 无论哪个 shell 都会解析失败。请补齐配对的引号或将多行命令改写为脚本文件后再执行。`,
    }
  }
  return null
}

/**
 * Run all cross-platform checks against a command, returning every finding
 * that triggered. Callers decide how to aggregate verdicts (warn vs deny).
 *
 * Verdict escalation: when BOTH `python3` (command position) AND a multi-line
 * `-c "..."` body are present on Windows, the two warn-level findings are
 * collapsed into a single `XP_PYTHON3_DASHC_MULTILINE_ON_WINDOWS` deny
 * finding. Rationale: each warn alone leaves room for the command to
 * succeed (python3.exe might exist via py launcher; single-line -c usually
 * parses fine), but the combination is reliably doomed and the previous
 * warn-only behavior caused agents to retry the same invocation after the
 * silent exit 9009 / 49.
 */
export function runCrossPlatformChecks(
  command: string,
  platform: NodeJS.Platform = process.platform,
): CrossPlatformFinding[] {
  const findings: CrossPlatformFinding[] = []
  const q = checkUnclosedQuotes(command)
  if (q) findings.push(q)
  // Only emit the python3 / multiline warnings when the command is parseable;
  // unbalanced quotes will change what the heuristics "see" and can mislead.
  if (!q) {
    const p = checkPython3OnWindows(command, platform)
    const m = checkMultilineDashC(command)
    if (p && m && platform === 'win32') {
      findings.push({
        code: BC.XP_PYTHON3_DASHC_MULTILINE_ON_WINDOWS,
        verdict: 'deny',
        reason:
          '检测到 Windows + `python3 -c "<多行脚本>"` 组合 — 这是已知的静默失败模式：' +
          '(a) `python3.exe` 在默认 Windows 安装上通常不存在（应使用 `python` 或 `py -3`）；' +
          '(b) `-c` 内嵌换行在 PowerShell / cmd 下转义规则不同，容易被截断成空命令并以 exit 9009 / 49 + 空 stderr 退出。' +
          '请改写为 `py -3 -c "<单行;语句;用分号串联>"`，或把脚本写入 `.py` 文件后执行 `python script.py` / `py -3 script.py`。',
      })
    } else {
      if (p) findings.push(p)
      if (m) findings.push(m)
    }
  }
  return findings
}
