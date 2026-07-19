# Orchestration / AgentLoop host contract

## Authority boundaries

- `OrchestrationKernel` owns outer turns, transcript revision, inbox drain,
  checkpoints, rewind, pause/resume and persistence.
- AgentLoop owns one hosted run's model/tool iterations and produces the
  canonical `AgenticLoopResult.terminationResult`.
- `outerLoopStats.exitReason` is only the Kernel driver's mechanical exit
  class. `outerLoopStats.terminationReason` and `task_terminated` both copy the
  typed reason from the same `AgenticLoopResult`.

Production main chat and main-process sub-agents use a full Kernel Host. Small
in-process callers use `runHostedAgentLoop` with `createInMemoryAgentLoopHost`.
`runAgenticLoop` and `runAgenticLoopAsync` are low-level implementation/test
surfaces; the static architecture test prevents new production entry modules
from importing the raw loop.

## Transcript hand-off

Every accepted transcript has `{ revision, fingerprint, messages }`. Kernel
mutations go through `SessionCommand`; AgentLoop commits use a base revision and
are rejected on CAS conflict. Rewind restores older content at `current + 1`,
so revisions never go backwards. Renderer rows seed a clean request once and
cannot overwrite a mid-turn persisted/checkpoint snapshot.

Worker Hosts send one complete snapshot at iteration boundaries/Terminal, not
at token granularity. Parent validates revision and SHA-256 fingerprint, then
returns `transcript_ack`. A rejected ack stops continuation. `pause` and
`resume` take effect only at the next iteration boundary. A restarted worker
receives the last parent-acknowledged snapshot and continues at `revision + 1`.

## Tool lifecycle

Policy/chat/permission/history checks run before `ToolAdmissionCoordinator`.
The Coordinator is the only production caller allowed to create a
`ToolRuntimeState` entry and Scheduler node. It returns one
`ToolInvocationLease` containing the effective preemption signal. Batch,
streaming, fallback and worker paths await the same grant, call `start()` once,
and finish idempotently on success, failure, abort or worker teardown.

Scheduler modes are `legacy`, `shadow`, `hold`, and `authoritative`.
`authoritative` previews `planNextWaves`, grants the highest-priority ready
wave, and advances only after its leases finish. `POLE_TOOL_SCHEDULER_MODE`
wins; legacy `ACTIVE=1` maps to `shadow`, `DRIVE=1` maps to `hold`, and both map
to `hold` while retaining shadow metrics.
