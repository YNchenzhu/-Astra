/**
 * Structured shell-failure formatters shared by `shellRunner.ts` and
 * `sandbox/sandbox-command.ts`. One place to decide what information the
 * model actually sees when a child process fails.
 *
 * Historical bug: both runners used `stderr.trim() || stdout.trim()` for the
 * error body, so a PowerShell parser-error that was swallowed (or a UTF-16LE
 * stream decoded as UTF-8) produced an empty string — the model then got
 * `"Task <id> failed: "` with no signal, no exit code, and no diagnostic. It
 * rationally retried the same command because the error was semantically empty.
 *
 * These formatters guarantee the model always receives at minimum:
 *   1. exit code (and signal if the child was killed by one)
 *   2. explicit `(no output captured on stderr or stdout)` when both streams
 *      were empty — so the model knows a retry is pointless, not that the
 *      error was transient
 *   3. a trimmed non-empty detail whenever the child wrote anything
 *
 * Audit fix D4: these formatters now return {@link ToolFailureFields}
 * (carrying `error` + `errorWhat / errorTried / errorContext / errorNext` +
 * `toolErrorClass: 'shell'`) so bash / PowerShell failures render through
 * the renderer's `StructuredErrorView` — same chrome as `read_file` /
 * `edit_file` failures. Callers `spread` the result onto `ToolResult`:
 *
 *     return { success: false, ...formatShellFailure({...}) }
 *
 * The `error` string content is intentionally byte-identical to what the
 * old `string`-returning version produced, so the model self-correction
 * loop is unchanged.
 */

import { buildToolFailure, type ToolFailureFields } from './toolErrorFormat'

export type ShellFailureParams = {
  taskId: string
  exitCode: number | null
  /** POSIX signal name when the child was killed (`SIGTERM`, `SIGKILL`, …). */
  signal?: NodeJS.Signals | string | null
  stderr: string
  stdout: string
  /**
   * Optional echo of the command that was spawned — included in the tail when
   * both stdout and stderr are empty, so the model can see WHICH invocation
   * failed silently (invaluable on Windows where PowerShell parser errors are
   * often routed to `$Error` instead of the streams).
   */
  commandEcho?: string
  /** Wall-clock duration in ms, if the caller tracks it. */
  durationMs?: number
}

const EMPTY_OUTPUT_SENTINEL = '(no output captured on stderr or stdout)'

export function formatShellFailureDetail(
  stderr: string,
  stdout: string,
  commandEcho?: string,
): string {
  const err = stderr.trim()
  if (err) return err
  const out = stdout.trim()
  if (out) return out
  if (commandEcho && commandEcho.trim()) {
    // Shortened echo so the sentinel stays useful in long multi-line commands.
    const echo = commandEcho.trim().replace(/\s+/g, ' ')
    const MAX = 200
    const trimmed = echo.length > MAX ? `${echo.slice(0, MAX)}…` : echo
    return `${EMPTY_OUTPUT_SENTINEL} — silent child process, command: ${trimmed}`
  }
  return EMPTY_OUTPUT_SENTINEL
}

/**
 * Composes the `ToolFailureFields` returned in `ToolResult` for a child
 * that closed with a non-zero exit code. The `error` string content is
 * byte-identical to the pre-D4 `string`-returning version so the model's
 * self-correction loop sees exactly the same text it always saw.
 */
export function formatShellFailure(params: ShellFailureParams): ToolFailureFields {
  const { taskId, exitCode, signal, stderr, stdout, commandEcho, durationMs } = params
  const detail = formatShellFailureDetail(stderr, stdout, commandEcho)

  const header: string[] = []
  if (typeof exitCode === 'number') {
    header.push(`exit ${exitCode}`)
  } else {
    header.push('exit ?')
  }
  if (signal) {
    header.push(`signal ${signal}`)
  }
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    header.push(`${durationMs}ms`)
  }

  // Byte-identical legacy text — pinned by shellErrorFormat.test.ts.
  const headline = `Task ${taskId} failed (${header.join(', ')}): ${detail}`

  // Structured context: model already sees this in the headline, but the
  // UI gets a tidy key=value strip and the telemetry pipeline gets stable
  // numeric fields.
  const context: Record<string, string | number | null | undefined> = {}
  if (typeof exitCode === 'number') context.exit_code = exitCode
  if (signal) context.signal = String(signal)
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) context.duration_ms = durationMs

  // Recovery hint: when stderr is empty but stdout has content the
  // non-zero exit is usually "tests failed" / "grep no match" / wrong cwd
  // — the answer is IN the stdout the agent already received. We surface
  // that nudge so the model reads the stdout payload before retrying with
  // tweaked flags.
  const stderrTrimmed = stderr.trim()
  const stdoutTrimmed = stdout.trim()
  const next: string[] = []
  if (!stderrTrimmed && stdoutTrimmed) {
    next.push(
      'Non-zero exit with no stderr is common for tests failed / grep no match / wrong cwd. Read the stdout above before adjusting flags or the command.',
    )
  } else if (!stderrTrimmed && !stdoutTrimmed) {
    next.push(
      'Silent failure (no stderr, no stdout). Re-run with `-v` / `--verbose` / `2>&1` to capture diagnostics; check the `cwd` and the command tokenization.',
    )
  } else {
    next.push(
      'Read the error detail above, then adjust the command, working directory, or flags before retrying.',
    )
  }

  const failure = buildToolFailure(
    {
      what: headline,
      context,
      next,
    },
    'shell',
  )
  // Replace the formatter's headline-only `error` with the canonical
  // headline string. Pre-D4 callers passed this verbatim into the tool
  // result; we preserve that byte-for-byte to avoid disturbing the
  // model's recovery loop or the shape-lock tests.
  failure.error = headline
  return failure
}

/**
 * Variant for `child.on('error')` — the child never started or died during
 * spawn. There is no exit code yet, but we still surface the task id, the
 * spawn-level error message, and (when available) the command echo.
 *
 * Audit fix D4: returns `ToolFailureFields`. The `error` string remains
 * byte-identical to the pre-D4 version.
 */
export function formatShellSpawnError(params: {
  taskId: string
  error: Error | string
  commandEcho?: string
}): ToolFailureFields {
  const { taskId, error, commandEcho } = params
  const msg = typeof error === 'string' ? error : error.message
  const echoTrimmed = commandEcho && commandEcho.trim()
    ? commandEcho.trim().replace(/\s+/g, ' ').slice(0, 200)
    : ''
  const tail = echoTrimmed ? ` (command: ${echoTrimmed})` : ''
  const headline = `Task ${taskId} failed to spawn: ${msg}${tail}`

  // ENOENT on Windows almost always means "the binary isn't on PATH" —
  // the canonical recovery is to use the actual executable name (`python`
  // / `py -3` instead of `python3`, `cmd` instead of an MSYS shell). We
  // can't detect that here, but we can route the model toward `which` /
  // `Get-Command` so it can verify before retrying.
  const next: string[] = [
    /enoent/i.test(msg)
      ? 'Binary not found on PATH. Verify with `which <cmd>` (POSIX) or `Get-Command <cmd>` (PowerShell); on Windows `python3` is usually `python` or `py -3`.'
      : /eacces|eperm/i.test(msg)
        ? 'Spawn denied by OS permissions. Check the executable bit and the working directory.'
        : 'Spawn failed before the child started. Verify the command, the cwd, and any required environment.',
  ]

  const failure = buildToolFailure(
    {
      what: headline,
      ...(echoTrimmed ? { tried: [echoTrimmed] } : {}),
      next,
    },
    'shell',
  )
  failure.error = headline
  return failure
}

/**
 * Append pre-execution validator warnings (verdict='warn' reasons) to a
 * runtime shell failure. The validator's warn-level reasons are normally
 * invisible to the model — the bash tool only blocks on `deny`.
 *
 * That asymmetry produced the audit case where `python3 fix_quotes.py`
 * on Windows triggered `XP_PYTHON3_ON_WINDOWS` ("use `python` or `py -3`")
 * but the warning never reached the model: the command ran, the child
 * silently exited 49 with empty stderr, and the agent re-tried the same
 * doomed invocation. By appending warn reasons whenever the command then
 * fails, we turn an invisible hint into an actionable post-mortem the
 * agent can read on attempt #2.
 *
 * Successful commands do NOT receive this appendix (warnings stay
 * invisible — we only surface them when they likely explain the failure).
 *
 * Returns the original failure untouched when there are no warnings.
 *
 * Audit fix D4: accepts and returns a `ToolFailureFields` so warnings
 * land both in the model-visible `error` string (legacy behaviour) AND
 * in `errorNext` so the renderer can show them as a real bulleted list
 * under the headline.
 */
export function appendPreExecutionWarnings(
  failure: ToolFailureFields,
  warnings: ReadonlyArray<string>,
): ToolFailureFields {
  const cleaned = warnings.map((w) => w.trim()).filter((w) => w.length > 0)
  if (cleaned.length === 0) return failure
  const bullets = cleaned.map((w) => `- ${w}`).join('\n')
  const newError = `${failure.error}\n\nPre-execution hints (may explain the failure):\n${bullets}`
  return {
    ...failure,
    error: newError,
    // Merge the warnings into errorNext so StructuredErrorView shows
    // them as a real bulleted list under the "Next" heading — alongside
    // any recovery hints `formatShellFailure` already produced.
    errorNext: [...(failure.errorNext ?? []), ...cleaned],
  }
}
