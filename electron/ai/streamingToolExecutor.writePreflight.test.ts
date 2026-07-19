/**
 * Integration test: the StreamingToolExecutor invokes the centralised Write
 * preflight gate **before** {@link runAgenticToolUse}, so a destined-to-fail
 * Write on an existing non-trivial file is rejected as soon as its tool_use
 * block finishes streaming — no permission flow, no hooks engine, no file
 * lock, no orchestration overhead.
 *
 * `runAgenticToolUse` is mocked: if the preflight gate works correctly it
 * is **never called** for the rejected tool_use, and we assert exactly that.
 *
 * Audit fix A-4 (2026-05): the rejection path now ALSO fires the UI
 * `onToolStart` / `onToolResult` callbacks so the renderer transcript and
 * the model transcript agree about what happened. Previously this was a
 * "silent" path (UI never saw it, only the model did), which manufactured
 * a split between the two views. These tests assert the new contract.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('./runAgenticToolUse', async () => {
  return {
    runAgenticToolUse: vi.fn(),
  }
})

import { StreamingToolExecutor } from './streamingToolExecutor'
import { runAgenticToolUse } from './runAgenticToolUse'
import { setWorkspacePath } from '../tools/workspaceState'

const mockedRunAgenticToolUse = runAgenticToolUse as unknown as ReturnType<typeof vi.fn>

let workspaceDir: string

function makeExecutor(): {
  executor: StreamingToolExecutor
  onToolStart: ReturnType<typeof vi.fn>
  onToolResult: ReturnType<typeof vi.fn>
} {
  const onToolStart = vi.fn()
  const onToolResult = vi.fn()
  const executor = new StreamingToolExecutor({
    signal: new AbortController().signal,
    callbacks: { onToolStart, onToolResult },
    diffPermissionMode: 'default',
    permissionDefaultMode: 'allow',
    discoveryExclude: new Set<string>(),
    getInlineSkillSession: () => null,
    setInlineSkillSession: () => {},
  })
  return { executor, onToolStart, onToolResult }
}

async function drainRemaining(executor: StreamingToolExecutor): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const item of executor.getRemainingResults()) {
    if (item.type === 'tool_result') out.push(item.data)
  }
  return out
}

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-ste-wp-'))
})

afterAll(() => {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

beforeEach(() => {
  setWorkspacePath(workspaceDir)
  mockedRunAgenticToolUse.mockReset()
})

afterEach(() => {
  setWorkspacePath(null)
})

describe('StreamingToolExecutor — Write preflight gate (UI now mirrors transcript — audit A-4)', () => {
  it('rejects Write on an existing large file WITHOUT invoking runAgenticToolUse, but DOES fire the UI callbacks', async () => {
    const big = 'a'.repeat(4096)
    fs.writeFileSync(path.join(workspaceDir, 'existing.ts'), big)

    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_write_1',
      name: 'Write',
      input: { filePath: 'existing.ts', content: 'replacement body' },
    })

    const results = await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    // Audit fix A-4: the UI must see the attempted call + its synthetic
    // failure so the renderer and the model agree on the timeline.
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolStart).toHaveBeenCalledWith({
      id: 'tu_write_1',
      name: 'Write',
      input: expect.objectContaining({ filePath: 'existing.ts' }),
    })
    expect(onToolResult).toHaveBeenCalledTimes(1)
    const resultPayload = onToolResult.mock.calls[0]![0]
    expect(resultPayload.id).toBe('tu_write_1')
    expect(resultPayload.name).toBe('Write')
    expect(resultPayload.success).toBe(false)
    expect(resultPayload.toolErrorClass).toBe('write_preflight')
    expect(String(resultPayload.error)).toMatch(/write_file refused/)

    // Model channel still receives the synthetic tool_result.
    expect(results).toHaveLength(1)
    expect(results[0]!.tool_use_id).toBe('tu_write_1')
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/Error: write_file refused/)
    expect(String(results[0]!.content)).toMatch(/edit_file/)
  })

  it('honours the snake_case alias `write_file` the same way as canonical `Write`', async () => {
    const big = 'a'.repeat(4096)
    fs.writeFileSync(path.join(workspaceDir, 'existing2.ts'), big)

    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_write_2',
      name: 'write_file',
      input: { file_path: 'existing2.ts', content: 'replacement body' },
    })

    const results = await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    // Same audit A-4 contract — alias path must also fire UI callbacks.
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(String(results[0]!.content)).toMatch(/write_file refused/)
  })

  it('passes through to runAgenticToolUse AND fires UI callbacks for a Write on a brand-new file', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu_write_new',
      content: 'ok',
    })

    const { executor, onToolStart } = makeExecutor()
    executor.addTool({
      id: 'tu_write_new',
      name: 'Write',
      input: { filePath: 'brand-new-file.ts', content: 'export const x = 1' },
    })

    await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    // Legitimate Write attempts have always fired callbacks; this test
    // just guards that the audit A-4 change to rejection paths didn't
    // accidentally double-fire on the happy path.
    expect(onToolStart).toHaveBeenCalledTimes(1)
    const callArg = mockedRunAgenticToolUse.mock.calls[0]![0] as {
      toolUse: { id: string; name: string }
    }
    expect(callArg.toolUse.id).toBe('tu_write_new')
    expect(callArg.toolUse.name).toBe('Write')
  })

  it('rejects Write on a tiny existing file (no soft threshold any more)', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'tiny.txt'), 'x')

    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_write_tiny',
      name: 'Write',
      input: { filePath: 'tiny.txt', content: 'overwrite ok' },
    })

    const results = await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(String(results[0]!.content)).toMatch(/write_file refused/)
    expect(String(results[0]!.content)).toMatch(/edit_file/)
  })

  it('rejects Write on a zero-byte existing file (the firmest case)', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'empty.txt'), '')

    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_write_empty',
      name: 'Write',
      input: { filePath: 'empty.txt', content: 'first content' },
    })

    const results = await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(String(results[0]!.content)).toMatch(/write_file refused/)
    expect(String(results[0]!.content)).toMatch(/edit_file/)
  })

  it('does NOT trigger for non-Write tools targeting the same large file (Edit must reach runAgenticToolUse)', async () => {
    const big = 'a'.repeat(4096)
    fs.writeFileSync(path.join(workspaceDir, 'shared.ts'), big)

    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu_edit_1',
      content: 'ok',
    })

    const { executor, onToolStart } = makeExecutor()
    executor.addTool({
      id: 'tu_edit_1',
      name: 'Edit',
      input: { filePath: 'shared.ts', oldString: 'a', newString: 'b' },
    })

    await drainRemaining(executor)

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(onToolStart).toHaveBeenCalledTimes(1)
  })
})

describe('StreamingToolExecutor — pre-baked stream-time rejection (content-before-filePath)', () => {
  it('surfaces the watcher-supplied `preflightError` directly and skips the disk preflight (audit A-4: UI sees it too)', async () => {
    // Simulate what the C-grade watcher emits when DeepSeek V4 Pro (or
    // any model that streams `content` before `filePath`) is aborted
    // mid-stream: an `input` with NO filePath, plus a `preflightError`
    // top-level field carrying the canonical educative message.
    //
    // Without the bypass, B-grade's `preflightWriteTool({filePath:
    // undefined})` would fail-open and runAgenticToolUse would be
    // invoked — wasting the very write the watcher just stopped.
    const prebaked =
      'write_file aborted at stream time: `content` was emitted before `filePath` in the JSON.'

    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_prebaked_1',
      name: 'Write',
      input: {},
      preflightError: prebaked,
    })

    const results = await drainRemaining(executor)

    // Disk preflight skipped; underlying tool never ran.
    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    // Audit fix A-4: UI sees the attempted call + its failure, matching
    // the model-side transcript.
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolResult).toHaveBeenCalledTimes(1)
    const resultPayload = onToolResult.mock.calls[0]![0]
    expect(resultPayload.success).toBe(false)
    expect(resultPayload.toolErrorClass).toBe('write_preflight')
    expect(String(resultPayload.error)).toBe(prebaked)
    // Model channel: receives the pre-baked verbatim, prefixed with `Error: `.
    expect(results).toHaveLength(1)
    expect(results[0]!.tool_use_id).toBe('tu_prebaked_1')
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toBe(`Error: ${prebaked}`)
  })

  it('honours `preflightError` for the snake_case alias `write_file` too', async () => {
    const prebaked = 'pre-baked message via write_file alias'
    const { executor, onToolStart, onToolResult } = makeExecutor()
    executor.addTool({
      id: 'tu_prebaked_2',
      name: 'write_file',
      input: {},
      preflightError: prebaked,
    })

    const results = await drainRemaining(executor)
    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(String(results[0]!.content)).toBe(`Error: ${prebaked}`)
  })

  it('ignores an empty-string `preflightError` and falls back to the standard disk preflight', async () => {
    // Defensive contract: only a non-empty string short-circuits the
    // disk gate. Empty / whitespace must be treated as "no pre-bake"
    // so a malformed watcher payload cannot silently disable B-grade.
    const big = 'a'.repeat(4096)
    fs.writeFileSync(path.join(workspaceDir, 'fallback.ts'), big)

    const { executor } = makeExecutor()
    executor.addTool({
      id: 'tu_prebaked_empty',
      name: 'Write',
      input: { filePath: 'fallback.ts', content: 'replacement' },
      preflightError: '',
    })

    const results = await drainRemaining(executor)
    // Disk preflight kicked in normally and rejected the existing file.
    expect(String(results[0]!.content)).toMatch(/write_file refused/)
  })
})
