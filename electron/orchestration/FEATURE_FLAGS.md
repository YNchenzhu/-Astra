# Orchestration Layer Feature Flags

Active environment flags for the orchestration layer. The 6 `POLE_ORCHESTRATION_*`
flags that used to gate the kernel migration (master/debug/inbox-drain/permission-active/
checkpoint/drive) have been removed — their default-on behaviour is now the only path.

## Live flags

| Flag | Default | Effect |
|---|---|---|
| `POLE_ORCHESTRATION_DURABLE_HITL` | **on** (since renderer grew `hitlPaused` UI slot) | Inbox-based durable HITL path (survives process restart). Set `=0` / `false` / `no` to fall back to the legacy in-process IPC promise wait (no durability). |
| `POLE_APPENDIX_A_FLOW` | on in dev, off in packaged | Emit AppendixA telemetry stages on the `orchestration_phase` stream. Dev defaults on (drives the renderer phase indicator and per-iteration timeline); packaged defaults off to keep ~8–15 IPC msgs/turn off production users' streams. Set `=0` to force off, `=1` to force on. |
| `POLE_PREFLIGHT_FAIL_OPEN` | off (fail-closed) | Security: when set to `1`, a crashing permission preflight allows the tool instead of denying. Off by default — do not enable in production. Read by BOTH `toolRuntime/defaultToolRuntimePort.ts` and `policyEnginePermissionPort.ts` (audit P0 §4.4 made the two read points symmetric). |
| `POLE_TOOL_SCHEDULER_MODE` | `legacy` | Unified scheduler mode: `legacy` keeps the existing batch planner; `shadow` compares plans; `hold` adds bounded cross-agent priority holding; `authoritative` requires a process-wide grant promise before lease start. This variable wins over both legacy variables below. |
| `POLE_TOOL_SCHEDULER_ACTIVE` | off | Dry-run telemetry only: enables (a) `[DefaultToolRuntimePort] scheduler-dry-run` wave-layout log; (b) audit P1 §5.3 `[DefaultToolRuntimePort] scheduler-disagrees` comparison between `scheduler.planNextWaves` and the live `toolPipeline.planToolExecution` planner. Does NOT change which planner actually dispatches tools. |
| `POLE_TOOL_SCHEDULER_DRIVE` | off | Cross-agent preemptive holding. When `=1`, both tool-admission paths (`DefaultToolRuntimePort.runQuotaAdmitAndPreemptPhase` + the `toolExec.ts` fallback) gate each tool through `ToolScheduler.shouldHoldForHigherPriority` BEFORE quota admission: a lower-priority agent's tool holds (marked `'blocked'`, reason `'scheduler_hold'`) while a higher-priority OTHER agent has `ready`/`scheduled` work in the DAG AND the system is contended (see `POLE_TOOL_SCHEDULER_HOLD_THRESHOLD`). Holds never deny — bounded by the shared `backpressureMaxWaitMs` deadline (anti-starvation), then the tool proceeds. Does NOT change intra-batch ordering (that stays `toolPipeline.planToolExecution`, order-preserving — the scheduler must not reorder reads ahead of earlier writes). Worker-thread sub-agents participate too: RPC tools (`Agent`/MCP/`Skill`/…) gate inline in the main-side `subAgentWorkerClient` handler; LOCAL in-thread tools (`bash`/file I/O/`grep`) request admission via the `admit_request`/`admit_grant`/`admit_done` RPC (`subAgentWorkerScheduler.ts`). Both worker paths run the FULL cross-agent quota admission (hold + `quota.admit` + backpressure + preemption): a quota denial surfaces as an error `tool_result` (RPC path) or an `admit_deny` → synthetic error without executing (local path). Off → byte-for-byte legacy (no admission, no admit RPC round-trip). |
| `POLE_TOOL_SCHEDULER_HOLD_THRESHOLD` | `MAX_PARALLEL_TOOL_CALLS` (10) | Soft contention threshold for the `POLE_TOOL_SCHEDULER_DRIVE` hold gate: a lower-priority tool only holds once the global running-tool count (`getRunningToolCount`) reaches this value. Conservative default = hold only near global read-only saturation; tune DOWN for more aggressive cross-agent holding. Below the threshold the system has spare capacity and keeps full parallelism (no hold). Invalid / non-positive → default. No effect unless `POLE_TOOL_SCHEDULER_DRIVE=1`. |
| `POLE_ITERATION_STALL_THRESHOLD` | `3` | Audit P1-1: consecutive stalled iterations (no tool use, low text, low token delta) before `decideIterationOutcome` returns `iteration_stalled`. Read once at `IterationStallGuard` module load. |
| `POLE_ITERATION_STALL_TEXT_FLOOR` | `100` | Non-thinking text length floor below which an iteration counts as low-text for stall detection. |
| `POLE_ITERATION_STALL_TOKEN_FLOOR` | `800` | Token delta floor below which an iteration counts as low-delta for stall detection. cc-haha equivalent defaults to 500; we picked 800 as a conservative variant. |
| `POLE_AGENT_MAILBOX_MAX` | `256` (clamped to `[8, 5000]`) | Per-agent mailbox depth cap. Older items dropped FIFO when exceeded; `mailboxDroppedCount` records the eviction count. |
| `POLE_AGENT_TERMINAL_HISTORY_MAX` | `500` (clamped to `[16, 10000]`) | Terminal agent history retention for the Running Agents panel. Pre-cap was a 120s sliding window which made history useless. |
| `ASTRA_ORCHESTRATION_STRICT` | — | Coordinator `preAgentGate` strict ordering (pre-existing, unrelated to the kernel migration). |
| `POLE_NORMALIZE_MESSAGES_PIPELINE` | on | Set `=0` to skip the `normalizeMessagesForAPI` pre-stream pass in `phases/iteration.ts`. Defensive escape hatch for transcript regression debugging. |
| `POLE_SESSION_MEMORY_EXTRACT` | on | Set `=0` to disable the post-iteration session memory extract fork triggered by `shouldTriggerSessionMemoryExtract`. |
| `POLE_ANTHROPIC_STRIP_THINKING_SIGNATURE_ON_MODEL_CHANGE` | on | Set `=0` to skip stripping Anthropic thinking-block signatures when the model or provider changes mid-conversation. Safety valve for the `normalizeAnthropicThinkingTranscript` heuristic. |
| `POLE_SKILL_DISCOVERY_PREFETCH` | **off** | Opt-in turn-1 skill-discovery prefetch in `agenticLoop/preModel.ts`. Set `=1` / `true` / `yes` to enable. Operators who want zero auto-discovery should also disable the per-turn follow-up below. Read by `agenticLoop/preModel.ts`. |
| `POLE_SKILL_DISCOVERY_FOLLOWUP` | **on** | Opt-out per-tool-batch skill discovery follow-up injection in `agenticLoop/toolExec.ts`. Set `=0` / `false` / `off` / `no` to disable. The explicit `DiscoverSkills` tool stays usable either way. Read by `skills/discoveryBudget.ts::isSkillDiscoveryFollowUpEnabled`. |
| `POLE_SKILL_CHAR_BUDGET` | derived (≈1% of context window, fallback 8000) | Override the character budget used by skill-discovery injection sites (`skillDiscovery.buildSkillDiscoveryInjection` and the compact index). Accepts any positive integer. Mirrors cc-haha `SLASH_COMMAND_TOOL_CHAR_BUDGET`. Read by `skills/discoveryBudget.ts::getSkillCharBudget`. |
| `ASTRA_LEGACY_AGENT_JSON` | off | Set `=1` / `true` / `yes` to fall back to the pre-Zod loose parser when Zod rejects an entry in `agents.json`. Defaults to strict-only (invalid entries are skipped). Read by `electron/agents/customAgents.ts::isLegacyAgentJsonLoaderEnabled`. |

## Workspace trust (disk setting, not env var)

`workspaceTrustMode` is a disk setting (Settings → 权限 → 工作区信任模式), not an env var, but the values affect behaviour the same way:

- **legacy** (default) — empty trust store implicitly trusts every workspace. Renderer-supplied paths that aren't in the list are AUTO-ADDED with a `[workspaceAccept] auto-trusting …` warn (audit trail).
- **strict** — empty trust store trusts nothing. The 3 renderer-facing IPC boundary checks (`memory:set-workspace`, `ai:send-message`, `streamHandler`) reject untrusted paths via thrown `Error`; renderer must surface a "Trust this workspace?" UX and call `workspace-trust:add` before retrying.

Boundary check lives in `electron/security/workspaceAccept.ts::acceptWorkspacePathFromRenderer`. Trust list lives in `<userData>/trusted-workspaces.json`. See A2 in the audit notes.

## Removed flags

Behaviour hard-coded on; flags no longer read anywhere:

- `POLE_ORCHESTRATION_KERNEL` (Chunk 1) — main chat always routes through `OrchestrationKernel`
- `POLE_ORCHESTRATION_KERNEL_DEBUG` (Chunk 2) — console observer always wired
- `POLE_SUBAGENT_KERNEL` — main-process sub-agents always run through a real Kernel Host; the opt-out is no longer read.
- `POLE_ORCHESTRATION_KERNEL_INBOX_DRAIN` (Chunk 2) — per-iteration inbox drain always active
- `POLE_ORCHESTRATION_PERMISSION_ACTIVE` (Chunk 2) — rule-based PermissionPort preflight always wired
- `POLE_ORCHESTRATION_CHECKPOINT` (Chunk 2) — in-memory checkpoint port auto-created
- `POLE_ORCHESTRATION_KERNEL_DRIVE` (F1 follow-up) — drive mode is now the only path; the legacy delegate is invoked internally from `runDriveMainChat`'s outer `for`
- `POLE_TOOL_ORCHESTRATION` (Chunk 4) — v2 bypass removed; all tool batches go through `DefaultToolRuntimePort`
- `POLE_ORCHESTRATION_CHATMODE` (Chunk 6) — chat-mode enforcement folded into `PolicyEngine.evaluate`
- `POLE_ORCHESTRATION_POLICY_ENGINE` (Chunk 6) — PolicyEngine is the only PEP; the layered port stack is gone
- `POLE_ORCHESTRATION_BARRIER_WAVE` (Chunk 10) — wave subsystem deleted; parallel Agent chunks always use `Promise.all`, mailbox messages always direct-push
