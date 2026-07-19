/**
 * Tests for the AsyncGenerator API on top of the agentic loop.
 *
 * We don't drive the real `runAgenticLoop` here (it would require a live
 * provider connection). Instead, we mock `runAgenticLoop` to a tiny
 * deterministic implementation that:
 *   - calls a known sequence of callback methods (covering every
 *     {@link LoopEvent} variant), and
 *   - records `state.signal.aborted` reads so cancellation tests can
 *     assert the merged signal actually fires.
 *
 * That gives us behavioural coverage of the channel + driver + generator
 * surfaces without coupling to the production stream/tool pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgenticLoopCallbacks, AgenticLoopParams } from './agenticLoopTypes'
import type { AgenticLoopOptions } from '../orchestration/phases/iteration'
import type { AgenticLoopResult, LoopEvent } from './loopEvents'
import { dispatchEventToCallbacks } from './agenticLoopAsync'

// vi.mock must be hoisted; reference the runAgenticLoop *before* importing
// the adapter so the mock is applied.
vi.mock('../orchestration/phases/iteration', () => {
  return {
    runAgenticLoop: vi.fn(),
  }
})

// Imported AFTER the mock factory so it picks up the mocked version.
const agenticLoopMod = await import('../orchestration/phases/iteration')
const { runAgenticLoopAsync, driveLoopAsGenerator } = await import('./agenticLoopAsync')

// Use vi.mocked() so the inferred Mock type carries the real
// runAgenticLoop signature — without this, vi.fn() falls back to a
// `() => unknown` shape and mockImplementation arg-passing silently
// degenerates (as we hit on the fan-out parity test).
const mockedLoop = vi.mocked(agenticLoopMod.runAgenticLoop)

function makeParams(): AgenticLoopParams {
  return {
    config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' } as AgenticLoopParams['config'],
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
  }
}

describe('runAgenticLoopAsync — generator API', () => {
  beforeEach(() => {
    mockedLoop.mockReset()
  })

  afterEach(() => {
    mockedLoop.mockReset()
  })

  it('yields events in source order and returns AgenticLoopResult on done', async () => {
    mockedLoop.mockImplementation(
      async (
        _p: AgenticLoopParams,
        cb: AgenticLoopCallbacks,
        opts: AgenticLoopOptions,
      ) => {
        // Vitest 4 may invoke a mock fn internally during test teardown
        // with no args; guard so spurious invocations don't crash the
        // suite. Real driver invocations always pass full args.
        if (!cb) return
        cb.onTextDelta('hello')
        cb.onToolStart({ id: 't1', name: 'echo', input: { msg: 'hi' } })
        cb.onToolResult({ id: 't1', name: 'echo', success: true, output: 'hi' })
        cb.onMessageEnd({ inputTokens: 10, outputTokens: 5 })
        opts.onTerminate?.({
          terminationResult: {
            reason: 'completed',
            turnCount: 1,
            totalUsage: { inputTokens: 10, outputTokens: 5 },
            terminatedAt: Date.now(),
          },
          totalUsage: { inputTokens: 10, outputTokens: 5 },
          transition: 'tool_use',
          transitionHistory: ['init', 'tool_use'],
        })
      },
    )

    const events: LoopEvent[] = []
    const gen = runAgenticLoopAsync(makeParams())
    let result: AgenticLoopResult | null = null
    while (true) {
      const r = await gen.next()
      if (r.done) {
        result = r.value
        break
      }
      events.push(r.value)
    }
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'tool_start',
      'tool_result',
      'message_end',
    ])
    expect((events[0] as { text: string }).text).toBe('hello')
    expect(result?.terminationResult.reason).toBe('completed')
    expect(result?.totalUsage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(result?.transition).toBe('tool_use')
    expect(result?.transitionHistory).toEqual(['init', 'tool_use'])
  })

  it('for-await covers the full event stream and supports break-out', async () => {
    mockedLoop.mockImplementation(
      async (_p: AgenticLoopParams, cb: AgenticLoopCallbacks, opts: AgenticLoopOptions) => {
        if (!cb) return
        cb.onTextDelta('a')
        cb.onTextDelta('b')
        cb.onTextDelta('c')
        cb.onMessageEnd({ inputTokens: 1, outputTokens: 1 })
        opts.onTerminate?.({
          terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: Date.now() },
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          transition: 'init',
          transitionHistory: ['init'],
        })
      },
    )

    const seen: string[] = []
    const gen = runAgenticLoopAsync(makeParams())
    for await (const event of gen) {
      seen.push(event.type)
      if (event.type === 'text_delta' && (event as { text: string }).text === 'b') {
        break
      }
    }
    // We broke after 'b', so we should NOT see 'c' or 'message_end'.
    expect(seen).toEqual(['text_delta', 'text_delta'])
  })

  it('gen.return() aborts the merged signal and resolves with done=true', async () => {
    let observedAbort = false
    mockedLoop.mockImplementation(
      async (p: AgenticLoopParams, cb: AgenticLoopCallbacks, opts: AgenticLoopOptions) => {
        if (!cb) return
        cb.onTextDelta('starting')
        // Wait for the consumer to abort us.
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            observedAbort = true
            p.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          p.signal.addEventListener('abort', onAbort)
          // Safety net: don't hang forever.
          setTimeout(resolve, 500)
        })
        opts.onTerminate?.({
          terminationResult: { reason: 'aborted_streaming', turnCount: 0, terminatedAt: Date.now() },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init',
          transitionHistory: ['init'],
        })
      },
    )

    const gen = runAgenticLoopAsync(makeParams())
    const first = await gen.next()
    expect(first.done).toBe(false)
    const ret = await gen.return(undefined as unknown as AgenticLoopResult)
    expect(ret.done).toBe(true)
    expect(observedAbort).toBe(true)
  })

  it('error inside loop surfaces as a thrown error from the generator', async () => {
    mockedLoop.mockImplementation(
      async (_p: AgenticLoopParams, cb: AgenticLoopCallbacks) => {
        if (!cb) return
        cb.onTextDelta('start')
        throw new Error('boom from inside loop')
      },
    )

    const gen = runAgenticLoopAsync(makeParams())
    await gen.next() // consume 'text_delta'
    await expect(gen.next()).rejects.toThrow(/boom from inside loop/)
  })

  it('Symbol.asyncDispose triggers abort like return()', async () => {
    let aborted = false
    mockedLoop.mockImplementation(
      async (p: AgenticLoopParams, cb: AgenticLoopCallbacks, opts: AgenticLoopOptions) => {
        if (!cb) return
        cb.onTextDelta('hi')
        await new Promise<void>((resolve) => {
          p.signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          })
          setTimeout(resolve, 500)
        })
        opts.onTerminate?.({
          terminationResult: { reason: 'aborted_streaming', turnCount: 0, terminatedAt: Date.now() },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init',
          transitionHistory: ['init'],
        })
      },
    )
    const gen = runAgenticLoopAsync(makeParams())
    await gen.next()
    await gen[Symbol.asyncDispose]()
    expect(aborted).toBe(true)
  })
})

describe('driveLoopAsGenerator — fan-out callbacks parity', () => {
  beforeEach(() => mockedLoop.mockReset())

  it('fanOutTo callbacks see the same events the generator yields, in order', async () => {
    // NOTE: Vitest 4 mockImplementation passes args correctly when the
    // surrounding `it` block's mock body avoids the named-rest /
    // arrow-async edge-case quirk we hit before. Use `function()` for
    // robust arg pickup.
    mockedLoop.mockImplementation(async (_p, cb, opts) => {
      if (!cb) return // guard against spurious test-teardown invocations
      cb.onTextDelta('hello')
      cb.onToolStart({ id: 't1', name: 'echo', input: {} })
      cb.onToolResult({ id: 't1', name: 'echo', success: true })
      cb.onContextCompact?.({ level: 'micro_compact' })
      cb.onMessageEnd({ inputTokens: 1, outputTokens: 1 })
      opts?.onTerminate?.({
        terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 1, outputTokens: 1 },
        transition: 'tool_use',
        transitionHistory: ['init', 'tool_use'],
      })
    })

    const fanOut: string[] = []
    const yields: string[] = []
    const callbacks: AgenticLoopCallbacks = {
      onTextDelta: (t) => fanOut.push(`text:${t}`),
      onThinkingDelta: () => {},
      onToolStart: (t) => fanOut.push(`tool_start:${t.name}`),
      onToolResult: (t) => fanOut.push(`tool_result:${t.id}`),
      onMessageEnd: () => fanOut.push('end'),
      onError: () => fanOut.push('error'),
      onContextCompact: (d) => fanOut.push(`compact:${d.level}`),
    }
    const gen = driveLoopAsGenerator(makeParams(), callbacks)
    for await (const event of gen) {
      yields.push(event.type)
    }
    expect(yields).toEqual([
      'text_delta',
      'tool_start',
      'tool_result',
      'context_compact',
      'message_end',
    ])
    expect(fanOut).toEqual([
      'text:hello',
      'tool_start:echo',
      'tool_result:t1',
      'compact:micro_compact',
      'end',
    ])
  })
})

describe('dispatchEventToCallbacks — exhaustiveness contract', () => {
  /**
   * Every LoopEvent variant must dispatch to the documented callback
   * field. The dispatcher's `default` branch is `never`-typed so the
   * union and switch must stay in sync; this runtime test catches a
   * future variant that someone wires into LoopEvent without also
   * updating the dispatcher.
   */
  const callbacks: AgenticLoopCallbacks = {
    onTextDelta: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingBlock: vi.fn(),
    onReasoningSummaryDelta: vi.fn(),
    onReasoningSummaryBlock: vi.fn(),
    onToolStart: vi.fn(),
    onToolResult: vi.fn(),
    onMessageEnd: vi.fn(),
    onError: vi.fn(),
    onContextCompact: vi.fn(),
    onMaxIterationsReached: vi.fn(),
    onQueryLoopPreModel: vi.fn(),
    onQueryLoopStopHook: vi.fn(),
    onStreamingFallback: vi.fn(),
  }

  beforeEach(() => {
    for (const v of Object.values(callbacks)) {
      ;(v as ReturnType<typeof vi.fn>).mockReset()
    }
  })

  it('text_delta → onTextDelta', () => {
    dispatchEventToCallbacks({ type: 'text_delta', text: 'x' }, callbacks)
    expect(callbacks.onTextDelta).toHaveBeenCalledWith('x')
  })

  it('tool_start → onToolStart', () => {
    const tu = { id: 't1', name: 'echo', input: {} }
    dispatchEventToCallbacks({ type: 'tool_start', toolUse: tu }, callbacks)
    expect(callbacks.onToolStart).toHaveBeenCalledWith(tu)
  })

  it('tool_input_delta → onToolInputDelta', () => {
    const sparseWithInputDelta: AgenticLoopCallbacks = {
      ...callbacks,
      onToolInputDelta: vi.fn(),
    }
    dispatchEventToCallbacks(
      {
        type: 'tool_input_delta',
        toolUseId: 't1',
        toolName: 'write_file',
        partialJson: '{"filePath":"foo.ts","content":"hel',
      },
      sparseWithInputDelta,
    )
    expect(sparseWithInputDelta.onToolInputDelta).toHaveBeenCalledWith({
      toolUseId: 't1',
      toolName: 'write_file',
      partialJson: '{"filePath":"foo.ts","content":"hel',
    })
  })

  it('tool_result → onToolResult', () => {
    const tr = { id: 't1', name: 'echo', success: true, output: 'ok' }
    dispatchEventToCallbacks({ type: 'tool_result', toolResult: tr }, callbacks)
    expect(callbacks.onToolResult).toHaveBeenCalledWith(tr)
  })

  it('message_end → onMessageEnd', () => {
    const usage = { inputTokens: 1, outputTokens: 2 }
    dispatchEventToCallbacks({ type: 'message_end', usage }, callbacks)
    expect(callbacks.onMessageEnd).toHaveBeenCalledWith(usage)
  })

  it('error → onError', () => {
    dispatchEventToCallbacks({ type: 'error', error: 'boom' }, callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith('boom')
  })

  it('context_compact → onContextCompact', () => {
    dispatchEventToCallbacks(
      {
        type: 'context_compact',
        level: 'micro_compact',
        preTokens: 80_000,
        postTokens: 60_000,
        reclaimedTokens: 20_000,
      },
      callbacks,
    )
    expect(callbacks.onContextCompact).toHaveBeenCalledWith({
      level: 'micro_compact',
      preTokens: 80_000,
      postTokens: 60_000,
      reclaimedTokens: 20_000,
    })
  })

  it('max_iterations → onMaxIterationsReached', () => {
    dispatchEventToCallbacks({ type: 'max_iterations', maxIterations: 50 }, callbacks)
    expect(callbacks.onMaxIterationsReached).toHaveBeenCalledWith(50)
  })

  it('thinking_delta / thinking_block / pre_model / stop_hook / streaming_fallback all dispatch', () => {
    dispatchEventToCallbacks({ type: 'thinking_delta', text: 't' }, callbacks)
    dispatchEventToCallbacks({ type: 'thinking_block', block: { thinking: 'tt' } }, callbacks)
    dispatchEventToCallbacks(
      {
        type: 'pre_model',
        info: { iteration: 1, phases: [], snippedCount: 0, wasContextManaged: false },
      },
      callbacks,
    )
    dispatchEventToCallbacks({ type: 'stop_hook', info: { iteration: 1, action: 'continue' } }, callbacks)
    dispatchEventToCallbacks(
      { type: 'streaming_fallback', info: { status: 529, reason: 'overload' } },
      callbacks,
    )
    expect(callbacks.onThinkingDelta).toHaveBeenCalled()
    expect(callbacks.onThinkingBlock).toHaveBeenCalled()
    expect(callbacks.onQueryLoopPreModel).toHaveBeenCalled()
    expect(callbacks.onQueryLoopStopHook).toHaveBeenCalled()
    expect(callbacks.onStreamingFallback).toHaveBeenCalled()
  })

  it('reasoning_summary_delta → onReasoningSummaryDelta', () => {
    // Per the exhaustiveness-contract docstring at the top of the
    // describe block: every LoopEvent variant must have its own
    // dispatch test so a future case missing from the switch fails
    // here at runtime (the `default: never` only catches the bug at
    // type-check time, which is silenced inside the test file).
    dispatchEventToCallbacks(
      { type: 'reasoning_summary_delta', text: 'I considered ' },
      callbacks,
    )
    expect(callbacks.onReasoningSummaryDelta).toHaveBeenCalledWith('I considered ')
  })

  it('reasoning_summary_block → onReasoningSummaryBlock', () => {
    const block = {
      text: 'I considered two approaches.',
      thinkingTimeMs: 600,
      thinkingTokens: 120,
    }
    dispatchEventToCallbacks(
      { type: 'reasoning_summary_block', block },
      callbacks,
    )
    expect(callbacks.onReasoningSummaryBlock).toHaveBeenCalledWith(block)
  })

  it('optional callback fields are safely skipped when undefined', () => {
    const sparse: AgenticLoopCallbacks = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onMessageEnd: vi.fn(),
      onError: vi.fn(),
      // Everything else intentionally undefined.
    }
    expect(() =>
      dispatchEventToCallbacks({ type: 'context_compact', level: 'ok' }, sparse),
    ).not.toThrow()
    expect(() =>
      dispatchEventToCallbacks({ type: 'thinking_delta', text: 't' }, sparse),
    ).not.toThrow()
  })
})
