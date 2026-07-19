/**
 * Tasks module — unified task system for cursor-ui-clone.
 *
 * Equivalence to upstream's tasks/ directory, adapted to this project's
 * Electron + TypeScript architecture. Provides:
 *
 * 1. Unified Task interface (Strategy Pattern)
 * 2. Multiple task types: shell, agent, main_session, remote_agent
 * 3. Foreground/background dual mode
 * 4. XML notification system for task completion
 * 5. Shell stall watchdog for interactive prompt detection
 * 6. Cleanup registry for process-exit resource management
 * 7. Pill label system for status bar background task summary
 * 8. Batch kill operations (all tasks, per-agent tasks)
 * 9. Structured error codes for task stopping
 *
 * Architecture:
 * - taskInterface.ts     — Task interface + implementation registry
 * - guards.ts            — Type guards for each task state
 * - taskStateManager.ts  — Central task state store (immutable updates)
 * - foregroundTracker.ts  — Foreground vs background tracking
 * - notificationSystem.ts — XML task notification queue
 * - cleanupRegistry.ts    — Process-exit cleanup callbacks
 * - stallWatchdog.ts      — Shell stall + interactive prompt detection
 * - pillLabel.ts          — Status bar pill label generation
 * - taskDispatcher.ts     — Stop task routing + error codes + batch kill
 * - ShellTaskManager.ts   — Shell task lifecycle + kill implementation
 * - AgentTaskManager.ts   — Agent task lifecycle + kill implementation
 */

// Core interface
export {
  registerTaskImpl,
  getTaskByType,
  getAllTaskImpls,
} from './taskInterface'
export type { Task, TaskType, TaskStatus, TaskStateBase } from './taskInterface'

// ID generator (upstream §6.2 — prefix + base36 random)
export { createTaskId, inferTaskTypeFromId } from './createTaskId'

// Type guards
export {
  isLocalShellTask,
  isLocalAgentTask,
  isMainSessionTask,
  isRemoteAgentTask,
  isLocalWorkflowTask,
  isMonitorMcpTask,
  isDreamTask,
  taskTypeLabel,
} from './guards'
export type {
  LocalShellTaskState,
  LocalAgentTaskState,
  LocalMainSessionTaskState,
  RemoteAgentTaskState,
  LocalWorkflowTaskState,
  MonitorMcpTaskState,
  DreamTaskState,
  AnyTaskState,
} from './guards'

// State management
export {
  registerTaskState,
  updateTaskState,
  getTaskState,
  getAllTaskStates,
  getTaskStatesByStatus,
  getTaskStatesByType,
  getBackgroundTasks,
  getForegroundTasks,
  removeTaskState,
  clearAllTaskStates,
  createTaskStateBase,
} from './taskStateManager'

// Foreground/background
export {
  registerForegroundTask,
  unregisterForegroundTask,
  isForegroundTask,
  getAllForegroundTasks,
  hasForegroundTasks,
  backgroundAllForegroundTasks,
  backgroundForegroundTask,
} from './foregroundTracker'

// Notifications
export {
  enqueueTaskNotification,
  drainNotificationsXml,
  hasPendingNotifications,
  clearNotifications,
  taskCompletedNotification,
  taskFailedNotification,
  taskKilledNotification,
  dequeueByAgent,
} from './notificationSystem'
export type { TaskNotification, NotificationStatus } from './notificationSystem'

// Notification drainage helper
export {
  drainPendingTaskNotifications,
  hasPendingTaskNotifications,
} from './drainNotifications'

// Cleanup
export {
  registerCleanup,
  unregisterCleanup,
  cleanupAll,
  cleanupCount,
  __clearAllCleanupForTests,
} from './cleanupRegistry'

// Stall watchdog
export {
  startStallWatchdog,
  looksLikePrompt,
  STALL_CHECK_INTERVAL_MS,
  STALL_THRESHOLD_MS,
  STALL_TAIL_BYTES,
} from './stallWatchdog'
export type { StallWatchdogHandle } from './stallWatchdog'

// Pill label
export { getPillLabel } from './pillLabel'
export type { PillInfo } from './pillLabel'

// Dispatcher
export {
  stopTask,
  killAllTasks,
  killTasksByAgent,
  StopTaskError,
} from './taskDispatcher'
export type { StopTaskErrorCode } from './taskDispatcher'

// Shell task manager
export {
  createShellTaskState,
  registerForegroundShell,
  startShellStallWatchdog,
  trackShellProcess,
  completeShellTask,
  failShellTask,
  killShellTask,
  backgroundShellTask,
  markShellTaskNotified,
  markAllShellTasksNotified,
  killShellTasksForAgent,
} from './ShellTaskManager'

// Agent task manager
export {
  registerBackgroundAgent,
  registerForegroundAgent,
  updateAgentProgress,
  updateAgentSummary,
  completeAgentTask,
  failAgentTask,
  killAgentTask,
  backgroundAgentTask,
  killAllAgentTasks,
  markAgentTasksNotified,
} from './AgentTaskManager'

// Workflow task manager (declarative multi-step pipelines)
export {
  registerForegroundWorkflow,
  registerBackgroundWorkflow,
  updateWorkflowStep,
  completeWorkflowTask,
  failWorkflowTask,
  killWorkflowTask,
  backgroundWorkflowTask,
  killAllWorkflowTasks,
} from './WorkflowTaskManager'
export type { WorkflowRegistration } from './WorkflowTaskManager'

// MCP server liveness monitors
export {
  registerMcpMonitor,
  completeMcpMonitor,
  failMcpMonitor,
  killMcpMonitor,
  killAllMcpMonitors,
} from './McpMonitorTaskManager'
export type { McpMonitorRegistration } from './McpMonitorTaskManager'

// Dream tasks (proactive idle-time agents)
export {
  registerDream,
  updateDreamSummary,
  completeDream,
  failDream,
  wakeDream,
  killDream,
  killAllDreams,
} from './DreamTaskManager'
export type { DreamRegistration } from './DreamTaskManager'

// Remote agent tasks (worker-process isolated sub-agent — P1-A bridge)
export {
  registerForegroundRemoteAgent,
  registerBackgroundRemoteAgent,
  completeRemoteAgentTask,
  failRemoteAgentTask,
  killRemoteAgentTask,
  backgroundRemoteAgentTask,
  killAllRemoteAgentTasks,
} from './RemoteAgentTaskManager'
export type { RemoteAgentRegistration } from './RemoteAgentTaskManager'
