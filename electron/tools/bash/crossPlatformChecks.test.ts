import { describe, it, expect } from 'vitest'
import {
  checkPython3OnWindows,
  checkMultilineDashC,
  checkUnclosedQuotes,
  runCrossPlatformChecks,
} from './crossPlatformChecks'
import { BashSecurityCode as BC } from './bashCodes'

describe('checkPython3OnWindows', () => {
  it('warns on bare python3 invocation on win32', () => {
    const f = checkPython3OnWindows('python3 -c "print(1)"', 'win32')
    expect(f?.verdict).toBe('warn')
    expect(f?.code).toBe(BC.XP_PYTHON3_ON_WINDOWS)
    expect(f?.reason).toMatch(/python3/)
  })

  it('warns on chained python3 on win32', () => {
    expect(checkPython3OnWindows('cd src && python3 -V', 'win32')).not.toBeNull()
    expect(checkPython3OnWindows('ls ; python3 x.py', 'win32')).not.toBeNull()
    expect(checkPython3OnWindows('echo hi | python3', 'win32')).not.toBeNull()
  })

  it('does NOT warn on linux / darwin', () => {
    expect(checkPython3OnWindows('python3 -c "x"', 'linux')).toBeNull()
    expect(checkPython3OnWindows('python3 -c "x"', 'darwin')).toBeNull()
  })

  it('does NOT warn when python3 only appears inside a quoted string', () => {
    // `python3` is a substring of a quoted arg, not the command itself.
    expect(checkPython3OnWindows('echo "use python3 -c"', 'win32')).toBeNull()
    expect(checkPython3OnWindows("echo 'python3 rocks'", 'win32')).toBeNull()
  })

  it('does NOT warn on python (no 3) or py', () => {
    expect(checkPython3OnWindows('python -V', 'win32')).toBeNull()
    expect(checkPython3OnWindows('py -3 script.py', 'win32')).toBeNull()
  })

  it('matches python3.exe on win32', () => {
    expect(checkPython3OnWindows('python3.exe -V', 'win32')).not.toBeNull()
  })
})

describe('checkMultilineDashC', () => {
  it('warns on python3 -c with embedded newline', () => {
    const cmd = 'python3 -c "\nimport sys\nprint(sys.version)\n"'
    const f = checkMultilineDashC(cmd)
    expect(f?.verdict).toBe('warn')
    expect(f?.code).toBe(BC.XP_MULTILINE_DASH_C)
    expect(f?.reason).toMatch(/python3/)
  })

  it('warns on bash -c with embedded newline', () => {
    const cmd = 'bash -c "echo 1\necho 2"'
    expect(checkMultilineDashC(cmd)).not.toBeNull()
  })

  it('does NOT warn on single-line -c calls', () => {
    expect(checkMultilineDashC('python -c "print(1)"')).toBeNull()
    expect(checkMultilineDashC('bash -c \'echo hi\'')).toBeNull()
  })

  it('detects CR line endings too', () => {
    const cmd = 'python -c "a\rprint(1)"'
    expect(checkMultilineDashC(cmd)).not.toBeNull()
  })
})

describe('checkUnclosedQuotes', () => {
  it('denies unclosed double quote', () => {
    const f = checkUnclosedQuotes('echo "hello')
    expect(f?.verdict).toBe('deny')
    expect(f?.code).toBe(BC.XP_UNCLOSED_QUOTE)
    expect(f?.reason).toMatch(/双引号/)
  })

  it('denies unclosed single quote', () => {
    const f = checkUnclosedQuotes("echo 'hello")
    expect(f?.verdict).toBe('deny')
    expect(f?.reason).toMatch(/单引号/)
  })

  it('denies unclosed backtick', () => {
    const f = checkUnclosedQuotes('echo `whoami')
    expect(f?.verdict).toBe('deny')
    expect(f?.reason).toMatch(/反引号/)
  })

  it('allows apostrophe inside double-quoted string', () => {
    // `"it's"` — single quote is literal inside double quotes.
    expect(checkUnclosedQuotes('echo "it\'s fine"')).toBeNull()
  })

  it('allows escaped quotes in double-quoted context', () => {
    expect(checkUnclosedQuotes('echo "say \\"hi\\""')).toBeNull()
  })

  it('allows literal backslash in single-quoted (POSIX: no escape)', () => {
    // `'\''` is the POSIX idiom for an embedded single quote.
    // Here we just confirm an ordinary `'foo\bar'` parses cleanly (closed).
    expect(checkUnclosedQuotes("echo 'foo\\bar'")).toBeNull()
  })

  it('allows balanced nested scenarios', () => {
    expect(checkUnclosedQuotes('echo "a" \'b\' `c`')).toBeNull()
  })

  it('correctly handles truncated command (the original bug trigger)', () => {
    // `for i in r...` — the user report showed an unfinished Python body
    // sitting inside a truncated double-quoted -c string.
    const cmd = 'python3 -c "\nfor i in r...'
    const f = checkUnclosedQuotes(cmd)
    expect(f?.verdict).toBe('deny')
  })
})

describe('runCrossPlatformChecks', () => {
  it('prioritises unclosed-quote deny and skips other heuristics', () => {
    const cmd = 'python3 -c "broken'
    const findings = runCrossPlatformChecks(cmd, 'win32')
    expect(findings.length).toBe(1)
    expect(findings[0]!.code).toBe(BC.XP_UNCLOSED_QUOTE)
  })

  it('escalates python3 + multiline -c on win32 into a single deny finding', () => {
    // Doomed combo: `python3.exe` likely missing AND embedded newlines mangle
    // across PowerShell / cmd. Previously this returned two warns and the
    // child silently exited 9009/49; now it denies pre-execution with a
    // concrete `py -3 -c` / script-file suggestion in the reason.
    const cmd = 'python3 -c "\nprint(1)\n"'
    const findings = runCrossPlatformChecks(cmd, 'win32')
    expect(findings.length).toBe(1)
    expect(findings[0]!.code).toBe(BC.XP_PYTHON3_DASHC_MULTILINE_ON_WINDOWS)
    expect(findings[0]!.verdict).toBe('deny')
    expect(findings[0]!.reason).toMatch(/py -3 -c/)
    // The individual warn codes must NOT also be present — escalation
    // REPLACES them so the model sees a single coherent reason.
    expect(findings.map((f) => f.code)).not.toContain(BC.XP_PYTHON3_ON_WINDOWS)
    expect(findings.map((f) => f.code)).not.toContain(BC.XP_MULTILINE_DASH_C)
  })

  it('does NOT escalate on linux even when both heuristics would individually warn', () => {
    // On linux/darwin `python3` is the canonical name and -c multi-line is
    // bash-safe; we keep the historical warn-only signal for the multi-line
    // case (no python3 warning on non-win32 platforms).
    const cmd = 'python3 -c "\nprint(1)\n"'
    const findings = runCrossPlatformChecks(cmd, 'linux')
    expect(findings.map((f) => f.code)).toEqual([BC.XP_MULTILINE_DASH_C])
    expect(findings[0]!.verdict).toBe('warn')
  })

  it('keeps single-line python3 -c as a plain warn on win32 (no escalation)', () => {
    // Single-line `python3 -c "print(1)"` is recoverable: if `python3.exe`
    // resolves via py launcher / Microsoft Store the command succeeds, and
    // when it does fail the existing `appendPreExecutionWarnings` post-mortem
    // already surfaces the warn-level hint. Escalation only fires for the
    // multi-line variant.
    const findings = runCrossPlatformChecks('python3 -c "print(1)"', 'win32')
    expect(findings.map((f) => f.code)).toEqual([BC.XP_PYTHON3_ON_WINDOWS])
    expect(findings[0]!.verdict).toBe('warn')
  })

  it('returns nothing for clean commands', () => {
    expect(runCrossPlatformChecks('echo hi', 'win32')).toEqual([])
    expect(runCrossPlatformChecks('ls -la', 'linux')).toEqual([])
  })
})
