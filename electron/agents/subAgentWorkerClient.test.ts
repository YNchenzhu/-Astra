/**
 * Regression test for the worker → renderer event translation layer.
 *
 * The previous implementation forwarded raw `LoopEvent`s (`text_delta`,
 * `tool_start`, …) verbatim. The renderer's `subAgentStreamRouter` only
 * whitelists `subagent_*` types, so every intermediate event was silently
 * dropped and the AgentBlock was stuck on `starting…`. This test pins the
 * mapping so the bug can never silently come back.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSubAgentWorkerMessages,
  deriveWorkerSubAgentSuccess,
  loopEventToSubAgentEvent,
  windDownMessageToSubAgentEvent,
} from './subAgentWorkerClient'
import { asAgentId } from '../tools/ids'
import type { LoopEvent } from '../ai/loopEvents'

const aid = asAgentId('agent-test-1')

describe('loopEventToSubAgentEvent', () => {
  it('translates text_delta → subagent_text', () => {
    const out = loopEventToSubAgentEvent({ type: 'text_delta', text: 'hi' }, aid)
    expect(out).toEqual({ type: 'subagent_text', agentId: aid, text: 'hi' })
  })

  it('translates thinking_delta → subagent_thinking_delta', () => {
    const out = loopEventToSubAgentEvent(
      { type: 'thinking_delta', text: 'pondering' },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_thinking_delta',
      agentId: aid,
      text: 'pondering',
    })
  })

  it('translates thinking_block → subagent_thinking_block_complete', () => {
    const block = { thinking: 'reasoned text', signature: 'sig-abc' }
    const out = loopEventToSubAgentEvent({ type: 'thinking_block', block }, aid)
    expect(out).toEqual({
      type: 'subagent_thinking_block_complete',
      agentId: aid,
      thinkingBlock: block,
    })
  })

  it('translates reasoning_summary_delta → subagent_reasoning_summary_delta', () => {
    // Distinct from thinking — providers (OpenAI Responses) may emit
    // summaries without ever emitting raw thinking, and the renderer
    // surfaces the two as separate UI rows.
    const out = loopEventToSubAgentEvent(
      { type: 'reasoning_summary_delta', text: 'I considered ' },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_reasoning_summary_delta',
      agentId: aid,
      text: 'I considered ',
    })
  })

  it('translates reasoning_summary_block → subagent_reasoning_summary_block_complete', () => {
    const block = { text: 'I considered two approaches.', thinkingTimeMs: 600, thinkingTokens: 120 }
    const out = loopEventToSubAgentEvent(
      { type: 'reasoning_summary_block', block },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_reasoning_summary_block_complete',
      agentId: aid,
      reasoningSummaryBlock: block,
    })
  })

  it('translates tool_start → subagent_tool_start', () => {
    const toolUse = { id: 't1', name: 'read_file', input: { filePath: 'a.ts' } }
    const out = loopEventToSubAgentEvent({ type: 'tool_start', toolUse }, aid)
    expect(out).toEqual({
      type: 'subagent_tool_start',
      agentId: aid,
      toolUse,
    })
  })

  it('translates tool_input_delta → subagent_tool_input_delta', () => {
    // IDE-style live writing inside a sub-agent. Worker path
    // mirror of the in-process subAgentRunner.onToolInputDelta wiring.
    const out = loopEventToSubAgentEvent(
      {
        type: 'tool_input_delta',
        toolUseId: 't-write-1',
        toolName: 'write_file',
        partialJson: '{"filePath":"a.ts","content":"hel',
      },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_tool_input_delta',
      agentId: aid,
      toolUseId: 't-write-1',
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hel',
    })
  })

  it('translates tool_result → subagent_tool_result', () => {
    const toolResult = { id: 't1', name: 'read_file', success: true, output: 'ok' }
    const out = loopEventToSubAgentEvent(
      { type: 'tool_result', toolResult },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_tool_result',
      agentId: aid,
      toolResult,
    })
  })

  it('forwards structured error fields (toolErrorClass / errorWhat / errorTried / errorContext / errorNext) on failures (audit fix B2)', () => {
    // Regression target: prior to audit fix B2 the subagent wire types
    // narrowed `toolResult` to `{id, name, success, output?, error?}`,
    // which meant the structured failure fields populated by
    // `buildToolFailure(...)` were silently dropped when a sub-agent's
    // tool failed. The renderer's `StructuredErrorView` then fell back
    // to a raw `<pre>`. This test pins the contract: every field that
    // exists on the source `toolResult` must reach `subagent_tool_result`
    // verbatim (object identity even).
    const toolResult = {
      id: 't2',
      name: 'read_file',
      success: false,
      error: 'read_file: file not found: src/foo.ts\nTried: ...\nNext: ...',
      toolErrorClass: 'not_found' as const,
      errorWhat: 'read_file: file not found: src/foo.ts',
      errorTried: ['/ws/src/foo.ts'],
      errorContext: { workspace: '/ws' },
      errorNext: ['Use glob to discover the file'],
    }
    const out = loopEventToSubAgentEvent(
      { type: 'tool_result', toolResult },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_tool_result',
      agentId: aid,
      toolResult,
    })
    // Spot-check the structured fields are reachable on the forwarded payload.
    if (out.type !== 'subagent_tool_result') throw new Error('discriminant')
    expect(out.toolResult.toolErrorClass).toBe('not_found')
    expect(out.toolResult.errorWhat).toBe('read_file: file not found: src/foo.ts')
    expect(out.toolResult.errorTried).toEqual(['/ws/src/foo.ts'])
    expect(out.toolResult.errorContext).toEqual({ workspace: '/ws' })
    expect(out.toolResult.errorNext).toEqual(['Use glob to discover the file'])
  })

  it('translates error → subagent_error', () => {
    const out = loopEventToSubAgentEvent({ type: 'error', error: 'boom' }, aid)
    expect(out).toEqual({ type: 'subagent_error', agentId: aid, error: 'boom' })
  })

  // Phase D (granularity uplift): three previously-dropped LoopEvent
  // types now translate to typed `subagent_*` events. This is a
  // deliberate widening of the worker → renderer surface so the
  // AgentBlock can observe per-iteration usage, compact signals, and
  // limit-reached badges without waiting for `subagent_complete`. The
  // matching in-process emissions live in `subAgentRunner.ts`
  // (`onMessageEnd` / `onContextCompact` / `onMaxIterationsReached`).
  it('translates message_end with usage → subagent_message_end (usage forwarded)', () => {
    const out = loopEventToSubAgentEvent(
      { type: 'message_end', usage: { inputTokens: 123, outputTokens: 45 } },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_message_end',
      agentId: aid,
      usage: { inputTokens: 123, outputTokens: 45 },
    })
  })

  it('translates message_end without usage → subagent_message_end (no usage field)', () => {
    const out = loopEventToSubAgentEvent({ type: 'message_end' }, aid)
    expect(out).toEqual({ type: 'subagent_message_end', agentId: aid })
  })

  it('translates context_compact → subagent_context_compact (level stringified)', () => {
    const out = loopEventToSubAgentEvent(
      { type: 'context_compact', level: 'auto_compact' },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_context_compact',
      agentId: aid,
      level: 'auto_compact',
    })
  })

  it('translates max_iterations → subagent_max_iterations (limit forwarded)', () => {
    const out = loopEventToSubAgentEvent(
      { type: 'max_iterations', maxIterations: 30 },
      aid,
    )
    expect(out).toEqual({
      type: 'subagent_max_iterations',
      agentId: aid,
      maxIterations: 30,
    })
  })

  // Events that intentionally stay unrouted — surfacing them would be
  // UI noise with no current consumer (`pre_model` fires every
  // iteration; `stop_hook` and `streaming_fallback` are internal
  // recovery signals that the parent agentic loop handles inline).
  it.each<LoopEvent>([
    {
      type: 'pre_model',
      info: {
        iteration: 1,
        phases: [],
        snippedCount: 0,
        wasContextManaged: false,
      },
    },
    { type: 'stop_hook', info: { iteration: 1, action: 'end' } },
    { type: 'streaming_fallback', info: { status: 529, reason: 'overload' } },
  ])('returns null for unrouted LoopEvent type=$type', (ev) => {
    expect(loopEventToSubAgentEvent(ev, aid)).toBeNull()
  })

  it('uses the supplied agentId verbatim (no rebranding / mutation)', () => {
    const out = loopEventToSubAgentEvent({ type: 'text_delta', text: 'x' }, aid)
    expect(out?.agentId).toBe(aid)
  })
})

describe('buildSubAgentWorkerMessages', () => {
  // Regression — the previous inline version did
  //
  //   messages = [{role:'user', content: prompt}]   // fresh path
  //   if (!parentMessages || parentMessages.length === 0) messages.push({...prompt}) // also fresh
  //
  // which appended the prompt TWICE whenever the caller passed no
  // parentMessages. That path is exactly the team-auto-launch + fresh
  // background spawn case, where the duplicate burned tokens on every
  // first turn and made the prompt confusing to the model.
  it('returns a single {user, prompt} message for fresh agents (no parentMessages)', () => {
    const out = buildSubAgentWorkerMessages('do the thing', undefined)
    expect(out).toEqual([{ role: 'user', content: 'do the thing' }])
  })

  it('also returns a single {user, prompt} message when parentMessages is empty', () => {
    const out = buildSubAgentWorkerMessages('do the thing', [])
    expect(out).toEqual([{ role: 'user', content: 'do the thing' }])
  })

  it('fork mode clones parentMessages verbatim (does not re-append prompt)', () => {
    const parent: Array<Record<string, unknown>> = [
      { role: 'user', content: 'context-a' },
      { role: 'assistant', content: 'reply-a' },
      { role: 'user', content: 'real task with full context already' },
    ]
    const out = buildSubAgentWorkerMessages('ignored-in-fork', parent)
    expect(out).toEqual(parent)
    // Must NOT add an extra `{role:user, content:'ignored-in-fork'}` at the tail.
    expect(out[out.length - 1]?.content).toBe('real task with full context already')
  })

  it('fork mode deep-clones (mutating result does not bleed into parentMessages)', () => {
    const parent: Array<Record<string, unknown>> = [
      { role: 'user', content: 'original' },
    ]
    const out = buildSubAgentWorkerMessages('x', parent)
    ;(out[0] as { content: string }).content = 'mutated'
    expect(parent[0]?.content).toBe('original')
  })
})

describe('deriveWorkerSubAgentSuccess (P1 audit fix)', () => {
  // Regression: the worker `done` branch used to set
  //   `success: budgetAbortReason === null`
  // which silently reported success for max_turns terminations and
  // parent-aborted runs. The in-process path uses
  //   `success = !aborted && !reachedMaxIterations`
  // and the worker path now matches via this helper.

  it('returns true when nothing went wrong', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: null,
        reachedMaxIterations: false,
      }),
    ).toBe(true)
  })

  it('returns false when the parent abort signal fired (user pressed Stop)', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: true,
        budgetAbortReason: null,
        reachedMaxIterations: false,
      }),
    ).toBe(false)
  })

  it('returns false when an internal token / tool-call budget tripped', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: 'Explore token budget exceeded (33000/32000)',
        reachedMaxIterations: false,
      }),
    ).toBe(false)
  })

  it('returns false when the agentic loop hit max_turns (terminationResult.reason === "max_turns")', () => {
    // This is the regression fix: previously success was true here.
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: null,
        reachedMaxIterations: true,
      }),
    ).toBe(false)
  })

  it('returns false when multiple failure signals coincide', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: true,
        budgetAbortReason: 'budget',
        reachedMaxIterations: true,
      }),
    ).toBe(false)
  })

  it('treats empty-string budget reason like a real reason (truthy guard belongs in the producer, not here)', () => {
    // Producer sets `budgetAbortReason: string | null` — empty string is
    // semantically "no reason yet" but we accept it as `success: false`
    // anyway because some abort entered the path. The producer is
    // responsible for never passing '' for active aborts. Documenting
    // here so the helper's strictness is explicit.
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: '',
        reachedMaxIterations: false,
      }),
    ).toBe(false)
  })

  // Output-aware relaxation: a run that hit a limit but still committed a
  // usable final report (via wind-down or the rescue turn) now succeeds.
  it('returns true when max_turns was hit BUT a usable report was produced', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: null,
        reachedMaxIterations: true,
        producedReport: true,
      }),
    ).toBe(true)
  })

  it('returns true when an internal budget aborted BUT a usable report was produced', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: 'Explore token budget exceeded (130000/120000)',
        reachedMaxIterations: false,
        producedReport: true,
      }),
    ).toBe(true)
  })

  it('a produced report NEVER rescues a true user cancel', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: true,
        budgetAbortReason: null,
        reachedMaxIterations: true,
        producedReport: true,
      }),
    ).toBe(false)
  })

  it('producedReport:false behaves like the original limit-only rule', () => {
    expect(
      deriveWorkerSubAgentSuccess({
        signalAborted: false,
        budgetAbortReason: null,
        reachedMaxIterations: true,
        producedReport: false,
      }),
    ).toBe(false)
  })
})

describe('windDownMessageToSubAgentEvent (worker → renderer)', () => {
  it('maps an iteration trigger with iteration/cap', () => {
    const ev = windDownMessageToSubAgentEvent(aid, {
      trigger: 'iterations',
      iteration: 19,
      maxIterations: 20,
    })
    expect(ev).toEqual({
      type: 'subagent_winddown',
      agentId: aid,
      trigger: 'iterations',
      iteration: 19,
      maxIterations: 20,
    })
  })

  it('omits iteration/cap for tool/token triggers', () => {
    const ev = windDownMessageToSubAgentEvent(aid, { trigger: 'tokens' })
    expect(ev).toEqual({ type: 'subagent_winddown', agentId: aid, trigger: 'tokens' })
    expect('iteration' in ev).toBe(false)
    expect('maxIterations' in ev).toBe(false)
  })
})
