/**
 * CallModel phase — invokes the agentic loop (or drive-mode override) inside a
 * phase span. Builds the augmented `AgenticLoopParams` that wires:
 *
 *   - merged abort signal (caller signal ∪ kernel signal)
 *   - Host transcript commit + per-iteration atomic inbox drain
 *   - orchestrated tool execution port
 *   - AppendixA reporter iteration tracking
 *   - AgentContext fields so sub-agents inherit the kernel's ToolRuntimePort
 *
 * On thrown error, transitions the state to `'Error'` and emits the phase event.
 * Re-throwing is the caller's responsibility (so Terminal still runs in the
 * outer `finally`).
 */

import { runAgenticLoop, type AgenticLoopCallbacks, type AgenticLoopParams } from './iteration'
import { getAgentContext } from '../../agents/agentContext'
import { mergeAbortSignals } from '../../ai/toolExecutionScope'
import { withPhaseSpan } from '../observability'
import { applyTranscriptCommit } from '../sessionCommands'
import { cloneTranscript, fingerprintTranscript } from '../kernelTypes'
import { buildTranscriptConflictPhase, emitPhaseEvent } from '../transport'
import { toolRegistry } from '../../tools/registry'
import type { KernelPhaseCtx } from './types'

export type CallModelPhaseParams = {
  agenticParams: AgenticLoopParams
  agenticCallbacks: AgenticLoopCallbacks
  /**
   * Drive-mode override — when supplied, this is called instead of
   * {@link runAgenticLoop}. The override sees the same augmented params.
   */
  runCallModel?: (
    agenticParams: AgenticLoopParams,
    callbacks: AgenticLoopCallbacks,
  ) => Promise<void>
}

/**
 * Throws ONLY if the inner `callModel` invocation throws. On throw, sets state
 * phase to `'Error'` and emits the phase event before re-throwing (the caller's
 * try/catch still owns post-throw cleanup).
 */
export async function runCallModelPhase(
  ctx: KernelPhaseCtx,
  params: CallModelPhaseParams,
): Promise<void> {
  ctx.setState({ ...ctx.state, phase: 'CallModel' })
  ctx.emitPhase('CallModel')

  try {
    await withPhaseSpan(ctx.observer, 'CallModel', ctx.state.iteration, async () => {
      const messagesForLoop = ctx.state.transcript.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string | Array<Record<string, unknown>>,
      }))
      const perm = ctx.ports.permission
      const wrappedAppendixA = ctx.wrapAppendixAReporterWithIterationTracking(
        params.agenticParams.appendixAFlow,
      )
      // Per-iteration inbox drain callback: atomically commits inbox messages in the
      // Kernel and hands the accepted snapshot to the AgentLoop.
      let loopRevision = ctx.state.transcriptRevision
      const drainFn = () => {
        const drained = ctx.drainInboxForInnerIteration()
        loopRevision = drained.injected
          ? drained.snapshot.revision
          : ctx.state.transcriptRevision
        return drained
      }
      // Merge caller signal with kernel-owned signal so `kernel.interrupt(reason)`
      // cascades into every tool + streamText running inside the loop.
      const mergedSignal = mergeAbortSignals(
        params.agenticParams.signal,
        ctx.abortController.signal,
      )
      // P0-2 — hard-lane signal for `interruptBehavior: 'block'` tools. Caller signal
      // (process shutdown) is still merged in; kernel.soft is NOT — only kernel.hard.
      // 'block' tools keep running through a soft user interrupt and only abort on:
      //   - process exit / caller shutdown (merged in here),
      //   - explicit `interrupt(..., { hard: true })` (renderer "second Stop" UX),
      //   - or the kernel's auto-grace promotion (default 30s).
      const hardSignal = mergeAbortSignals(
        params.agenticParams.signal,
        ctx.hardAbortController.signal,
      )
      const resolveToolSignal = (
        toolName: string,
        input: Record<string, unknown>,
      ): AbortSignal | undefined => {
        try {
          const tool = toolRegistry.get(toolName)
          const ib = tool?.interruptBehavior
          let resolved: 'cancel' | 'block' | undefined
          if (typeof ib === 'function') {
            // The function signature is one of `() => ...` or `(input) => ...`;
            // both shapes accept being called with `input` (JS optional arg).
            resolved = (ib as (i?: Record<string, unknown>) => 'cancel' | 'block')(input)
          } else if (typeof ib === 'string') {
            resolved = ib
          }
          if (resolved === 'block') return hardSignal
        } catch {
          /* fall through to soft on lookup failure */
        }
        return mergedSignal
      }
      // Inject kernel's ToolRuntimePort into AgentContext so sub-agents spawned
      // inside this loop inherit the orchestrated path. Also publish
      // `parentKernelGetState` + `parentNoteToolInvocation` so sub-agents forward
      // truthful kernel state and permission-port counts.
      const agentCtx = getAgentContext()
      if (agentCtx) {
        agentCtx.toolRuntimePort = ctx.ports.tools
        agentCtx.parentKernelGetState = () => ctx.state
        agentCtx.parentNoteToolInvocation = (toolName: string) => {
          try {
            perm.noteToolInvocation?.(toolName)
          } catch {
            /* ignore */
          }
        }
      }
      const builtAgenticParams: AgenticLoopParams = {
        ...params.agenticParams,
        messages: messagesForLoop,
        signal: mergedSignal,
        ...(wrappedAppendixA ? { appendixAFlow: wrappedAppendixA } : {}),
        // P0 fix (audit §4.1) — seed the inner loop's soft-cap counters
        // from kernel state so restart-recovery is faithful. Reverse-sync
        // happens at every inner iteration in `phases/iteration.ts` via
        // `kernel.syncMetaCounters({...})` immediately before the
        // throttled `kernel.persist()` writes them to disk.
        seedMetaCounters: {
          maxOutputRecoveryCycles: ctx.state.maxOutputRecoveryCycles,
          consecutiveCompactFailures: ctx.state.consecutiveCompactFailures,
        },
        orchestratedToolExecution: {
          port: ctx.ports.tools,
          getKernelState: () => ctx.state,
          noteToolInvocation: (toolName) => {
            try {
              perm.noteToolInvocation?.(toolName)
            } catch {
              /* ignore */
            }
          },
          resolveToolSignal,
        },
        hostTranscript: {
          drainInbox: drainFn,
          commit: (snap) => {
            const committed = applyTranscriptCommit(ctx.state, {
              baseRevision: loopRevision,
              source: 'agent_loop',
              messages: cloneTranscript(snap),
            })
            if (!committed.result.ok) {
              emitPhaseEvent(
                ctx.ports.transport,
                buildTranscriptConflictPhase({
                  iteration: ctx.state.iteration,
                  innerIteration: ctx.state.innerIteration,
                  conversationId: ctx.streamConversationId,
                  transcriptConflict: {
                    source: 'agent_loop',
                    expectedRevision: committed.result.expectedRevision,
                    actualRevision: committed.result.actualRevision,
                    incomingFingerprintPrefix: fingerprintTranscript(snap).slice(0, 12),
                    currentFingerprintPrefix: ctx.state.transcriptFingerprint.slice(0, 12),
                  },
                }),
              )
              throw new Error(
                `Transcript revision conflict: expected=${committed.result.expectedRevision} ` +
                  `actual=${committed.result.actualRevision}`,
              )
            }
            ctx.setState(committed.state)
            loopRevision = committed.result.snapshot.revision
          },
        },
      }
      // Drive mode injects its own `runCallModel` that owns the inner `while` loop.
      // Legacy callers (no override) keep going through `runAgenticLoop` which has
      // its own internal while.
      const callModel = params.runCallModel ?? runAgenticLoop
      await callModel(builtAgenticParams, params.agenticCallbacks)
    })
  } catch (e) {
    ctx.setState({ ...ctx.state, phase: 'Error' })
    ctx.emitPhase('Error')
    throw e
  }
}
