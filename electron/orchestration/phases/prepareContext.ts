/**
 * PrepareContext phase — runs at the top of every outer turn.
 *
 * Responsibilities:
 *   1. Fire `onPromptSubmit` hook for plugin observers.
 *   2. Sync the renderer's transcript snapshot into kernel state.
 *   3. Flush any pending inbox items (slash commands, synthetic user text,
 *      inter-agent mailbox drafts) into the transcript as synthetic user turns.
 *   4. Drop the persisted inbox file — items are now in the transcript.
 *   5. Auto-snapshot post-prepare so a future rewind can land at "fresh user
 *      turn with transcript synced and inbox flushed" without redoing hooks.
 */

import type { AgenticLoopParams } from './iteration'
import { getWorkspacePath } from '../../tools/workspaceState'
import { withPhaseSpan } from '../observability'
import { applySessionCommands, flushInboxToTranscript } from '../sessionCommands'
import type { KernelPhaseCtx } from './types'

export type PrepareContextPhaseParams = {
  rendererMessages: AgenticLoopParams['messages']
}

export async function runPrepareContextPhase(
  ctx: KernelPhaseCtx,
  params: PrepareContextPhaseParams,
): Promise<void> {
  ctx.setState({ ...ctx.state, phase: 'PrepareContext' })
  ctx.emitPhase('PrepareContext')

  await withPhaseSpan(ctx.observer, 'PrepareContext', ctx.state.iteration, async () => {
    const cwd = getWorkspacePath()?.trim() || process.cwd()
    await ctx.ports.hooks.onPromptSubmit?.(cwd)

    // Renderer is a seed, not a continuously-authoritative replica. The
    // kernel passes an empty array after the first seed so outer redispatches,
    // rewind and late inbox turns cannot be overwritten by the original UI
    // snapshot.
    if (params.rendererMessages.length > 0) {
      ctx.setState(
        applySessionCommands(ctx.state, [
          { kind: 'SyncTranscriptFromRenderer', messages: params.rendererMessages },
        ]),
      )
    }
    ctx.setState(flushInboxToTranscript(ctx.state))
    // Inbox just drained into transcript → drop the persisted file so a future restart
    // doesn't replay items that have already been consumed.
    ctx.persistInbox()
  })

  // Auto snapshot after PrepareContext so rewind can restore to "fresh user turn
  // with transcript synced and inbox flushed" without redoing hooks.
  ctx.snapshot('post_prepare_context')
}
