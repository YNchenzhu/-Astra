/**
 * Sub-agent adapter for {@link runBestOfN}.
 *
 * Turns the DI-friendly `RunAttemptFn` into a real run: each attempt spawns a
 * worker-isolated sub-agent whose file tools land inside the attempt's git
 * worktree (via `workspaceOverride` + `isolation: 'worktree'`), then optionally
 * runs the Verification sub-agent IN THE SAME worktree to produce a
 * PASS/FAIL/PARTIAL verdict the scorer can rank on.
 *
 * Why worker isolation matters: the orchestration worker path
 * (`subAgentWorkerDispatch.maybeRunInWorker`) gives each `isolation:'worktree'`
 * child its OWN module-level workspace path. The in-process path shares the
 * single global workspace and CANNOT isolate, so N parallel attempts would
 * clobber each other. Callers (the BestOfN tool) gate on
 * {@link subAgentWorkerAvailable} before fanning out.
 */

import { getAgentContext } from '../agents/agentContext'
import { runSubAgent, findAgentDefinition } from '../agents/subAgentRunner'
import { getBuiltInAgents } from '../agents/builtInAgents'
import { resolveAgentModelAlias } from '../agents/resolveAgentModelAlias'
import {
  getMultiAgentOrchestrator,
  abortControllerToKernelShim,
} from '../agents/multiAgentOrchestratorSingleton'
import { parseVerdict } from '../planning/verificationGateState'
import type { AgentDefinitionUnion } from '../agents/types'
import type { RunAttemptFn, BestOfNAttemptResult } from './bestOfN'

export interface SubAgentBestOfNOptions {
  /** Worker agent type to run each attempt as. Default `'general-purpose'`. */
  agentType?: string
  /** Run the Verification agent in each worktree after the attempt. Default true. */
  verify?: boolean
  /** Model alias / id override. Defaults to the parent turn's model. */
  model?: string
}

const VERIFY_DETAIL_CHARS = 500

/**
 * Build a {@link RunAttemptFn} that runs each attempt as a worktree-isolated
 * sub-agent (+ optional Verification scoring). Must be invoked from inside an
 * agentic loop (it reads the parent {@link getAgentContext} for provider config
 * + model).
 */
export function createSubAgentRunAttempt(
  options?: SubAgentBestOfNOptions,
): RunAttemptFn {
  const agentType = options?.agentType ?? 'general-purpose'
  const verify = options?.verify ?? true

  return async (ctx): Promise<BestOfNAttemptResult> => {
    const parentCtx = getAgentContext()
    if (!parentCtx) {
      return { error: 'best-of-n attempt: no active agent context (must run inside an agentic loop)' }
    }

    const all = getBuiltInAgents()
    const baseDef = findAgentDefinition(agentType, all)
    if (!baseDef) {
      return { error: `best-of-n attempt: unknown agent type "${agentType}"` }
    }
    // Force worktree isolation so the child's writes land in ITS worktree.
    // Audit M3: deny BestOfN to each attempt so a worker can't recursively
    // fan out another best-of-N (6×6×… explosion; depth alone doesn't bound width).
    const workerDef = {
      ...baseDef,
      isolation: 'worktree',
      disallowedTools: [...(baseDef.disallowedTools ?? []), 'BestOfN'],
    } as AgentDefinitionUnion
    const model = resolveAgentModelAlias(
      options?.model ?? baseDef.model,
      parentCtx.model,
      parentCtx.config.id,
    )

    const prompt = ctx.variantHint
      ? `${ctx.task}\n\n## Strategy for THIS attempt\n${ctx.variantHint}`
      : ctx.task

    // Audit L4: register this attempt in the MultiAgentOrchestrator tree (same
    // shim pattern agentTool uses) so a parent `interruptTree` / pause cascades
    // to it and it shows up in `getRuntimeStatus`. We drive both sub-agent runs
    // off a local AbortController that mirrors the incoming ctx.signal, so the
    // orchestrator's `interrupt()` and the caller's cancel both abort the run.
    const ac = new AbortController()
    const onParentAbort = (): void => {
      if (!ac.signal.aborted) ac.abort()
    }
    if (ctx.signal.aborted) ac.abort()
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true })

    const orchestrator = getMultiAgentOrchestrator()
    const parentKernelId = parentCtx.agentId ? String(parentCtx.agentId) : 'main-chat'
    const childKernelId = `best-of-n-attempt-${ctx.attemptIndex}-${Math.random().toString(36).slice(2, 8)}`
    orchestrator.register(childKernelId, abortControllerToKernelShim(ac), {
      parentKernelId,
      agentType: 'best-of-n',
      affinity: 'main_process',
    })

    try {
      const result = await runSubAgent({
        config: parentCtx.config,
        model,
        agentDef: workerDef,
        prompt,
        signal: ac.signal,
        onEvent: () => {},
        workspaceOverride: ctx.worktreePath,
      })

      if (!result.success && !result.output) {
        return { error: result.error ?? `attempt ${ctx.attemptIndex} failed with no output` }
      }

      let verification: BestOfNAttemptResult['verification']
      if (verify && !ac.signal.aborted) {
        const verDef = findAgentDefinition('Verification', all)
        if (verDef) {
          const verWorkerDef = { ...verDef, isolation: 'worktree' } as AgentDefinitionUnion
          const verModel = resolveAgentModelAlias(
            verDef.model,
            parentCtx.model,
            parentCtx.config.id,
          )
          const verPrompt =
            `Original task:\n${ctx.task}\n\n` +
            `An implementation has already been applied in THIS workspace. Independently verify it: ` +
            `run the build / tests / typecheck and exercise the changed behavior. ` +
            `End your reply with \`VERDICT: PASS\`, \`VERDICT: FAIL\`, or \`VERDICT: PARTIAL\`.`
          try {
            const verResult = await runSubAgent({
              config: parentCtx.config,
              model: verModel,
              agentDef: verWorkerDef,
              prompt: verPrompt,
              signal: ac.signal,
              onEvent: () => {},
              workspaceOverride: ctx.worktreePath,
            })
            const verdict = parseVerdict(verResult.output)
            if (verdict) {
              verification = {
                verdict,
                detail: (verResult.output ?? '').slice(0, VERIFY_DETAIL_CHARS),
              }
            }
          } catch {
            // Verification failure is non-fatal — the attempt is still scored on
            // its diff + output; we just don't have a verdict signal for it.
          }
        }
      }

      return {
        ...(result.output ? { finalText: result.output } : {}),
        ...(verification ? { verification } : {}),
      }
    } finally {
      ctx.signal.removeEventListener('abort', onParentAbort)
      try {
        orchestrator.unregister(childKernelId)
      } catch {
        /* idempotent best-effort teardown */
      }
    }
  }
}
