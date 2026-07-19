/**
 * Tool availability names and sets — **source of truth**: {@link ../agents/types}.
 * This module re-exports those sets so legacy imports stay valid without drifting.
 */

export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
  COORDINATOR_OC_CORE_TOOL_NAMES,
  COORDINATOR_EXTENDED_TOOL_NAMES,
  getCoordinatorModeAllowedToolNames,
} from '../agents/types'

/** String constants for IPC / UI (registry primary names). */
export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const TASK_STOP_TOOL_NAME = 'TaskStop'
export const AGENT_TOOL_NAME = 'Agent'
export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree'
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree'
