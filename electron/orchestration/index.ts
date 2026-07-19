/** Persisted coordinator gate state (disk). */
export type { OrchestrationState } from './types'
export { ORCHESTRATION_STATE_VERSION, defaultOrchestrationState } from './types'
export { resetCoordinatorPhasesForNewTask } from './store'
export type {
  CheckpointId,
  CheckpointPersistence,
  CheckpointPort,
  KernelCheckpoint,
} from './checkpoint'
export {
  createFileCheckpointPort,
  createInMemoryCheckpointPort,
  deleteFileCheckpointTree,
} from './checkpoint'
export type {
  KernelPersistenceAdapter,
  PauseGate,
  PersistedKernelState,
} from './pauseResume'
export {
  buildPersistedState,
  createFileKernelPersistenceAdapter,
  createPauseGate,
} from './pauseResume'
export type {
  CancellableKernelLike,
  InterAgentMailboxPort,
  KernelAffinity,
  SpawnedKernel,
  SpawnedKernelMetadata,
  SpawnOptions,
  WorktreeAllocator,
} from './multiAgent'
export {
  createInMemoryMailboxPort,
  createNoopInterAgentMailboxPort,
  MultiAgentOrchestrator,
} from './multiAgent'
export type { InMemoryMailboxPort, InterAgentMailboxEntry } from './multiAgent'
export type { ChatMode } from './chatMode'
export { isPlanModeBlockingTool } from './chatMode'
export type { ArtifactEntry, ArtifactKind, ArtifactManifest, ArtifactPort } from './artifact'
export { createFileArtifactPort, createInMemoryArtifactPort } from './artifact'
/**
 * P1 (audit §3.1 wire-up) — Tool middleware extension point. Every per-tool
 * execution inside the agentic loop now flows through `applyToolMiddleware`
 * (see `electron/ai/runAgenticToolUse.ts`). Bundles / plugins / dev tools
 * register a middleware via `registerToolMiddleware` to intercept, transform,
 * cache, or audit individual tool calls without touching tool implementations.
 */
export type {
  RegisterToolMiddlewareOptions,
  ToolMiddleware,
  ToolMiddlewareContext,
  ToolMiddlewareNext,
} from './toolMiddleware'
export {
  clearToolMiddlewareForTests,
  getRegisteredToolMiddlewareCount,
  registerToolMiddleware,
} from './toolMiddleware'

/** Query-loop kernel (FSM + ports). */
export type {
  KernelContinueDecision,
  KernelInboxItem,
  KernelLoopState,
  KernelTurnPhase,
  OrchestrationKernelEvent,
} from './kernelTypes'
export { cloneTranscript, createInitialKernelLoopState } from './kernelTypes'

export type {
  HookPolicyPort,
  OrchestrationPorts,
  PermissionPort,
  SessionStorePort,
  ToolBatchOutcome,
  ToolRuntimePort,
  ToolUseCall,
  TransportPort,
} from './ports'
export type { SessionCommand } from './sessionCommands'
export {
  applySessionCommands,
  drainInboxToTranscript,
  flushInboxToTranscript,
} from './sessionCommands'
export { partitionToolUsesIntoChunks } from './toolPipeline'
export type { ToolUseChunk, ToolUseItem } from './toolPipeline'
export { createConsoleOrchestrationObserver, withPhaseSpan } from './observability'
export type { OrchestrationObserver } from './observability'
export {
  OrchestrationKernel,
  buildOrchestrationPortsForLegacyMainChat,
  createKernelForLegacyMainChat,
} from './kernel'
export type { LegacyDelegateRunParams } from './kernel'
export { createTransportAdapter, emitPhaseEvent, noopHookPolicy } from './transport'
/**
 * P2 §6.3 — per-variant phase-event builders. New producers should prefer
 * these over hand-rolled `{ phase: '...', ... }` literals so the type checker
 * catches wrong-field-with-wrong-tag bugs at compile time. `emitPhaseEvent`
 * accepts both the legacy loose shape and the strict discriminated union.
 */
export {
  buildArtifactManifestPhase,
  buildHitlFailedPhase,
  buildInterruptPhase,
  buildKernelFsmPhase,
  buildLifecyclePhase,
  buildOuterLoopPhase,
  buildPermissionDeniedPhase,
  buildPreemptionPhase,
  buildTranscriptDegradedPhase,
} from './transport'
export type {
  OrchestrationPhaseArtifactManifest,
  OrchestrationPhaseCommon,
  OrchestrationPhaseHitlFailed,
  OrchestrationPhaseInterrupt,
  OrchestrationPhaseKernelFsm,
  OrchestrationPhaseLifecycle,
  OrchestrationPhaseOuterLoop,
  OrchestrationPhasePayloadVariant,
  OrchestrationPhasePermissionDenied,
  OrchestrationPhasePreempted,
  OrchestrationPhaseTranscriptDegraded,
} from './ports'
export { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
export {
  getToolRuntimeMetrics,
  resetToolRuntimeMetricsForTests,
  snapshotToolRuntimeMetrics,
} from './toolRuntime/metrics'
export type { ToolRuntimeMetricsSnapshot } from './toolRuntime/metrics'
export {
  runOrchestratedMainChat,
  runOrchestratedLegacyMainChat,
} from './runOrchestratedSession'
export {
  createAppendixAFlowReporter,
  isAppendixAFlowTelemetryEnabled,
  logAppendixABootstrapPhase,
} from './appendixAFlow'
export type {
  AppendixABootstrapStageId,
  AppendixAFlowReporter,
  AppendixAIterationGetter,
  AppendixAQueryLoopStageId,
  AppendixARuntimeStageId,
  AppendixAStageId,
  AppendixAStreamPayload,
  AppendixAToolOrchestrationStageId,
} from './appendixAFlow'
export { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
/**
 * best-of-N: fan out one task into N isolated worktree attempts, score them
 * (heuristic by default, optional LLM judge), and cherry-pick the winner back.
 * The "parallel-explore + select" strategic-control primitive (Cursor 3 `/best-of-n`).
 */
export { runBestOfN, createGitBestOfNOps, parseShortstat } from './bestOfN'
export type {
  BestOfNParams,
  BestOfNResult,
  BestOfNGitOps,
  BestOfNAttemptContext,
  BestOfNAttemptResult,
  RunAttemptFn,
  DiffStat,
} from './bestOfN'
export {
  createHeuristicScorer,
  composeScorers,
  pickWinner,
  DEFAULT_HEURISTIC_WEIGHTS,
} from './scorer'
export type {
  ScorerPort,
  ScoredAttempt,
  AttemptArtifact,
  HeuristicWeights,
  VerificationVerdict,
} from './scorer'
export type { InboxEnqueueResult } from './inbox'
export {
  enqueueHumanResume,
  enqueueInterAgentMailboxDraft,
  enqueueMidTurnUserInput,
  enqueueSlashCommand,
  enqueueSyntheticUserText,
} from './inbox'
export {
  InterruptForHITL,
  canUseDurableHITL,
  clearPendingHITLForConversation,
  findPendingHumanResume,
  isDurableHITLEnabled,
  isInterruptForHITL,
  tryConsumePendingHumanResume,
} from './hitl'
export type { RetryPolicy, WithRetryOptions } from './retryPolicy'
export {
  DEFAULT_RETRY_POLICY,
  RetryAborted,
  isProgrammerError,
  withRetry,
} from './retryPolicy'
export {
  clearOrchestrationKernelRegistryForTests,
  getOrchestrationKernelForConversation,
  interruptOrchestrationKernelForConversation,
  pauseOrchestrationKernelForConversation,
  registerOrchestrationKernelForConversation,
  resumeOrchestrationKernelForConversation,
  unregisterOrchestrationKernelForConversation,
} from './activeKernelRegistry'
export type { KernelInterruptReason } from './kernel'
