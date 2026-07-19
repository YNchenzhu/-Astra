/**
 * Inner-loop phase event emitter.
 *
 * Wraps the boilerplate needed to fire an `orchestration_phase` stream
 * event from inside the agentic loop's phase modules (`toolExec.ts`,
 * `noTools.ts`). Reuses the kernel's typed phase contract so renderer
 * subscribers see the same wire shape as the outer FSM phases
 * (`PrepareContext` / `CallModel` / `Terminal` / `Error`).
 *
 * # Why a dedicated emitter
 *
 * The 4 outer FSM phases are emitted via `KernelPhaseCtx.emitPhase` —
 * the phase modules in `electron/orchestration/phases/` receive a
 * kernel-bound context object that knows the transport + conversationId.
 *
 * The inner phases (`RunToolBatch` / `ApplyToolResults` / `ResolveStop` /
 * `StopHooksOrContinue`) fire from `electron/ai/agenticLoop/` modules
 * that do NOT receive a `KernelPhaseCtx` — they live one layer deeper
 * and only have access to `LoopState` + the ambient `AgentContext`. This
 * helper resolves `streamConversationId` from the ALS context and routes
 * the event through `emitStreamEventForConversation`, the same main-
 * process-wide bridge `toolExec.ts` already uses for its HITL phase
 * events.
 *
 * No-op when there's no conversation id bound to the current call
 * stack (e.g. unit tests that drive the loop without registering a
 * kernel) — the renderer wouldn't be listening anyway.
 */

import { getAgentContext } from '../../agents/agentContext'
import { emitStreamEventForConversation } from '../interactionState'
import {
  buildKernelFsmPhase,
  createTransportAdapter,
  emitPhaseEvent,
} from '../../orchestration/transport'
import type { KernelTurnPhase } from '../../orchestration/kernelTypes'

/**
 * Emit an inner-loop phase event for the current conversation. Safe to
 * call from any agentic-loop phase module; no-op when no conversation
 * id is bound to the call stack.
 *
 * @param phase Which inner phase fired. MUST be one of the inner-loop
 *              tags from {@link KernelTurnPhase}; passing an outer FSM
 *              tag (`PrepareContext` etc.) is type-allowed but should
 *              go through `KernelPhaseCtx.emitPhase` instead — the
 *              outer phases also flip `state.phase` on the kernel.
 * @param iteration Current iteration counter (from `LoopState.iteration`).
 *                  Threaded through to the renderer so timeline UIs can
 *                  group inner-phase events under the right outer-turn
 *                  envelope.
 */
export function emitInnerPhase(
  phase: KernelTurnPhase,
  iteration: number,
): void {
  const conversationId = getAgentContext()?.streamConversationId?.trim()
  if (!conversationId) return
  const transport = createTransportAdapter((ev) =>
    emitStreamEventForConversation(
      conversationId,
      ev as unknown as Record<string, unknown>,
    ),
  )
  emitPhaseEvent(
    transport,
    buildKernelFsmPhase({
      phase,
      iteration,
      conversationId,
    }),
  )
}
