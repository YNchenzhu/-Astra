/**
 * Process-wide singleton {@link MultiAgentOrchestrator} that the Agent tool
 * registers spawned sub-agents into.
 *
 * Why this exists — `MultiAgentOrchestrator` was originally written for the
 * (still-flag-gated) orchestration kernel migration: each spawned child
 * kernel registers parent/child edges so operator UI can `interruptTree` /
 * `pauseTree` and the orchestrator can enforce concurrency ceilings.
 *
 * In the legacy production path sub-agents don't own a full kernel — they
 * run under `runSubAgent` with a plain `AbortController`. Wrapping that
 * abort signal in a {@link CancellableKernelLike} shim gets us the
 * orchestrator's parent/child bookkeeping for free without forcing the
 * caller to construct a kernel just to be tracked. `pause` / `resume` are
 * intentionally no-ops on the shim — the legacy path has no cooperative
 * pause point; only `interrupt` (= abort) is meaningful today.
 *
 * Concurrency limit deliberately matches `MAX_PARALLEL_AGENT_TOOL_CALLS`
 * (= 6, the per-batch ceiling for Agent tool calls). This is the orchestrator's
 * PER-PARENT fan-out cap and is actively enforced today — `agentTool.ts` and
 * `teamAutoLauncher.ts` call `enforceConcurrencyLimit(parentKernelId)` at each
 * spawn site before constructing a child.
 *
 * It is a separate axis from `activeAgentRegistry.MAX_CONCURRENT_AGENTS` (= 10),
 * the PROCESS-WIDE total enforced in `registerActiveAgent`. A spawn must pass
 * BOTH: this caps one parent's direct children, the registry cap is the global
 * hard backstop. See the field doc on `MultiAgentOrchestrator.maxConcurrentChildren`
 * for the full relationship.
 */

import {
  MultiAgentOrchestrator,
  createInMemoryMailboxPort,
  type CancellableKernelLike,
  type InterAgentMailboxPort,
} from '../orchestration/multiAgent'
import { concreteWorktreeAllocator } from '../orchestration/worktreeAllocator'
import type { KernelInterruptReason } from '../orchestration/kernel'
import { MAX_PARALLEL_AGENT_TOOL_CALLS } from '../constants/toolLimits'
import {
  getToolOrchestrator,
  type ToolOrchestrator,
} from '../orchestration/toolRuntime/orchestrator'

let instance: MultiAgentOrchestrator | undefined

export function getMultiAgentOrchestrator(): MultiAgentOrchestrator {
  if (!instance) {
    instance = new MultiAgentOrchestrator({
      maxConcurrentChildren: MAX_PARALLEL_AGENT_TOOL_CALLS,
      worktreeAllocator: concreteWorktreeAllocator,
      // Audit fix M-3 — default to a REAL bounded directed mailbox instead of
      // the decorative noop. `deliverMailboxLine` now lands in a queryable
      // (drain/peek/size) per-recipient queue; the ALS `pendingMessages` path
      // stays the live consumer channel until a future migration drains here.
      mailboxPort: createInMemoryMailboxPort(),
    })
  }
  return instance
}

/**
 * When `POLE_TOOL_ORCHESTRATION=1`, return the unified ToolOrchestrator
 * which wraps the legacy MultiAgentOrchestrator and adds tool-level
 * scheduling, policy, quota, and cross-agent visibility.
 *
 * Callers that only need agent-level APIs can keep using
 * `getMultiAgentOrchestrator()`. Callers that want tool-level
 * orchestration should migrate to this function.
 */
export function getUnifiedOrchestrator(): ToolOrchestrator {
  return getToolOrchestrator({ agentOrchestrator: getMultiAgentOrchestrator() })
}

/** Test helper — reset the singleton between suites. */
export function resetMultiAgentOrchestratorForTests(): void {
  instance?.clearForTests()
  instance = undefined
}

/**
 * P1 (audit §3.1 wire-up) — runtime swap of the singleton's
 * {@link InterAgentMailboxPort}. Plugins / bundles that load after the
 * orchestrator was constructed (the common case) call this to install a
 * port adapter that bridges to their own delivery backend (durable queue,
 * NATS/Kafka, telemetry sink, etc.). Returns the previously-installed port
 * so adapters can be stacked (decorator pattern) — e.g. an observer port
 * that fans out to telemetry AND delegates to the original noop port.
 */
export function setMailboxPortForSingleton(
  port: InterAgentMailboxPort,
): InterAgentMailboxPort {
  return getMultiAgentOrchestrator().setMailboxPort(port)
}

/**
 * Wrap an `AbortController` as a {@link CancellableKernelLike} so the
 * orchestrator can hold onto it without caring whether the underlying
 * agent owns a real `OrchestrationKernel`.
 */
export function abortControllerToKernelShim(
  abortController: AbortController,
): CancellableKernelLike {
  return {
    interrupt(_reason?: KernelInterruptReason): void {
      if (!abortController.signal.aborted) {
        try {
          abortController.abort(_reason)
        } catch {
          /* ignore — already aborted */
        }
      }
    },
    pause(): boolean {
      return false
    },
    resume(): boolean {
      return false
    },
  }
}

// Chunk 6 — removed the eager `getToolOrchestrator({...})` pre-warm. It was the only
// remaining direct caller after Chunk 4 deleted `POLE_TOOL_ORCHESTRATION` and caused a
// circular initialisation when `policy.ts` started importing `chatMode → tools/registry`.
// The downstream `getUnifiedOrchestrator()` below already passes the shared
// MultiAgentOrchestrator to the singleton's first construction, so dropping the pre-warm
// does not change the resulting instance.
