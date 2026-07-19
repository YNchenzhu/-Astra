/**
 * Regression: the C-grade stream watcher (`streamWriteInputWatcher.ts`)
 * aborts a doomed write_file mid-stream and emits a synthetic tool_use
 * whose `input` is intentionally partial (`{filePath}`) or empty (`{}`),
 * with the real verdict pre-baked in `preflightError`.
 *
 * The streaming executor honoured that field, but the batch / orchestrated
 * paths (`bypassStreamingForPolicy`, sub-agents, fallback batch) ran Zod on
 * the partial input instead — every provider then saw the misleading
 * `FIX FIRST: … missing/empty required argument(s) … received as undefined`
 * error, "corrected" by re-sending the same call, and got aborted again
 * (infinite loop). `runAgenticToolUseBody` must surface `preflightError`
 * BEFORE input validation.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { runAgenticToolUse } from './runAgenticToolUse'
import { toolRegistry } from '../tools/registry'
import { buildContentBeforeFilePathError } from '../tools/writeToolPreflightGate'

describe('runAgenticToolUse — C-grade preflightError short-circuit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces the pre-baked watcher error instead of Zod-validating the empty synthetic input', async () => {
    const execSpy = vi.spyOn(toolRegistry, 'execute')
    const prebaked = buildContentBeforeFilePathError().error

    const out = await runAgenticToolUse({
      toolUse: {
        id: 'tu-preflight-empty',
        name: 'write_file',
        // The watcher's content-before-filePath branch leaves `{}` behind.
        input: {},
        preflightError: prebaked,
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    const block = out as { is_error?: boolean; content?: string }
    expect(block.is_error).toBe(true)
    expect(String(block.content)).toContain(prebaked)
    // The misleading "dropped/truncated arguments" Zod headline must NOT
    // appear — that message teaches the model to re-issue the same doomed
    // call forever.
    expect(String(block.content)).not.toContain('InputValidationError')
    expect(String(block.content)).not.toContain('missing/empty required argument')
    expect(execSpy).not.toHaveBeenCalled()
  })

  it('ignores an empty-string preflightError and falls through to normal validation', async () => {
    const out = await runAgenticToolUse({
      toolUse: {
        id: 'tu-preflight-blank',
        name: 'write_file',
        input: {},
        preflightError: '',
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    const block = out as { is_error?: boolean; content?: string }
    expect(block.is_error).toBe(true)
    expect(String(block.content)).toContain('InputValidationError')
  })
})
