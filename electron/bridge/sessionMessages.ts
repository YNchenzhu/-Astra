/**
 * Bridge session message protocol — parent ⇄ Worker.
 *
 * upstream §7 (`sessionRunner`) uses NDJSON over stdin/stdout because Claude CLI
 * runs as a child_process. We use Node `worker_threads` (Electron is already
 * a Node process; spawning child_processes adds Windows/Unix signal pain
 * + IPC encoding complexity for no operational benefit). Worker
 * `postMessage` is structured-clone (HTML-spec `serialise`-equivalent),
 * which transparently handles primitives, plain objects, ArrayBuffers,
 * etc. — no manual JSON ceremony.
 *
 * The message shapes here are the **wire contract**: any time we change
 * a field, both sides must be re-bundled. We validate at runtime with
 * zod so a worker built from a stale source can't silently inject malformed
 * payloads (e.g. an old worker that sends `kind: 'evt'` instead of
 * `'event'`); the parent rejects the message and surfaces a clean error.
 *
 * Direction:
 *   - `ParentMessage`  parent → worker (control plane)
 *   - `WorkerMessage`  worker → parent (data plane + lifecycle)
 *
 * The schemas are exported alongside the types so callers (sessionWorker,
 * sessionSpawner, tests) all see the same shape.
 */

import { z } from 'zod'
import { KNOWN_TERMINATION_REASONS } from '../../shared/terminationReasons'
import type { LoopEvent, AgenticLoopResult } from '../ai/loopEvents'

export const TranscriptSnapshotWireSchema = z.object({
  revision: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  messages: z.array(z.record(z.string(), z.unknown())).max(20_000),
})
export type TranscriptSnapshotWire = z.infer<typeof TranscriptSnapshotWireSchema>

export const RemoteHostParentMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause'), reason: z.string().optional() }),
  z.object({ kind: z.literal('resume') }),
  z.object({
    kind: z.literal('transcript_ack'),
    revision: z.number().int().nonnegative(),
    accepted: z.boolean(),
    actualRevision: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  }),
])
export type RemoteHostParentMessage = z.infer<typeof RemoteHostParentMessageSchema>

export const RemoteHostWorkerMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('iteration_boundary'),
    iteration: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('transcript_commit'),
    snapshot: TranscriptSnapshotWireSchema,
  }),
])
export type RemoteHostWorkerMessage = z.infer<typeof RemoteHostWorkerMessageSchema>

// ────────────────────────────────────────────────────────────────────────
// Init payload — what the spawner sends to start a session.
// ────────────────────────────────────────────────────────────────────────

/**
 * Subset of {@link AgenticLoopParams} that's safe to ship through
 * structured-clone serialisation. The full params shape carries
 * AbortSignal, callbacks, and other non-cloneable fields; we strip those
 * here and reconstruct them inside the worker.
 *
 * Fields we **do** ship: provider config, model, messages, system prompt,
 * max tokens, max iterations, thinking config, permission rules. Fields
 * we **don't**: signal (worker has its own AbortController),
 * orchestrated* (kernel hooks, all single-process today).
 * (`decideAfterNoToolUse` was removed in P1.3 — had no production callers.)
 */
export const SessionInitSchema = z.object({
  /** Logical session id assigned by spawner (used in log lines). */
  sessionId: z.string().min(1).max(256),
  /** Absolute workspace root — forwarded so worker-side tools can resolve paths. */
  workspacePath: z.string().nullable().optional(),
  /**
   * Inline serialisable subset of {@link AgenticLoopParams}. Validated
   * loosely here (zod `passthrough()`) — strict shape lives in
   * `agenticLoopTypes.ts` and is enforced when the worker reconstructs
   * the params object. The wire-level check just catches the obvious
   * "wrong shape entirely" class of error.
   */
  params: z
    .object({
      config: z
        .object({
          id: z.string(),
          name: z.string(),
          apiKey: z.string(),
          baseUrl: z.string().optional(),
          awsRegion: z.string().optional(),
          projectId: z.string().optional(),
        })
        .passthrough(),
      model: z.string().min(1),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.array(z.unknown())]),
          }),
        )
        .max(20_000),
      systemPrompt: z.string().optional(),
      maxTokens: z.number().int().positive().max(10_000_000).optional(),
      maxIterationsOverride: z.number().int().positive().max(500).optional(),
      enableTools: z.boolean().optional(),
      alwaysThinking: z.boolean().optional(),
      thinkingBudgetTokens: z.number().int().positive().max(1_000_000).optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      // Note: `permissionRules` / `permissionDefaultMode` accepted but
      // ignored when `enableTools=false`, which is the default for
      // worker-side runs in P1-A. Plumbing them through anyway so future
      // RPC tool ports inherit them naturally.
      permissionDefaultMode: z.enum(['allow', 'ask', 'deny']).optional(),
      permissionRules: z
        .array(
          z.object({
            id: z.string(),
            pattern: z.string(),
            mode: z.enum(['allow', 'ask', 'deny']),
          }),
        )
        .optional(),
    })
    .passthrough(),
  /** Parent-acknowledged snapshot used to resume a restarted worker session. */
  initialTranscriptSnapshot: TranscriptSnapshotWireSchema.optional(),
  /**
   * Initial OAuth/API access token (when the provider needs short-lived
   * tokens). Worker holds a mutable copy and uses the latest value on
   * every API call; parent calls `update_token` to refresh.
   */
  accessToken: z.string().optional(),
  /**
   * RPC-bridge tool definitions for tools the worker does NOT execute
   * locally (e.g. `Agent`, `TodoWrite`, `Skill`, `MemdirScan`,
   * `EnterPlanMode`, ...). The worker registers a thin proxy per entry
   * that forwards `execute()` over `port.postMessage({kind:'tool_call'})`
   * to the parent process, then resolves on `tool_result` /
   * `tool_error`. See `subAgentWorkerClient.ts:registerRpcTools` and
   * `subAgentWorker.ts:registerRpcTools`.
   *
   * Before this field was on the schema, `parseParentMessage` was
   * silently stripping it (default `z.object()` removes unknown keys),
   * so `init.toolDefinitions` arrived at the worker as `undefined`,
   * `registerRpcTools` was never called, and `Explore`/`Plan` running
   * in the worker silently lost every non-builtin tool (TodoWrite,
   * Skill, MemdirScan, …). That presented as a long stall on the
   * first model turn whenever the system prompt directed those tools.
   */
  toolDefinitions: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
        // ToolRegistry input schemas are arbitrary JSON; the strict
        // shape is enforced by `Tool.inputSchema` on the parent side and
        // by the receiving tool's `zInputSchema` (when present) on the
        // worker's RPC proxy. Validating again here would force every
        // schema to re-implement the same shape twice for zero gain.
        inputSchema: z.unknown(),
      }),
    )
    .max(1024)
    .optional(),
  /**
   * Merged disk settings snapshot from the main process at spawn time.
   *
   * Without this, `readDiskSettings()` inside the worker_threads sub-agent
   * returns `{}` (each worker thread has its own V8 context and never
   * received a `setDiskSettingsLoader` injection). That made downstream
   * helpers — most prominently `webSearchSettings.resolveBraveApiKey`,
   * `memoryFeatureFlags`, `recallTuning`, `disabledServers`, plugin /
   * workspaceTrust policy readers — see empty settings even though the
   * main process had them on disk. Tools dispatched to the sub-agent
   * silently lost their API keys / feature flags.
   *
   * Sub-agent workers are one-shot (spawn-execute-terminate), so a single
   * snapshot taken at init time is sufficient — there is no live-update
   * channel comparable to the utility tool-worker's
   * `postLiveSettingsSnapshot`, and none is needed for the current
   * lifecycle. If sub-agents ever start to long-live across settings
   * changes, plumb an `update_settings` ParentMessage analogous to
   * `update_token` rather than re-reading from disk inside the worker.
   *
   * Loose `Record<string, unknown>` typing here matches `readDiskSettings()`
   * — the strict shape is in `electron/stores/settings/types.ts` on the
   * renderer side and is intentionally not duplicated on the wire.
   */
  diskSettingsSnapshot: z.record(z.string(), z.unknown()).optional(),
  /**
   * P1-2 (audit Bug-7 fix) — agent priority for tool-scheduling.
   *
   * Worker_threads sub-agents (Explore / Plan / Verification under
   * `READONLY_AGENT_TYPES`, or anything with `POLE_AGENT_WORKER=1`) run
   * inside a separate V8 isolate. The parent's `AgentContext.priority`
   * (set from `AgentDefinition.defaultPriority`) lives in the parent's
   * ALS — the worker can't read it. Without this field, the fallback
   * priority threading in `executeFallbackBatchWithWiring` defaults to
   * NORMAL for non-main agents, silently losing any declared `BACKGROUND`
   * tagging.
   *
   * Loose `number().int()` typing matches `ToolPriority` enum values
   * (10/30/50/70/100). Worker uses this to set up `runWithAgentContextAsync`
   * with the right priority before invoking `runAgenticLoopAsync`.
   */
  priority: z.number().int().min(0).max(1_000).optional(),
  /** @deprecated Accepted for one wire-compatibility cycle; admission is always on. */
  schedulerDrive: z.boolean().optional(),
  /**
   * P1-2 (audit Bug-7 follow-up) — the externally-registered agentId for
   * this worker session. Without this, the worker's ALS-scoped
   * `AgentContext.agentId` defaults to `init.sessionId` (an internal
   * `sub-<timestamp>` string) which DOESN'T match the agent's registered
   * id in `activeAgentRegistry`. That mismatch breaks every cross-cutting
   * subsystem that keys off agentId: `quota.findPreemptionVictim` filters
   * by agentId, `globalToolCallHistory` fragments lineage, and
   * `scheduler.cancelAgent` can't find the worker's nodes.
   *
   * Parent-resolved id (the `effectiveAgentId` in `runSubAgentInWorker`).
   * Strictly required when present; falls back to `sessionId` only for
   * legacy callers that don't supply it (tests).
   */
  agentId: z.string().min(1).max(256).optional(),
  /**
   * P1-2 (audit Bug-7 follow-up) — externally-registered parent agentId.
   * Used by `globalToolCallHistory.registerAgentLineage` inside the worker
   * fallback path so cross-agent repeat-failure isolation works for
   * worker-bound sub-agents (without this, sibling sub-agents could block
   * each other's tool calls).
   */
  parentAgentId: z.string().min(1).max(256).optional(),
  /**
   * SA-3 fix 4(b) — the child sub-agent's effective `sessionAgentType`
   * (its `agentDef.agentType`). The worker uses this for a defensive
   * sandbox check: when it identifies the `session-memory-internal`
   * scribe, LOCAL tool execution inside the worker is refused outright
   * because `gateSessionMemoryInternalAgentToolUse` only runs in the
   * main process. See `electron/agents/sessionMemorySandboxInvariant.ts`.
   */
  sessionAgentType: z.string().min(1).max(256).optional(),
})
export type SessionInit = z.infer<typeof SessionInitSchema>

// ────────────────────────────────────────────────────────────────────────
// ParentMessage — control plane sent to the worker.
// ────────────────────────────────────────────────────────────────────────

export const ParentMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('init'),
    payload: SessionInitSchema,
  }),
  /** Soft-abort: worker stops gracefully (runs cleanup hooks). */
  z.object({
    kind: z.literal('abort'),
    reason: z.string().optional(),
  }),
  /** Refresh the access token mid-flight (e.g. OAuth expiry). */
  z.object({
    kind: z.literal('update_token'),
    token: z.string().min(1),
  }),
  ...RemoteHostParentMessageSchema.options,
])
export type ParentMessage = z.infer<typeof ParentMessageSchema>

// ────────────────────────────────────────────────────────────────────────
// WorkerMessage — data plane sent back to the parent.
// ────────────────────────────────────────────────────────────────────────

/**
 * `LoopEvent` is the agentic-loop event type from {@link loopEvents}.
 * We *don't* re-validate it with zod on the wire — its shape is enforced
 * by the producer (`runAgenticLoopAsync` in the worker) which itself
 * runs the same TS as the parent. Re-validating would just add CPU cost
 * for no security benefit (same source, same bundle pipeline).
 */
const LoopEventInWireSchema = z.unknown() as unknown as z.ZodType<LoopEvent>

/**
 * P4.1 — Strict shape for `AgenticLoopResult` over the worker wire.
 * The previous `z.unknown()` accepted any payload, including a stale
 * worker build that silently changed the shape. Strict zod validation
 * makes a mismatch surface as a clear error at `parseWorkerMessage`
 * boundary so the parent rejects the message instead of routing a
 * malformed result into `subAgentRunner`'s `onTerminate` hook.
 *
 * `terminationResult.reason` derives from the runtime source of truth. Adding
 * a new reason therefore cannot silently strand worker messages behind a stale
 * hand-copied wire enum.
 *
 * The schema mirrors `QueryTerminalResult` + `AgenticLoopResult` from
 * `electron/ai/queryTermination.ts` / `electron/ai/loopEvents.ts`.
 */
const TerminationReasonInWireSchema = z.enum(KNOWN_TERMINATION_REASONS)

const AgenticLoopResultInWireSchema = z.object({
  terminationResult: z.object({
    reason: TerminationReasonInWireSchema,
    turnCount: z.number().int().nonnegative(),
    terminatedAt: z.number().int().positive(),
    totalUsage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .optional(),
    errorDetail: z.string().optional(),
    maxTurnsLimit: z.number().int().positive().optional(),
    hookName: z.string().optional(),
  }),
  totalUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  transition: z.string(),
  transitionHistory: z.array(z.string()),
}) as unknown as z.ZodType<AgenticLoopResult>

export const WorkerMessageSchema = z.discriminatedUnion('kind', [
  /** Worker's `parentPort.on('message')` handler is wired and ready. */
  z.object({ kind: z.literal('ready') }),
  /** Worker has acknowledged init and started the loop. */
  z.object({ kind: z.literal('started'), sessionId: z.string() }),
  /** A streamed loop event (text_delta, tool_start, …). */
  z.object({
    kind: z.literal('event'),
    event: LoopEventInWireSchema,
  }),
  /**
   * Diagnostic log line. Mirrors stderr in upstream's child_process model;
   * parent collects these into a {@link StderrRing} for surfacing in
   * crash reports.
   */
  z.object({
    kind: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }),
  /** Loop terminated cleanly (or via abort with cleanup) — final result. */
  z.object({
    kind: z.literal('done'),
    result: AgenticLoopResultInWireSchema,
  }),
  /** Loop crashed with an unrecoverable error before producing a result. */
  z.object({
    kind: z.literal('fail'),
    error: z.string(),
  }),
  ...RemoteHostWorkerMessageSchema.options,
])
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Validate an inbound parent message. Used by the worker to reject
 * malformed control-plane payloads (e.g. from a bug or a rogue caller).
 * Returns a clean `{ ok, value | error }` instead of throwing so the
 * worker can route validation errors back to the parent as a `'log'`
 * line rather than crashing.
 */
export function parseParentMessage(
  raw: unknown,
): { ok: true; value: ParentMessage } | { ok: false; error: string } {
  const result = ParentMessageSchema.safeParse(raw)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, value: result.data }
}

/**
 * Validate an inbound worker message. Used by the spawner to reject
 * malformed worker output (which would indicate a bundle-version
 * mismatch between parent and worker).
 */
export function parseWorkerMessage(
  raw: unknown,
): { ok: true; value: WorkerMessage } | { ok: false; error: string } {
  const result = WorkerMessageSchema.safeParse(raw)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, value: result.data }
}

export function parseRemoteHostParentMessage(
  raw: unknown,
): { ok: true; value: RemoteHostParentMessage } | { ok: false; error: string } {
  const result = RemoteHostParentMessageSchema.safeParse(raw)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.message }
}

export function parseRemoteHostWorkerMessage(
  raw: unknown,
): { ok: true; value: RemoteHostWorkerMessage } | { ok: false; error: string } {
  const result = RemoteHostWorkerMessageSchema.safeParse(raw)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.message }
}
