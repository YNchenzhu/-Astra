# Orchestration Stream Sinks

Source of truth for the typed stream sinks exposed by `TransportPort`. Lives next to
`ports.ts` so adapters and renderer routing logic stay aligned.

## Why typed sinks (P1.1)

Before P1.1 every kernel callsite built a `StreamEvent` literal:

```ts
this.ports.transport.emit({
  type: 'orchestration_phase',
  ...(this.streamConversationId?.trim()
    ? { conversationId: this.streamConversationId.trim() }
    : {}),
  orchestrationPhase: 'CallModel',
  orchestrationIteration: this.state.iteration,
  orchestrationInnerIteration: this.state.innerIteration,
})
```

Seven copies of that ternary + counter wiring lived in `kernel.ts` and the (since-deleted)
`defaultAdapters.ts`. The typed sink collapses them into intent:

```ts
emitPhaseEvent(this.ports.transport, {
  phase: 'CallModel',
  iteration: this.state.iteration,
  innerIteration: this.state.innerIteration,
  conversationId: this.streamConversationId?.trim(),
})
```

## Sink inventory

| Sink | Producer | Phase tags actually emitted | Renderer consumer |
| --- | --- | --- | --- |
| `transport.emit` | every non-phase event (text/thinking/tool/etc.) | — | the standard streaming renderer (`AIChat`, `streamHandler`) |
| `transport.emitPhase` | `OrchestrationKernel` FSM lifecycle | `PrepareContext` / `CallModel` / `Terminal` / `Error` (kernel-level outer phases — see "Phase enum vs emitted phases" below) | renderer "agent activity" timeline |
| `transport.emitPhase` | `OrchestrationKernel` constructor (`createKernelForLegacyMainChat`) | `Idle` (one-shot, before any turn begins) | renderer "kernel ready" cue |
| `transport.emitPhase` | `agenticLoop/toolExec.ts` | `RunToolBatch` (top of `executeToolBatch`), `ApplyToolResults` (after results appended) | renderer "running N tools" + "applying results" indicators |
| `transport.emitPhase` | `agenticLoop/noTools.ts` | `ResolveStop` (entry of `handleNoToolsBranch`), `StopHooksOrContinue` (before `runStopHooks`) | renderer "deciding to stop" + "checking stop hooks" indicators |
| `transport.emitPhase` | `OrchestrationKernel` admin events | `interrupt` / `rewound` / `paused` / `resumed` / `artifact_manifest` / `hitl_persistence_failed` / `outer_loop_complete` / `transcript_clone_degraded` | renderer pause/cancel/timeline/HITL UX |
| `transport.emitPhase` (preflight) | `DefaultToolRuntimePort.executeToolBatch` + `executeFallbackBatchWithWiring` | `permission_denied_preflight` | renderer "tool blocked by policy" badge |
| `transport.emitPhase` (preempt) | `DefaultToolRuntimePort.executeToolBatch` (audit P1 §5.2 wire-up) | `tool_preempted` | renderer "<tool> paused so <higher-priority tool> could run" badge |
| `transport.emitPhase` (AppendixA) | `createAppendixAFlowReporter` (when `POLE_APPENDIX_A_FLOW` enabled) | `appendix_a` (with `appendixAStage: 'P2_Q_*' / 'P3_*' / ...`) | dashboards / per-iteration timeline |

Both sinks ultimately reach the renderer through the same `StreamEvent` channel that
`createTransportAdapter(emit)` wraps. The sink split is about **producer intent**, not
delivery — moving consumers to a different transport later (separate IPC channel,
log file, telemetry sink) only requires overriding the relevant sink, not rewriting
producers.

## Phase enum vs emitted phases

`KernelTurnPhase` in `kernelTypes.ts` declares 9 enum values
(`Idle / PrepareContext / CallModel / ResolveStop / RunToolBatch /
ApplyToolResults / StopHooksOrContinue / Terminal / Error`); **all 9 are now
emitted** on the `orchestration_phase` stream. They split into two categories:

  **Outer FSM phases** (also written to `state.phase`):
    - `PrepareContext` — `phases/prepareContext.ts`
    - `CallModel`      — `phases/callModel.ts`
    - `Terminal`       — `phases/terminal.ts`
    - `Error`          — `phases/callModel.ts` catch
    - `Idle`           — `kernel.ts#createKernelForLegacyMainChat` (one-shot)

  **Inner-loop sub-phases** (informational; NOT written to `state.phase`,
  the kernel stays on `'CallModel'` while these fire):
    - `RunToolBatch`        — `agenticLoop/toolExec.ts` (executeToolBatch top)
    - `ApplyToolResults`    — `agenticLoop/toolExec.ts` (after results push)
    - `ResolveStop`         — `agenticLoop/noTools.ts` (handleNoToolsBranch entry)
    - `StopHooksOrContinue` — `agenticLoop/noTools.ts` (before runStopHooks)

The inner phases are advisory signals on the renderer event stream; they
let activity-timeline UIs show finer-grained status without growing the
outer FSM state space. Renderer subscribers MAY ignore them; they MUST
NOT depend on inner phases firing in any particular order beyond the
guarantee that they appear between a `CallModel` enter and the next
`Terminal | Error` exit.

## Adding a new phase tag

1. Pick a string tag and document it here under the matching producer row.
2. If it carries a structured payload (like `artifactManifest` / `permissionDenial` /
   `preemption` / `hitlPending`), extend `OrchestrationPhasePayload` in `ports.ts` AND
   `StreamEvent` in `electron/ai/streamHandlerTypes.ts` together so the wire shape is
   consistent.
3. Update `buildPhaseStreamEvent` in `transport.ts` (was `defaultAdapters.ts` pre-Chunk-11)
   to thread the new field.
4. Add a test in `streamSinks.test.ts` for the new shape.

Do **not** add new fields straight on `StreamEvent` without going through
`OrchestrationPhasePayload` — that's how we lock in the renderer routing contract.

## Renderer wiring (informational)

The renderer subscribes to `orchestration_phase` events in
`src/stores/chat/streamEvents/orchestrationStreamEvents.ts` via a single
`switch (orchestrationPhase)`. Tags with dedicated handling today:

- `PrepareContext` / `CallModel` / `Terminal` / `Error` → phase + iteration mirror
  (`OrchestrationTimeline`).
- `paused` / `resumed` / `rewound` → pause + phase reset.
- `interrupt` (with `hitlPending`) → durable-HITL pause slot (`AskUserQuestionDialog`).
- `permission_denied_preflight` → `permissionDenials` (`PreflightDenialToast`).
- `artifact_manifest` → `artifactManifests` (`ArtifactDrawer`).
- `tool_preempted` → `toolPreemptions` (amber toast in `PreflightDenialToast`).
- `hitl_persistence_failed` → `hitlPersistenceFailures` (red toast in `PreflightDenialToast`).
- `transcript_clone_degraded` → `lastTranscriptCloneDegradation` (diagnostic, no UI).
- `outer_loop_complete` → `lastOuterLoopStats` (diagnostic, no UI).

`appendix_a` and unknown tags fall through the `default` branch and are dropped. New tags
land in `OrchestrationPhasePayload` first, so the `default` never silently swallows a known
shape; add a `case` here (plus a store field) when surfacing a new tag.

## Back-compat policy

- `TransportPort.emit` stays for the foreseeable future. It's the only sink for non-phase
  events (`text_delta`, `tool_start`, etc.).
- `TransportPort.emitPhase` is optional in the interface so legacy inline mocks
  (`{ emit: vi.fn() }`) keep type-checking. `emitPhaseEvent` in `defaultAdapters.ts`
  bridges either shape; callsites should always go through that helper.
- The renderer must continue to recognise the literal `type: 'orchestration_phase'`
  event shape; the typed sink is a producer convenience only.
