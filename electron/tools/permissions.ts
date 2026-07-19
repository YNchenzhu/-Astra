/**
 * Permission system — runtime constants + type re-exports.
 *
 * Runtime constants (PERMISSION_MODES, EXTERNAL_PERMISSION_MODES) live here
 * because they are consumed by the permission evaluation pipeline.
 * All type definitions are re-exported from the canonical src/types/permissions.ts.
 */

// ============================================================================
// Runtime Constants (used by permission evaluation)
// ============================================================================

/**
 * User-addressable permission modes (settings.json defaultMode, --permission-mode CLI flag).
 * Aligned with cursor-ui-clone's preload.ts PermissionMode union.
 */
export const PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
  'auto',
  'bubble',
] as const

/**
 * Subset of modes exposed to external API clients.
 * Internal modes ('auto', 'bubble') are not user-selectable.
 */
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

// ============================================================================
// Type Re-exports (canonical definitions in src/types/permissions.ts)
// ============================================================================

export type {
  PermissionMode,
  ExternalPermissionMode,
  InternalPermissionMode,
  PermissionBehavior,
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
  PermissionResult,
  ClassifierResult,
  ClassifierBehavior,
  ClassifierUsage,
  YoloClassifierResult,
  RiskLevel,
  PermissionExplanation,
  ToolPermissionRulesBySource,
  ToolPermissionContext,
} from '../../src/types/permissions'
