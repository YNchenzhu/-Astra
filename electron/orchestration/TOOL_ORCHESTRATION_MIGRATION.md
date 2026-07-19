# Tool Orchestration (status)

The v2 Tool Orchestration architecture (`ToolOrchestrator` + `ToolScheduler` +
`ResourceQuotaManager` + `GlobalToolCallHistory` + `PolicyEngine`) is fully
merged into the kernel's `DefaultToolRuntimePort` so that every tool batch —
main chat, sub-agent, streaming executor, fallback — populates the same
cross-agent state.

## Status as of audit P1 (2026-05)

### Completed

- **Chunk 4** — `POLE_TOOL_ORCHESTRATION` env flag, `agenticToolBatchOrchestrated.ts`,
  the bypass branch in `electron/ai/agenticLoop/toolExec.ts`, the auto-register
  block in `electron/ai/runAgenticToolUse.ts` all removed. All tool batches now go
  through `DefaultToolRuntimePort.executeToolBatch`.
- **Chunk 5** — `ToolRuntimeState` / `ResourceQuotaManager` /
  `GlobalToolCallHistory` / `ToolScheduler` / `PolicyEngine` wired into
  `DefaultToolRuntimePort.executeToolBatch`. Cross-agent visibility, dynamic
  quotas, repeat-failure guard, and DAG node tracking all live without a
  separate bypass path.
- **Chunk 6** — Layered PermissionPort stack
  (`createRulePermissionPort` + `createChatModePermissionPort` +
  `createPolicyEnginePermissionPort`) collapsed into a single
  `PolicyEngine.evaluate` call. The kernel preflight goes through
  `createPolicyEnginePermissionPort` which just wraps the engine.
- **Chunk 7** — In-tool deep check (`runAgenticToolUse`) routes through
  `PolicyEngine.evaluateRules` for shell/path-qualified rules resolved
  against actual `bashCommand` / `filePath` / `skillInvocationName`,
  returning tri-state `effectiveMode`.
- **Unified admission** — batch, streaming, fallback and worker execution all
  acquire a `ToolInvocationLease` from `ToolAdmissionCoordinator`. Policy/chat/
  permission preflight happens before registration, and each accepted call owns
  exactly one RuntimeState entry, Scheduler node and effective AbortSignal.
- **P1 §5.2 wire-up** — `quota.admit`'s `preemptionTarget` is actually
  consumed. `DefaultToolRuntimePort` fires the victim's per-tool
  `AbortController` (added to `ToolRuntimeEntry`) and emits a
  `tool_preempted` phase event.
- **Scheduler mode cutover** — `POLE_TOOL_SCHEDULER_MODE` selects
  `legacy | shadow | hold | authoritative`. Shadow compares plans, hold adds
  cross-agent priority gating, and authoritative dispatches through grant
  promises produced from `planNextWaves`. Legacy environment variables map to
  shadow/hold for one compatibility cycle.
- **Audit §3.2 wire-ups** — `markToolPaused` / `markToolResumed` (kernel
  pause/resume), `markToolBlocked` / `markToolUnblocked` (scheduler DAG
  sync), `recordTokenUsage` (streamHandler `onMessageEnd`),
  `recordDiskWrite` + `recordToolResourceDelta` (file-write tools),
  `KernelPersistenceAdapter.delete` + `deleteInboxFromDisk`
  (`conversation:delete` IPC), `CheckpointPort.peek` / `listTree` /
  `getBranchHead` (new IPC channels), `iterationBoundaryHook` (sub-agent
  / teammate / skill-fork runners) all wired.

### Cross-agent preemptive holding and authoritative dispatch

- `hold` uses the shared Coordinator's bounded priority gate before quota
  admission. It never changes legacy intra-batch wave ordering.
- `authoritative` keeps dependency/order decisions in the Scheduler and makes
  each lease await a process-level grant before the tool body starts. The
  dispatcher advances after terminal lease completion, so rollback to `hold`
  or `legacy` is configuration-only.

### Worker execution

- **Worker-thread sub-agents** participate in the same Coordinator admission
  and cross-agent visibility via both tool paths:
  - RPC tools (`Agent` / MCP / `Skill` / `TodoWrite` / …) execute in the main
    process and are gated inline in `subAgentWorkerClient`'s `tool_call`
    handler (`acquireSchedulerAdmission` → execute → `releaseSchedulerAdmission`).
  - LOCAL in-thread tools (`bash` / file I/O / `grep` / …) request
    accounting-only admission before executing: the worker posts
    `admit_request`, main registers + holds + marks running and replies
    `admit_grant`, the worker executes in-thread, then posts `admit_done` so
    main marks the slot terminal. Shared body in
    `electron/agents/subAgentWorkerScheduler.ts`.
  - Both worker paths now run the FULL cross-agent quota admission in
    `acquireSchedulerAdmission` (hold → `quota.admit` → backpressure →
    preemption). A quota denial (after backpressure) is surfaced as an error
    `tool_result` on the RPC path, or as an `admit_deny` on the local path.
- **DAG dependency holding** — nothing populates `ToolScheduleRequest.dependsOn`
  in production yet, so the DAG is dependency-free and holding is purely
  priority-based. `dependsOn`-driven wave gating remains available in the
  scheduler but unused.
- **Per-tool AbortSignal hand-off** — the lease exposes the exact merged signal
  used by the executing batch/streaming/worker path. Preemption, cancellation,
  worker crash and exceptional completion all converge on idempotent
  `finish()`, releasing Scheduler and quota state once.

## Active modules

All retained, all in production use:

- `toolRuntime/state.ts` (`ToolRuntimeState` + lifecycle markers)
- `toolRuntime/scheduler.ts` (`ToolScheduler`)
- `toolRuntime/quota.ts` (`ResourceQuotaManager`)
- `toolRuntime/history.ts` (`GlobalToolCallHistory`)
- `toolRuntime/policy.ts` (`PolicyEngine`)
- `toolRuntime/orchestrator.ts` (`ToolOrchestrator` facade — agent-level
  spawn/registry; still consumed by `agentLifecycle` + `agentTool` via
  `getUnifiedOrchestrator`)
- `toolRuntime/defaultToolRuntimePort.ts` (`DefaultToolRuntimePort`)
- `toolRuntime/rateLimitRing.ts` (per-tool timestamp ring for
  `PolicyEngine.countRecentCalls`)
