export * from './diagnosticsHub'

export type {
  ProviderId,
  ProviderOption,
  ModelOption,
  FileNode,
  TabInfo,
  SidebarView,
  Attachment,
  AttachmentKind,
  AttachmentStatus,
  FileAttachmentPayload,
  RetrievedChunkDisplay,
  ChatMessage,
  CodeBlock,
  ContentBlock,
  ToolUseDisplay,
  ToolProgressEvent,
  SubAgentDisplay,
  SearchResult,
  GitChange,
  MCPServerConfig,
  MCPServerState,
  StreamEvent,
  PermissionMode,
  DiffPermissionMode,
  PermissionRequestDisplay,
  DiffPreview,
  DiffHunk,
  AskQuestionOptionDisplay,
  AskQuestionItemDisplay,
  AskUserQuestionRequestDisplay,
  TeamPlanApprovalRequestDisplay,
  PlanApprovalRequestDisplay,
  PlanTodo,
  MemoryType,
  MemoryEntryDisplay,
  ConversationMeta,
  ConversationSearchResult,
  TodoItem,
} from './tool'

export * from './workspaceModels'
export * from './buddyModels'
export * from './mcpModels'
export * from './agentModels'

// ============================================================================
// Re-exports from new type modules (ported from upstream)
// ============================================================================

// Branded IDs
export type { SessionId, AgentId } from './ids'
export { asSessionId, asAgentId, toAgentId } from './ids'

// Command System
export type {
  CommandLoadedFrom,
  CommandAvailability,
  CommandBase,
  LocalCommandResult,
  CommandResultDisplay,
  LocalJSXCommandOnDone,
  ResumeEntrypoint,
  LocalJSXCommandContext,
  PromptCommand,
  LocalCommand,
  LocalJSXCommand,
  Command,
} from './command'
export { getCommandName, isCommandEnabled } from './command'

// Hook System
export type {
  PromptRequest,
  PromptResponse,
  HookCallbackContext,
  HookEvent,
  HookInput,
  HookJSONOutput,
  AsyncHookJSONOutput,
  SyncHookJSONOutput,
  HookCallback,
  HookCallbackMatcher,
  HookProgress,
  HookBlockingError,
  PermissionRequestResult as HookPermissionRequestResult,
  HookResult,
  AggregatedHookResult,
} from './hooks'
export { isSyncHookJSONOutput, isAsyncHookJSONOutput } from './hooks'

// Plugin System
export type {
  PluginComponent,
  PluginRepository,
  PluginConfig,
  PluginAuthor,
  PluginManifest,
  CommandMetadata,
  BuiltinPluginDefinition,
  LoadedPlugin,
  PluginError,
  PluginLoadResult,
} from './plugin'
export { getPluginErrorMessage } from './plugin'

// Extended Permission Types
export type {
  ExternalPermissionMode,
  InternalPermissionMode,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionRule,
  PermissionUpdateDestination,
  PermissionUpdate,
  WorkingDirectorySource,
  AdditionalWorkingDirectory,
  PermissionCommandMetadata,
  PermissionMetadata,
  PendingClassifierCheck,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionResult as ExtendedPermissionResult,
  ClassifierResult,
  ClassifierBehavior,
  ClassifierUsage,
  YoloClassifierResult,
  RiskLevel,
  PermissionExplanation,
  ToolPermissionRulesBySource,
  ToolPermissionContext,
} from './permissions'

// Log / Transcript Types
export type {
  SerializedMessage,
  PersistedWorktreeSession,
  FileAttributionState,
  AttributionSnapshotMessage,
  ContentReplacementRecord,
  LogOption,
  SummaryMessage,
  CustomTitleMessage,
  AiTitleMessage,
  LastPromptMessage,
  TaskSummaryMessage,
  TagMessage,
  AgentNameMessage,
  AgentColorMessage,
  AgentSettingMessage,
  PRLinkMessage,
  ModeEntry,
  WorktreeStateEntry,
  ContentReplacementEntry,
  FileHistorySnapshotMessage,
  FileHistorySnapshot,
  TranscriptMessage,
  SpeculationAcceptMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  QueueOperationMessage,
  Entry,
} from './logs'
export { sortLogs } from './logs'

// Queue & Input Types
export type {
  InlineGhostText,
  VimMode,
  ImageDimensions,
  TextHighlight,
  PastedContent,
  PromptInputMode,
  EditablePromptInputMode,
  QueuePriority,
  OrphanedPermission,
  QueuedCommand,
  BaseTextInputProps,
  VimTextInputProps,
  BaseInputState,
  TextInputState,
  VimInputState,
} from './queue'
export { isValidImagePaste, getImagePasteIds } from './queue'

// Telemetry Types
export type {
  Timestamp,
  PublicApiAuth,
  GitHubActionsMetadata,
  EnvironmentMetadata,
  SlackContext,
  ClaudeCodeInternalEvent,
  GrowthbookExperimentEvent,
} from './telemetry'
export { fromTimestamp, toTimestamp, serializeInternalEvent } from './telemetry'

// Electron API global augmentation (declare global { interface Window { electronAPI: ... } })
import './electronAPI'
