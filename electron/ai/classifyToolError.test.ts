/**
 * Heuristic classifier behaviour lock.
 *
 * The classifier is the safety-net that runs in `runAgenticToolUseBody`
 * AFTER a tool returns `success: false`. It assigns a stable `class` to
 * the failure so telemetry, the UI's error-state badge, and the model's
 * retry path can all branch on it. Buckets `mcp`, `shell`, and
 * `parallel_abort` were added when `electron/tools/toolErrors.ts` was
 * deleted as dead code — these tests pin their detection.
 */

import { describe, expect, it } from 'vitest'
import { classifyToolError, toolErrorClassToOtelSource } from './classifyToolError'

describe('classifyToolError', () => {
  it('detects permission_denied first (highest precedence)', () => {
    expect(classifyToolError('permission denied by hook').class).toBe('permission_denied')
    expect(classifyToolError('permission cancelled by user').class).toBe('permission_denied')
    expect(classifyToolError('blocked by approval gate').class).toBe('permission_denied')
  })

  it('detects parallel_abort before not_found despite the word "failed"', () => {
    const r = classifyToolError(
      'Aborted because another tool in the same parallel batch failed.',
    )
    expect(r.class).toBe('parallel_abort')
    expect(r.telemetryHint).toBe('parallel_abort')
  })

  it('detects not_found and surfaces mcp_not_found when toolName is mcp__*', () => {
    expect(classifyToolError('file not found: foo.ts').class).toBe('not_found')
    expect(classifyToolError('ENOENT: no such file').class).toBe('not_found')
    expect(
      classifyToolError('not found', { toolName: 'mcp__fs__read' }).telemetryHint,
    ).toBe('mcp_not_found')
  })

  it('detects timeout', () => {
    expect(classifyToolError('Request timed out after 30s').class).toBe('timeout')
    expect(classifyToolError(new Error('ETIMEDOUT')).class).toBe('timeout')
  })

  it('classifies mcp__* tool failures as mcp before falling through to network', () => {
    // toolName-driven path: error text alone looks generic, but the tool
    // namespace tells us this is MCP transport — re-auth is the right fix.
    const r = classifyToolError('connection refused', { toolName: 'mcp__filesystem__read_text_file' })
    expect(r.class).toBe('mcp')
  })

  it('classifies plain network errors as network when toolName is not MCP', () => {
    expect(classifyToolError('ECONNREFUSED 127.0.0.1:443').class).toBe('network')
    expect(classifyToolError('fetch failed: socket hang up').class).toBe('network')
  })

  it('detects rate_limit', () => {
    expect(classifyToolError('429 Too Many Requests').class).toBe('rate_limit')
    expect(classifyToolError('rate limit exceeded').class).toBe('rate_limit')
  })

  it('detects shell when exit code is non-zero with empty stderr', () => {
    const r = classifyToolError('Command exited with code 1 (no stderr)')
    expect(r.class).toBe('shell')
    expect(r.telemetryHint).toBe('shell_nonzero_no_stderr')
  })

  it('does not misclassify shell errors that DO have stderr as `shell`', () => {
    // Plain "exit code N" without the no-stderr marker stays as the
    // appropriate later bucket (validation / unknown). We only carve out
    // `shell` for the silent-failure case where stdout holds the answer.
    const r = classifyToolError('Command exited with code 2: bash: foo: invalid argument')
    expect(r.class).not.toBe('shell')
  })

  it('detects validation before filesystem when both could match', () => {
    expect(classifyToolError('zod: input must be a string').class).toBe('validation')
    expect(classifyToolError('refusing to overwrite').class).toBe('validation')
  })

  it('detects filesystem (eacces / outside workspace)', () => {
    expect(classifyToolError('EACCES: permission denied, open /etc/shadow').class).toBe(
      'permission_denied', // permission_denied wins by ordering — that's intentional
    )
    expect(classifyToolError('EPERM: operation not permitted').class).toBe('filesystem')
    expect(classifyToolError('Path /etc resolves outside the workspace').class).toBe('filesystem')
  })

  it('detects filesystem_type for directory-vs-file mistakes', () => {
    expect(classifyToolError('EISDIR: illegal operation on a directory').telemetryHint).toBe(
      'filesystem_type',
    )
    expect(classifyToolError('foo is a directory, not a file').telemetryHint).toBe(
      'filesystem_type',
    )
  })

  it('falls back to unknown for unrecognised messages', () => {
    expect(classifyToolError('some weird error nobody anticipated').class).toBe('unknown')
    expect(classifyToolError(undefined).class).toBe('unknown')
  })
})

describe('toolErrorClassToOtelSource', () => {
  it('produces a stable, snake_case-prefixed label', () => {
    expect(toolErrorClassToOtelSource('mcp')).toBe('tool_error.mcp')
    expect(toolErrorClassToOtelSource('shell')).toBe('tool_error.shell')
    expect(toolErrorClassToOtelSource('parallel_abort')).toBe('tool_error.parallel_abort')
    expect(toolErrorClassToOtelSource('unknown')).toBe('tool_error.unknown')
  })
})
