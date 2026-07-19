# Orchestration kernel invariants

1. **Single orchestration authority** — Phase transitions for a session run are owned by
   `OrchestrationKernel` only. Callers do not embed alternate "mini loops" that also decide
   model/tool iteration. *(Chunk 8 delivered: the inner `while` and drive-mode `while` both
   live under `electron/orchestration/phases/` — `iteration.ts:runAgenticLoop` for non-drive
   callers, `driveInnerLoop.ts:driveInnerLoop` for kernel-driven sessions. The former
   `electron/ai/agenticLoop.ts` re-export barrel has since been removed; import the loop
   primitives from `electron/orchestration/phases/iteration.ts` directly.)*

2. **Session as reducer** — Transcript and inbox mutations go through `applySessionCommands` /
   `flushInboxToTranscript`. Do not mutate `KernelLoopState.transcript` elsewhere.
   (Persisted coordinator JSON uses a different `OrchestrationState` in `types.ts`.)
   Every accepted mutation increments `transcriptRevision` and recomputes
   `transcriptFingerprint`; stale AgentLoop commits are rejected, and rewind
   restores historical content at a new monotonic revision.

3. **Effects behind ports** — Network, disk, MCP, IPC, and hook side effects implement port
   interfaces (`ports.ts`). The kernel imports adapters only at the composition root
   (e.g. `streamHandler`), not inside phase logic.

4. **Tool pipeline** — Parallel/serial batching rules are centralised in `toolPipeline.ts` +
   `canToolUseRunInParallelBatch` in `agenticToolBatch.ts`. New tools declare concurrency via
   `Tool.isConcurrencySafe`.

5. **Observability at phase boundaries** — Use `withPhaseSpan` / `OrchestrationObserver` rather
   than ad-hoc logs scattered across the loop.

6. **Cross-agent tool visibility** — Every tool batch (main chat, sub-agent, streaming,
   fallback) populates `ToolRuntimeState` + `GlobalToolCallHistory` + `ToolScheduler` so
   `quota.snapshot()`, `cancelAgent`, repetition guard, and the per-tool preempt
   controller (P1 §5.2) all see the same execution flow. Registration, Scheduler
   enqueue, quota/backpressure and preemption are owned only by
   `ToolAdmissionCoordinator`; the paths below differ only in execution shape.
   **Three concrete code paths**
   exist for historical reasons (audit P1 §5.1 wire-up brought them to parity on the
   bookkeeping side):

   - **A — orchestrated**: `DefaultToolRuntimePort.executeToolBatch` (`toolRuntime/defaultToolRuntimePort.ts`).
     Used by main chat. Runs the full preflight (PolicyEngine: chat-mode + workspace
     rules + agent allowlist + global rules + quota + history block) + register + scheduler
     enqueue + preempt-aware signal merge + execute + post-execute mark/cascade.
   - **B — fallback**: `executeFallbackBatchWithWiring` inside `agenticLoop/toolExec.ts`.
     Used by teammate / hook-LLM / skill-fork / bundle-handler / direct sub-agent runs that
     don't get a kernel-provided port. Mirrors path A (including PolicyEngine preflight as
     of audit P1 §5.1) but inlined so it can pass through `toolCallHistory`,
     `appendixAFlow`, and `onLoopSignal`.
   - **C — streaming**: `streamingToolExecutor` branch inside `agenticLoop/toolExec.ts`.
     Used when the model emits `tool_use` blocks that begin executing mid-stream. After
     this path awaits admission inside the tool promise, so model token streaming is not
     blocked while PolicyEngine/lease admission runs. It uses the priority and exact
     preemption signal carried by the same lease as A/B.

7. **Single permission enforcement point** *(Chunks 6 + 7)* — `PolicyEngine` owns every
   rule resolution. The kernel preflight goes through `PolicyEngine.evaluate` (chat mode,
   workspace permission rules, agent allowlist/denylist, global rules, resource quota,
   cross-agent repeat-failure history all in one call). The in-tool deep check inside
   `runAgenticToolUse` goes through `PolicyEngine.evaluateRules` (shell/path-qualified
   patterns resolved against actual `bashCommand` / `filePath` / `skillInvocationName`,
   returning tri-state `effectiveMode` for downstream "ask user" UI). Both methods share
   the same `resolveToolPermissionMode` matcher internally. The former three-layer port
   stack (`createRulePermissionPort` → `createChatModePermissionPort` →
   `createPolicyEnginePermissionPort`) is gone.

   **`PolicyEnginePermissionPort` fail-open symmetry** *(audit P0 §4.4)* — when
   `POLE_PREFLIGHT_FAIL_OPEN=1`, BOTH the resolver-throw and engine-throw branches return
   `{ decision: 'allow' }`. Before the fix the resolver-throw branch silently fell through
   to `engine.evaluate({ agentId: 'unknown' })`, a third undocumented behaviour.

## AppendixA telemetry

`POLE_APPENDIX_A_FLOW=1` enables stage-tagged events on the `orchestration_phase` stream.
`appendixAFlow.ts` keeps a stable enum of stage IDs (`P0_*` / `P1_*` / `P2_Q_*` / `P3_*`) used by
the agentic loop. The mapping to external documentation that originally motivated the enum has
been removed — IDs are now self-describing labels intended for log correlation only.

## Robustness invariants (added with the稳定性 + UX 提升 batch)

8. **Mid-iteration durability** (P0-1) — `runAgenticIteration` invokes
   `kernel.persist({ throttleMs: 200 })` at the top of every inner iteration,
   gated to `agentContext.agentId === 'main'`. The throttle prevents disk
   thrash on multi-iteration turns; the gate prevents sub-agents from
   overwriting the main kernel's persisted blob. The kernel's
   `persist(options?)` short-circuits when `Date.now() - lastPersistAt <
   throttleMs`, so force-saves (no options) always proceed. Recovery: when
   `createKernelForLegacyMainChat` is given a `prevPersistedBlob`, the
   `iteration / innerIteration / maxOutputRecoveryCycles /
   consecutiveCompactFailures` counters seed from the blob; transcript is
   still overwritten by `rendererMessages` (renderer is source-of-truth).

9. **Dual-signal interrupt** (P0-2) — `OrchestrationKernel` holds two abort
   controllers:
   - `abortController` (soft) — aborts on `interrupt(reason)` regardless of
     mode. Cancels `'cancel'` (default) tools.
   - `hardAbortController` (hard) — aborts only on
     `interrupt(reason, { hard: true })` OR after the
     `softInterruptGraceMs` (default 30s) auto-promotion timer expires.
     Cancels `'block'` tools (long-running rsync / DB migration / remote
     polls).

   Tool authors declare via `Tool.interruptBehavior: 'cancel' | 'block' |
   ((input) => 'cancel' | 'block')`. The default at the orchestrator level
   is `'cancel'`. `bash` / `PowerShell` use the input-aware form: any
   command with `runInBackground: true` OR `timeoutMs >= 60_000` becomes
   `'block'` so a single mid-turn user interrupt does not waste in-flight
   work. `DefaultToolRuntimePort.executeToolBatch` plumbs a per-tool
   resolver through `runAgenticToolUseBatch.resolveToolSignal` so each
   tool gets the correct lane.

10. **Context recovery layering** (P0-3) — PTL / contextLengthExceeded
    recovery in `runStreamPhase` runs in two layers before terminating:

    - **Layer A — drain-only** (`stream/recoverFromContext.ts`): when the
      collapse store has queued summaries for the conversation, consume
      them, prepend the recap to `apiMessages`, retry the stream. Zero
      extra LLM calls.
    - **Layer B — reactive compact**
      (`stream/reactiveCompactRecovery.ts`): the existing combined drain
      + clamp + microCompact + autoCompact + retry path. Used when Layer
      A had nothing to drain OR drain wasn't sufficient.

    Each layer is single-shot per iteration. If both layers fail, the
    turn terminates as `prompt_too_long`.

11. **Iteration stall detection** (P1-1) —
    `orchestration/iterationStallGuard.ts` records per-conversation
    metrics (hadToolUse, textLength, tokenDelta) on every no-tool-use
    iteration. After N consecutive (default 3) stalled iterations (no
    tool use AND `textLength < textCharFloor` AND `tokenDelta <
    tokenDeltaFloor`), `decideIterationOutcome` emits the new
    `iteration_stalled` termination reason. Tool-use iterations reset
    the streak. Tunable via `POLE_ITERATION_STALL_THRESHOLD` /
    `POLE_ITERATION_STALL_TEXT_FLOOR` / `POLE_ITERATION_STALL_TOKEN_FLOOR`.

12. **Cross-agent priority + preemption** (P1-2 + audit P1 §5.2 wire-up) —
    `AgentContext.priority` carries the run's tool-scheduling priority
    (defaults: `'main'` → HIGH, sub-agent → NORMAL, declared
    `defaultPriority` on `AgentDefinition` wins). `DefaultToolRuntimePort`
    threads this into both `registerToolInvocation` (so `quota.admit`'s
    `findPreemptionVictim` sees the truth) and `scheduler.enqueueBatch`
    (so the DAG ordering is priority-aware). Tools below HIGH are marked
    `preemptible: true`; `quota.admit` may preempt them when a higher-
    priority newcomer competes for the same resource slot (shell /
    network / mutation).

    **Preemption is real** *(audit P1 §5.2 + F-3 wire-up)*: when
    `quota.admit` returns a non-empty `preemptionTarget`,
    `DefaultToolRuntimePort`:
      1. Calls `preemptTool(victimId, reason)` which fires the victim's
         per-tool `AbortController` (created in `registerToolInvocation`).
         The victim's in-flight async work observes the abort via
         `resolveToolSignal`, which merges the per-tool preempt signal
         with the kernel's soft/hard signal.
      2. Marks the victim aborted in `ToolRuntimeState` so the resource
         slot frees up for the newcomer.
      3. Calls `scheduler.markFailed(victimId)` to cascade through the DAG.
      4. Emits a `tool_preempted` phase event carrying the
         `OrchestrationPhasePayload.preemption` payload so the renderer
         can surface a "<tool> was paused so <higher-priority tool> could
         run" badge.

    **All three execution paths honour preemption** *(F-3 wire-up
    completes the streaming gap)*: in addition to the
    `DefaultToolRuntimePort` path, both `executeFallbackBatchWithWiring`
    (legacy / sub-agent fallback) and `StreamingToolExecutor.executeToolUse`
    merge `getToolPreemptSignal(toolUseId)` into the per-tool signal
    they pass to `runAgenticToolUse`. So preempt-fires-abort works
    uniformly: streaming-executor tools' shell children / network
    sockets get the abort signal too, not just the registry status flip.

    **`POLE_TOOL_SCHEDULER_ACTIVE=1` dual-run validation** *(audit P1 §5.3)*:
    in addition to logging `scheduler.planNextWaves` output, the flag now
    ALSO runs `toolPipeline.planToolExecution` on the same batch and
    emits a single `scheduler-disagrees` warn line when the two planners
    produce different layouts — telemetry only.

    **`POLE_TOOL_SCHEDULER_DRIVE=1` cross-agent holding**: both admission
    paths gate each tool through `ToolScheduler.shouldHoldForHigherPriority`
    (a pure DAG read) BEFORE `quota.admit`. A tool holds (`'blocked'`,
    `'scheduler_hold'`) while a higher-priority OTHER agent has
    `ready`/`scheduled` nodes, bounded by the shared `backpressureMaxWaitMs`
    deadline (anti-starvation: on deadline the tool proceeds; holds never
    deny). Invariant: this flag MUST NOT change intra-batch ordering —
    `planNextWaves` reorders reads ahead of earlier writes (e.g.
    `[read1, write1, read2]` → `[read1,read2] || write1`), which would break
    data dependencies, so intra-batch planning stays `planToolExecution` and
    the scheduler is consulted ONLY for the cross-agent hold decision.
    Worker-thread sub-agents participate via the main process: RPC tools gate
    inline in `subAgentWorkerClient`, and LOCAL in-thread tools use the
    `admit_request`/`admit_grant`/`admit_done` accounting-only admission RPC
    (`subAgentWorkerScheduler.ts`). Invariant: every `acquireSchedulerAdmission`
    MUST be paired with a `releaseSchedulerAdmission` (success or failure) —
    for the local path the worker MUST post `admit_done` after in-thread
    execution (success or throw) or the main-side slot leaks 'running' until
    the 120s reaper. Both worker paths run the FULL quota admission (hold +
    `quota.admit` + backpressure + preemption); a quota denial is terminal on
    the main side (the helper already marked the slot failed) and surfaces as
    an error `tool_result` (RPC) or `admit_deny` (local) — on `admit_deny` the
    worker MUST NOT post `admit_done` (the slot is already terminal). The
    local-path admission is accounting-only for EXECUTION: the hold + quota
    gate is real (the worker awaits the grant), but the tool body runs in the
    worker thread.

13. **Durable HITL last-mile telemetry** (P2-1) — when
    `kernel.persistInbox()` fails AND the in-memory inbox contains at
    least one `pending_human_resume` item, the kernel emits an
    `orchestration_phase` event tagged `hitl_persistence_failed`
    carrying `reason` + `error` + `pendingHumanResumeCount`. Renderers
    show a toast prompting the user to re-submit their AskUserQuestion
    answer; without this signal the answer would silently die at the
    next process crash. Non-HITL inbox items still fail silently (only
    `console.warn`) because re-issuing `synthetic_user_text` /
    `slash_command` on the next turn is cheap.

## Audit P0 / P1 / wire-up invariants (added 2026-05 audit pass)

14. **Counter persistence round-trip** *(audit P0 §4.1)* —
    `KernelLoopState.maxOutputRecoveryCycles` and
    `consecutiveCompactFailures` actually survive crash recovery now. The
    inner `LoopState` owns the live counters; at every inner-iteration
    boundary `phases/iteration.ts` calls
    `kernel.syncMetaCounters({ maxOutputRecoveryCycles,
    consecutiveCompactFailures })` immediately before the throttled
    `kernel.persist({ throttleMs: 200 })`. On restart, `callModel.ts`
    seeds `AgenticLoopParams.seedMetaCounters` from `KernelLoopState` so
    the new `LoopState` resumes with the same soft-cap progress. Before
    the fix both counters were always written as 0 to the on-disk blob.

15. **`runDriveMainChat` ignores retained HITL items** *(audit P0 §4.2)* —
    the outer-loop break condition checks
    `state.inbox.filter(i => i.kind !== 'pending_human_resume').length === 0`
    instead of the raw `state.inbox.length`. `flushInboxToTranscript`
    retains `pending_human_resume` items for the HITL-aware tool to
    consume by `toolUseId`; the old check would burn all 16 outer
    iterations doing nothing useful if the model didn't call
    `AskUserQuestion` on the resume turn.

16. **`abortToolsInTree` truly recursive** *(audit P0 §4.5)* —
    `ToolRuntimeState.abortToolsInTree(parentAgentId)` walks the
    transitive closure of descendant agents (computed from the
    `agentId → parentAgentId` edges visible in the registry) instead of
    matching only direct children. Agent trees deeper than two levels
    (`main → coordinator → explore → grep`) now abort cleanly.

17. **`enqueue*` returns `'empty_payload'` for empty content** *(audit
    P0 §4.3)* — `InboxEnqueueResult.reason` distinguishes
    `'no_conversation'` (missing conversationId), `'no_kernel'` (id valid
    but no kernel registered) and `'empty_payload'` (empty text / empty
    slash name / empty mailbox / empty toolUseId). Callers can give the
    user accurate feedback.

18. **`persist()` retries transient disk failures** *(audit §3.1 wire-up
    `retryPolicy.withRetry`)* — `kernel.persist()` wraps the
    `persistenceAdapter.save(blob)` call in `withRetry(...)` with a
    dedicated policy (`maxAttempts: 2`, `initialIntervalMs: 100`,
    `maxIntervalMs: 500`). Recovers from antivirus index locks /
    Windows EBUSY / OneDrive sync churn / sandbox tmp races without
    losing the persist; force-saves stay fast because the retry chain
    is short.

19. **Kernel telemetry helpers are free functions** *(audit §3.1 wire-up
    `kernelInternals.ts` + `kernelTelemetry.ts`)* —
    `OrchestrationKernel.emitPhase`, `bumpInnerIteration`,
    `resetInnerIteration`, `transitionPhase`, and
    `wrapAppendixAReporterWithIterationTracking` all delegate to free
    functions in `kernelTelemetry.ts`, taking a `KernelSlice` built
    lazily on first access. Phase modules and tests can unit-test the
    helpers without instantiating a full kernel.

20. **Tool middleware extension point** *(audit §3.1 wire-up
    `toolMiddleware.ts`)* — every per-tool execution inside
    `runAgenticToolUse` is wrapped by `applyToolMiddleware(ctx, inner)`.
    Plugins / bundles / dev tools register a middleware via
    `registerToolMiddleware('name', fn)` (exported from `index.ts`) to
    intercept, cache, log, or rewrite individual tool calls without
    touching tool implementations. No registrations = zero-cost
    passthrough.

21. **InterAgentMailboxPort observer fan-out** *(audit §3.1 wire-up
    `multiAgent.InterAgentMailboxPort`)* —
    `MultiAgentOrchestrator` exposes `setMailboxPort(port)` and
    `deliverMailboxLine({sender, recipient, line})`. Every
    `enqueueAgentMailboxMessage` write fans out to the singleton
    orchestrator's `deliverMailboxLine` so plugins / telemetry /
    future durable-queue backends observe all sub-agent mailbox
    traffic without replacing the ALS path.

22. **`conversation:delete` cleans on-disk orchestration artifacts**
    *(audit §3.2 wire-up `KernelPersistenceAdapter.delete` +
    `deleteInboxFromDisk`)* — the IPC handler awaits
    `deleteOrchestrationArtifactsForConversation(convId)` which drops
    `<userData>/kernel-state/<id>.json` and
    `<userData>/orchestration-inbox/<id>.json`. Before the fix both
    files accumulated one per ever-existing conversation.

23. **Token + disk-rate quotas are live** *(audit §3.2 wire-up
    `recordTokenUsage` + `recordDiskWrite`; expanded by P0+ self-fix F-2)* —
    `ResourceQuotaManager.recordTokenUsage(inputTokens + outputTokens)`
    is fed from FOUR `onMessageEnd` sites covering every
    `runAgenticLoop` consumer: `streamHandler` (main chat),
    `subAgentRunner`, `teammateRunner`, and `skillForkRunner`. So
    `maxTokenRatePerMinute` admission accounts for every
    model-call-producing path. `recordDiskWrite(bytes)` is fed from
    `toolWriteFile` / `toolEditFile` / `toolMultiEditFile` finalizers
    (alongside per-tool `recordToolResourceDelta(toolUseId, {
    diskWriteBytes })` using the ALS-scoped toolUseId).

    **Scope edges**: only `diskWriteBytes` of the four
    `ToolResourceUsage` fields is currently fed; `tokensUsed` /
    `networkBytes` / `shellChildCount` per-tool deltas remain at 0
    because the per-tool wire-up only reaches file-write tools. The
    GLOBAL `tokensPerMinute` window is correct (covers all loops above);
    the PER-TOOL token / network / shell counters are not.

24. **Pause/resume flips ToolRuntimeState** *(audit §3.2 wire-up
    `markToolPaused` / `markToolResumed`)* — `kernel.pause()` calls
    `markRunningToolsPausedForConversation(convId)` to flip every
    currently-running tool for this conversation from `'running'` to
    `'paused'`. `kernel.resume()` mirrors the flip back. Cooperative
    (in-flight async work keeps running); the status flip is for
    snapshot consumers and future scheduler decisions.

25. **Scheduler ↔ runtime-state DAG sync** *(audit §3.2 wire-up
    `markToolBlocked` / `markToolUnblocked` + `scheduler.getNodeStatus`)*
    — `DefaultToolRuntimePort.executeToolBatch` reads
    `scheduler.getNodeStatus(id)` after `enqueueBatch`; tools whose
    scheduler status is `'pending'` (unresolved deps) get
    `markToolBlocked('dependency')`. After each `scheduler.markCompleted`
    cascade, the port checks every tool in the batch and calls
    `markToolUnblocked` for those that became `'ready'`. Snapshot
    consumers can now distinguish "waiting for thread" from "waiting
    for dep".

26. **Branch-tree IPC surface** *(audit §3.2 wire-up
    `CheckpointPort.peek` / `listTree` / `getBranchHead`)* — three new
    IPC channels expose the previously-unreachable port APIs:
      - `orchestration:list-checkpoint-tree` → topologically-ordered
        tree walk (renderer Timeline branch picker)
      - `orchestration:peek-checkpoint` → single checkpoint by id
        including full state (fork-from-checkpoint preview)
      - `orchestration:branch-head` → current branch head id
        (renderer "you are here" indicator)

27. **Boundary hook for non-drive callers** *(audit §3.2 wire-up
    `iterationBoundaryHook` + P0+ self-fix F-1 hook ordering)* —
    `subAgentRunner` / `teammateRunner` / `skillForkRunner` (the three
    production callers of `runAgenticLoop` that don't own a kernel)
    pass an `iterationBoundaryHook` that returns `{ stop: true }` when
    their abort signal fires OR (sub-agent only) the agent's
    `tokenBudgetExceeded` flag is set.

    **F-1 ordering fix** — `phases/iteration.ts` now invokes the hook
    BEFORE the inner `state.signal.aborted` check. Without this swap,
    teammate's and skill-fork's hooks (which only check `signal.aborted`)
    were dead code: the inner gate fired first and produced the more
    generic `aborted_streaming` reason. Post-swap, all three callers
    get the typed `iteration_boundary_stopped` reason on graceful
    interception. Drive mode never passes a hook, so its abort still
    routes through the inner gate unchanged.
