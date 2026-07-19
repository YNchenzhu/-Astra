/**
 * Main-chat entry: every turn flows through {@link OrchestrationKernel.runDriveMainChat}.
 *
 * Removed gates (deleted across the consolidation):
 *   - `POLE_ORCHESTRATION_KERNEL` (Chunk 1, removed) — kernel is always wired
 *   - `POLE_ORCHESTRATION_KERNEL_DRIVE` (F1 follow-up) — drive mode is the only path
 *
 * The kernel owns both the outer turn loop (`runLegacyDelegateMainChat` body, called
 * inside `runDriveMainChat`'s `for`) and the inner iteration loop (`driveInnerLoop`
 * injected as `runCallModel`).
 */

import path from 'node:path'
import type { AgenticLoopCallbacks, AgenticLoopParams } from './phases/iteration'
import type { AgenticLoopResult } from '../ai/loopEvents'
import type { StreamEvent } from '../ai/streamHandler'
import type { InlineSkillSessionState } from '../ai/runAgenticToolUse'
import { createConsoleOrchestrationObserver } from './observability'
import { createKernelForLegacyMainChat } from './kernel'
import {
  registerOrchestrationKernelForConversation,
  unregisterOrchestrationKernelForConversation,
} from './activeKernelRegistry'
import { createFileArtifactPort } from './artifact'
import { createFileCheckpointPort } from './checkpoint'
import { createFileKernelPersistenceAdapter } from './pauseResume'
import type { ChatMode } from './chatMode'
import { getPermissionModeForConversation } from '../ai/interactionState'
import { isConductorEnabled } from './conductor'
import { createConductorBestOfNPort } from './conductorBestOfNPort'

export async function runOrchestratedMainChat(params: {
  emitStream: (ev: StreamEvent) => void
  rendererMessages: AgenticLoopParams['messages']
  agenticParams: AgenticLoopParams
  agenticCallbacks: AgenticLoopCallbacks
  /** When set, inbox helpers + stream telemetry key off this id */
  conversationId?: string
  /** Optional: align DefaultToolRuntimePort fallback with a host-owned skill session (rare) */
  skillSession?: { get: () => InlineSkillSessionState; set: (s: InlineSkillSessionState) => void }
  /**
   * renderer chat-input mode forwarded so the kernel's chat-mode
   * permission port can deny mutating tools in Plan mode / disable tools in Ask mode.
   * Defaults to `'agent'` (no restriction beyond the rule-based port) when omitted.
   */
  chatMode?: ChatMode
  /**
   * Electron userData dir for `createFileArtifactPort` +
   * `createFileKernelPersistenceAdapter`. When absent the kernel falls back to
   * in-memory checkpoint + no artifact persistence + no restart durability.
   */
  userDataDir?: string
  /** Final typed AgentLoop outcome accepted by the Kernel outer loop. */
  onTerminate?: (result: AgenticLoopResult) => void
}): Promise<void> {
  const observer = createConsoleOrchestrationObserver()
  const convId = params.conversationId?.trim()
  const chatMode: ChatMode = params.chatMode ?? 'agent'
  const userDataDir = params.userDataDir?.trim() || undefined
  // wire artifact + persistence ports when userDataDir is available.
  // Both adapters are file-backed and survive process restart.
  const artifactPort = userDataDir
    ? createFileArtifactPort(path.join(userDataDir, 'kernel-artifacts'))
    : undefined
  const persistenceAdapter = userDataDir
    ? createFileKernelPersistenceAdapter(userDataDir)
    : undefined
  // Audit fix M-2 — durable checkpoint port so the rewind / branch-picker UX
  // and fork-from-checkpoint survive a process restart. Requires both a
  // userData dir AND a conversation id (the file is keyed per-conversation);
  // otherwise the kernel falls back to the in-memory checkpoint port.
  const checkpointPort =
    userDataDir && convId
      ? createFileCheckpointPort({
          baseDir: path.join(userDataDir, 'kernel-checkpoints'),
          conversationId: convId,
        })
      : undefined
  // Stage 1.3 + Bug A fix — load any persisted kernel blob from disk BEFORE
  // constructing the kernel, so `createKernelForLegacyMainChat` can seed the
  // durable metadata (iteration counters / phase / recovery cycles) from the
  // blob while letting volatile state (transcript / inbox) flow through the
  // standard renderer-sync + inboxPersistence path. The legacy post-
  // construction `kernel.restoreFrom(blob)` approach was wrong because it
  // overwrote the freshly-synced rendererMessages with stale blob transcript.
  let prevPersistedBlob: import('./pauseResume').PersistedKernelState | undefined
  if (persistenceAdapter && convId) {
    try {
      const loaded = await persistenceAdapter.load(convId)
      if (loaded) prevPersistedBlob = loaded
    } catch (e) {
      console.warn('[runOrchestratedSession] persistenceAdapter.load failed:', e)
    }
  }
  // forward permission policy so the kernel's PermissionPort can pre-flight tools with
  // the same rules the agentic loop would otherwise apply internally.
  const kernel = createKernelForLegacyMainChat(params.emitStream, observer, params.rendererMessages, {
    skillSession: params.skillSession,
    streamConversationId: convId,
    ...(params.agenticParams.permissionRules
      ? { permissionRules: params.agenticParams.permissionRules }
      : {}),
    ...(params.agenticParams.permissionDefaultMode
      ? { permissionDefaultMode: params.agenticParams.permissionDefaultMode }
      : {}),
    // Live chat-mode resolver (not the captured const): a turn that started
    // in `plan` must stop gating mutating tools the moment `ExitPlanMode` is
    // approved and restores a non-plan permission mode. Previously this was
    // `() => chatMode` (frozen at session start), so post-approval write/edit
    // tools stayed denied with `chat_mode:plan` for the rest of the run even
    // though the agent had already "exited" plan mode. `agent` / `ask` starts
    // are not permission-mode backed, so keep their requested value as-is.
    getChatMode: () =>
      chatMode === 'plan'
        ? (getPermissionModeForConversation(convId) === 'plan' ? 'plan' : 'agent')
        : chatMode,
    ...(artifactPort ? { artifactPort } : {}),
    ...(checkpointPort ? { checkpointPort } : {}),
    ...(persistenceAdapter ? { persistenceAdapter } : {}),
    ...(prevPersistedBlob ? { prevPersistedBlob } : {}),
  })
  if (convId) {
    registerOrchestrationKernelForConversation(convId, kernel)
  }
  try {
    // F1 cleanup (post-Chunk-12 follow-up) — `POLE_ORCHESTRATION_KERNEL_DRIVE` removed.
    // Drive mode is the only path: the kernel owns both the outer turn `for` and the
    // inner iteration `while` (via `driveInnerLoop` injected as `runCallModel`).
    // 阶段 3 — wire the Conductor's best-of-N execution port for the main chat
    // ONLY when the Conductor is enabled (default off). Worker-gated inside the
    // factory: returns undefined when the sub-agent worker is unavailable, in
    // which case a best-of-N decision degrades to a plain rewind re-dispatch.
    const conductorBestOfNPort = isConductorEnabled()
      ? createConductorBestOfNPort(convId ? { conversationId: convId } : undefined)
      : undefined
    await kernel.runDriveMainChat({
      agenticParams: params.agenticParams,
      agenticCallbacks: params.agenticCallbacks,
      rendererMessages: params.rendererMessages,
      ...(params.onTerminate ? { onTerminate: params.onTerminate } : {}),
      ...(conductorBestOfNPort ? { conductorBestOfNPort } : {}),
    })
  } finally {
    if (convId) {
      unregisterOrchestrationKernelForConversation(convId)
    }
  }
}

/** @deprecated Use runOrchestratedMainChat. */
export const runOrchestratedLegacyMainChat = runOrchestratedMainChat
