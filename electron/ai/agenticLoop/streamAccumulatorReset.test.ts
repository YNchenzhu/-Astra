/**
 * Regression test for the `onStreamingFallback` accumulator-reset contract.
 *
 * Before Step 3 of the thinking-block work (per-`content_block_stop`
 * emission), the SDK-path provider only fired `onThinkingBlock` at
 * `finalMessage()` — so a 529 thrown by `finalMessage()` happened before
 * any partial thinking blocks could land in `localThinking`. After Step
 * 3, partial thinking blocks CAN already be in `localThinking` when the
 * 529 fires. The non-streaming retry then replays the full new message,
 * re-emitting every thinking block from scratch. If we forget to clear
 * the partial accumulators, those leftover entries get double-counted
 * into the final `thinkingBlocks` payload sent upstream — corrupting
 * the cross-turn replay context and (worst case) shipping a stale
 * signature back to the API for a 400 on the next turn.
 *
 * This test pins the reset behaviour at the smallest testable seam so
 * a future refactor of the inline handler can't silently regress it.
 */

import { describe, it, expect } from 'vitest'
import { resetStreamAccumulators } from './streamAccumulatorReset'

describe('resetStreamAccumulators (onStreamingFallback contract)', () => {
  it('truncates every accumulator in place (preserves array references for downstream closures)', () => {
    const toolUses: Array<{ id: string }> = [{ id: 't1' }, { id: 't2' }]
    const serverToolUses: Array<{ id: string }> = [{ id: 's1' }]
    const codeExecResults: Array<{ toolUseId: string }> = [{ toolUseId: 'r1' }]
    const thinking: Array<{ thinking: string; signature?: string }> = [
      { thinking: 'partial-A', signature: 'sig-A-incomplete' },
      { thinking: 'partial-B' },
    ]

    // Capture the reference identities BEFORE the reset so we can prove
    // the helper truncates in place rather than swapping new empty
    // arrays in. The provider callbacks captured these references via
    // closure at registration time; if we replace the arrays the
    // callbacks would push onto orphaned references and the rebuild
    // would never populate them.
    const refIdentity = { toolUses, serverToolUses, codeExecResults, thinking }

    resetStreamAccumulators(refIdentity)

    expect(refIdentity.toolUses).toEqual([])
    expect(refIdentity.serverToolUses).toEqual([])
    expect(refIdentity.codeExecResults).toEqual([])
    expect(refIdentity.thinking).toEqual([])
    // Reference identity preserved — these are the ORIGINAL arrays,
    // just truncated. Pushing onto them must still feed the same
    // closures that consume them downstream.
    expect(refIdentity.toolUses).toBe(toolUses)
    expect(refIdentity.serverToolUses).toBe(serverToolUses)
    expect(refIdentity.codeExecResults).toBe(codeExecResults)
    expect(refIdentity.thinking).toBe(thinking)
  })

  it('SDK-path scenario: partial thinking blocks from a failed stream are cleared before fallback emissions', () => {
    // End-to-end shape of the regression scenario this helper exists for:
    //   1. Stream starts. SDK emits content_block_start/delta/stop for
    //      thinking-A → onThinkingBlock(A) fires → localThinking gets A.
    //   2. SDK emits start/delta for thinking-B (partial — no stop yet).
    //   3. `finalMessage()` throws 529.
    //   4. Provider invokes `onStreamingFallback({status: 529, ...})`.
    //   5. Helper truncates localThinking — A and B's partial entry both gone.
    //   6. Non-streaming retry replays the full new message → fresh
    //      onThinkingBlock calls populate localThinking from empty.
    //
    // What we assert here: step 5 leaves the array EMPTY (not just A's
    // entry removed) so step 6 doesn't merge stale block-A signatures
    // back into the new turn's payload.
    const localThinking: Array<{ thinking: string }> = [
      { thinking: 'A-complete-but-from-failed-stream' },
      // B never got content_block_stop on the failed stream; whatever
      // partial state would have been emitted is also gone — but here
      // we're testing the post-onStreamingFallback state, which only
      // sees the COMPLETE entries (the helper doesn't see the
      // accumulator's own internal map).
    ]
    const refs = {
      toolUses: [] as unknown[],
      serverToolUses: [] as unknown[],
      codeExecResults: [] as unknown[],
      thinking: localThinking,
    }

    resetStreamAccumulators(refs)

    expect(localThinking).toEqual([])
  })

  it('is idempotent — calling on already-empty refs is a no-op', () => {
    const refs = {
      toolUses: [] as unknown[],
      serverToolUses: [] as unknown[],
      codeExecResults: [] as unknown[],
      thinking: [] as unknown[],
    }
    resetStreamAccumulators(refs)
    resetStreamAccumulators(refs) // second call

    expect(refs.toolUses).toEqual([])
    expect(refs.serverToolUses).toEqual([])
    expect(refs.codeExecResults).toEqual([])
    expect(refs.thinking).toEqual([])
  })

  it('truncates each accumulator independently (mixed-populated input)', () => {
    // Real-world fallback often has a mix: tool_use partially-streamed
    // (so localToolUses has an entry), text streamed (only `accText`,
    // which is reset separately), thinking already-stopped (localThinking
    // has the canonical entry). Helper must clear them all uniformly.
    const refs = {
      toolUses: [{ id: 'mid-stream-tool' }],
      serverToolUses: [] as unknown[],
      codeExecResults: [] as unknown[],
      thinking: [{ thinking: 'a complete pre-529 thinking block', signature: 'sig' }],
    }
    resetStreamAccumulators(refs)
    expect(refs.toolUses).toEqual([])
    expect(refs.thinking).toEqual([])
  })
})
