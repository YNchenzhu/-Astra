import { describe, it, expect } from 'vitest'
import {
  appendPreExecutionWarnings,
  formatShellFailure,
  formatShellFailureDetail,
  formatShellSpawnError,
} from './shellErrorFormat'

/**
 * Regression suite for the empty-error-message bug that caused the agentic
 * loop to retry the same failed command forever. See project memory
 * `session-memory-internal-security-constraints` and the inline rationale in
 * `shellErrorFormat.ts`.
 *
 * The contract these tests pin down:
 *
 *   1. `Task <id> failed (...)` header is ALWAYS present — never empty-tail.
 *   2. exit code is ALWAYS included (even when -1 / ?).
 *   3. when both stderr and stdout are empty, the detail MUST say so
 *      explicitly (so the model does not infer a transient failure).
 *   4. signal (SIGTERM / SIGKILL / …) is propagated when the child was killed.
 */
describe('formatShellFailureDetail', () => {
  it('returns stderr when non-empty', () => {
    expect(formatShellFailureDetail('err!', '', 'echo hi')).toBe('err!')
  })

  it('falls back to stdout when stderr is empty', () => {
    expect(formatShellFailureDetail('', 'out!', 'echo hi')).toBe('out!')
  })

  it('returns sentinel when both streams empty', () => {
    const d = formatShellFailureDetail('', '')
    expect(d).toContain('(no output captured')
  })

  it('includes truncated command echo when both streams empty and echo provided', () => {
    const d = formatShellFailureDetail('', '', 'python3 -c "print(1)"')
    expect(d).toContain('(no output captured')
    expect(d).toContain('silent child process, command:')
    expect(d).toContain('python3 -c')
  })

  it('truncates very long command echoes', () => {
    const longCmd = `cat ${'x'.repeat(500)}`
    const d = formatShellFailureDetail('', '', longCmd)
    // Echo portion should end with ellipsis, total stays bounded.
    expect(d).toMatch(/…/)
    expect(d.length).toBeLessThan(400)
  })

  it('treats whitespace-only streams as empty', () => {
    const d = formatShellFailureDetail('   \n', '\t\t ', 'ls')
    expect(d).toContain('(no output captured')
  })
})

describe('formatShellFailure', () => {
  // Audit D4: `formatShellFailure` now returns ToolFailureFields. The
  // `error` field is byte-identical to the pre-D4 string (model self-
  // correction loop unchanged); structured fields ride along for the
  // renderer's StructuredErrorView.

  it('includes exit code in the header', () => {
    const f = formatShellFailure({
      taskId: 'toolu_abc',
      exitCode: 1,
      stderr: 'oops',
      stdout: '',
    })
    expect(f.error).toMatch(/^Task toolu_abc failed \(exit 1\): oops$/)
    expect(f.toolErrorClass).toBe('shell')
    expect(f.errorContext?.exit_code).toBe(1)
  })

  it('includes signal when the child was killed', () => {
    const f = formatShellFailure({
      taskId: 'toolu_abc',
      exitCode: 143,
      signal: 'SIGTERM',
      stderr: 'terminated',
      stdout: '',
    })
    expect(f.error).toContain('exit 143')
    expect(f.error).toContain('signal SIGTERM')
    expect(f.errorContext?.signal).toBe('SIGTERM')
  })

  it('includes duration when provided', () => {
    const f = formatShellFailure({
      taskId: 't1',
      exitCode: 9009,
      stderr: '',
      stdout: '',
      commandEcho: 'python3 -c "x"',
      durationMs: 42,
    })
    expect(f.error).toContain('42ms')
    expect(f.errorContext?.duration_ms).toBe(42)
  })

  it('renders "exit ?" when exitCode is null', () => {
    const f = formatShellFailure({
      taskId: 't2',
      exitCode: null,
      stderr: 'err',
      stdout: '',
    })
    expect(f.error).toContain('exit ?')
  })

  it('guarantees a non-empty detail even when streams are empty', () => {
    // This is THE regression test — the original bug produced
    // `Task toolu_xxx failed: ` (nothing after the colon).
    const f = formatShellFailure({
      taskId: 'toolu_xxx',
      exitCode: 1,
      stderr: '',
      stdout: '',
      commandEcho: 'python3 -c "multiline"',
    })
    // Must contain the sentinel so the model knows this wasn't transient.
    expect(f.error).toContain('(no output captured')
    // Must NOT end with a bare colon-space (the original failure mode).
    expect(f.error).not.toMatch(/:\s*$/)
  })

  it('escapes multi-line command echoes to a single line', () => {
    const multiline = 'python3 -c "\nimport sys\nprint(sys.version)\n"'
    const f = formatShellFailure({
      taskId: 't',
      exitCode: 1,
      stderr: '',
      stdout: '',
      commandEcho: multiline,
    })
    // Newlines collapsed to single spaces in the echo portion.
    expect(f.error.split('\n').length).toBe(1)
  })

  // ── New D4 contracts ────────────────────────────────────────────
  it('emits a "read stdout" Next hint when exit !=0 but only stdout has content', () => {
    const f = formatShellFailure({
      taskId: 't',
      exitCode: 1,
      stderr: '',
      stdout: 'FAILED 3 tests passed 12',
    })
    expect(f.errorNext?.some((n) => /Read the stdout/i.test(n))).toBe(true)
  })

  it('emits a "silent failure / use -v" Next hint when both streams are empty', () => {
    const f = formatShellFailure({
      taskId: 't',
      exitCode: 1,
      stderr: '',
      stdout: '',
    })
    expect(f.errorNext?.some((n) => /Silent failure/i.test(n))).toBe(true)
  })

  it('tags `toolErrorClass` as "shell" so the UI badge / telemetry route correctly', () => {
    const f = formatShellFailure({ taskId: 't', exitCode: 1, stderr: 'e', stdout: '' })
    expect(f.toolErrorClass).toBe('shell')
  })
})

describe('appendPreExecutionWarnings', () => {
  // Regression: `python3 fix_quotes.py` on Windows used to silently fail
  // (exit 49 / empty stderr) without ever surfacing the validator's
  // "use `python` or `py -3`" warn-level hint. The helper turns that
  // invisible warning into a visible post-mortem on failure.
  function failure(error: string) {
    return { error, errorWhat: error, toolErrorClass: 'shell' as const }
  }

  it('appends warnings as a bullet list when warnings exist', () => {
    const base = failure('Task X failed (exit 49): (no output captured)')
    const out = appendPreExecutionWarnings(base, [
      'Windows 默认仅安装 `python` 或 `py` — `python3` 常不存在',
    ])
    expect(out.error).toContain(base.error)
    expect(out.error).toContain('Pre-execution hints')
    expect(out.error).toMatch(/- Windows 默认仅安装/)
    // D4: warnings also surface as structured `errorNext` for the UI.
    expect(out.errorNext).toEqual(['Windows 默认仅安装 `python` 或 `py` — `python3` 常不存在'])
  })

  it('returns the original failure untouched when warnings are empty', () => {
    const base = failure('Task X failed (exit 1): real stderr message')
    expect(appendPreExecutionWarnings(base, [])).toBe(base)
  })

  it('drops whitespace-only entries without producing an empty bullet', () => {
    const base = failure('Task X failed (exit 1): err')
    expect(appendPreExecutionWarnings(base, ['   ', '\n', ''])).toBe(base)
  })

  it('renders multiple warnings on separate bullet lines', () => {
    const out = appendPreExecutionWarnings(failure('Task X failed: err'), [
      'hint A',
      'hint B',
    ])
    expect(out.error).toMatch(/- hint A\n- hint B/)
    expect(out.errorNext).toEqual(['hint A', 'hint B'])
  })

  it('merges warnings into existing errorNext array (does not clobber)', () => {
    const base = {
      error: 'Task X failed: err',
      errorWhat: 'Task X failed',
      errorNext: ['Read the stderr above.'],
      toolErrorClass: 'shell' as const,
    }
    const out = appendPreExecutionWarnings(base, ['hint A'])
    expect(out.errorNext).toEqual(['Read the stderr above.', 'hint A'])
  })
})

describe('formatShellSpawnError', () => {
  it('includes error message and task id', () => {
    const f = formatShellSpawnError({
      taskId: 'toolu_spawn',
      error: new Error('ENOENT python3'),
    })
    expect(f.error).toContain('toolu_spawn')
    expect(f.error).toContain('ENOENT python3')
    expect(f.error).toContain('failed to spawn')
    expect(f.toolErrorClass).toBe('shell')
  })

  it('accepts string errors', () => {
    const f = formatShellSpawnError({ taskId: 't', error: 'raw message' })
    expect(f.error).toContain('raw message')
  })

  it('appends command echo when provided', () => {
    const f = formatShellSpawnError({
      taskId: 't',
      error: 'oops',
      commandEcho: 'python3 -c "x"',
    })
    expect(f.error).toContain('python3 -c')
  })

  it('routes ENOENT to a "verify with which / Get-Command" Next hint', () => {
    const f = formatShellSpawnError({ taskId: 't', error: 'ENOENT python3' })
    expect(f.errorNext?.some((n) => /which|Get-Command/.test(n))).toBe(true)
  })
})
