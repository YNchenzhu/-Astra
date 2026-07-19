import type { PermissionMode, PermissionBehavior } from './tool'

// ============================================================================
// Extended Permission System Types
// These complement the simplified types in tool.ts
// ============================================================================

// Re-export base types for convenience
export type { PermissionMode, PermissionBehavior } from './tool'

// ============================================================================
// Permission Modes (external/internal taxonomy)
// ============================================================================

/**
 * User-facing permission modes (CLI flags, settings.json).
 */
export type ExternalPermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan'

/**
 * Internal permission modes (includes implementation-specific modes).
 */
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'

// ============================================================================
// Permission Rules
// ============================================================================

/**
 * Where a permission rule originated from.
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/**
 * The value of a permission rule - specifies which tool and optional content.
 */
export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/**
 * A permission rule with its source and behavior.
 */
export interface PermissionRule {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

// ============================================================================
// Permission Updates
// ============================================================================

/**
 * Where a permission update should be persisted.
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/**
 * Update operations for permission configuration.
 */
export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

// ============================================================================
// Working Directory Permissions
// ============================================================================

/**
 * Source of an additional working directory permission.
 */
export type WorkingDirectorySource = PermissionRuleSource

/**
 * An additional directory included in permission scope.
 */
export interface AdditionalWorkingDirectory {
  path: string
  source: WorkingDirectorySource
}

// ============================================================================
// Permission Decisions & Results
// ============================================================================

/**
 * Minimal command shape for permission metadata.
 */
export interface PermissionCommandMetadata {
  name: string
  description?: string
  [key: string]: unknown
}

/**
 * Metadata attached to permission decisions.
 */
export type PermissionMetadata =
  | { command: PermissionCommandMetadata }
  | undefined

/**
 * Metadata for a pending classifier check that will run asynchronously.
 */
export interface PendingClassifierCheck {
  command: string
  cwd: string
  descriptions: string[]
}

/**
 * Result when permission is granted.
 */
export interface PermissionAllowDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  behavior: 'allow'
  updatedInput?: Input
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
  contentBlocks?: unknown[]
}

/**
 * Result when user should be prompted.
 */
export interface PermissionAskDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  behavior: 'ask'
  message: string
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  isBashSecurityCheckForMisparsing?: boolean
  pendingClassifierCheck?: PendingClassifierCheck
  contentBlocks?: unknown[]
}

/**
 * Result when permission is denied.
 */
export interface PermissionDenyDecision {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

/**
 * A permission decision - allow, ask, or deny.
 */
export type PermissionDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision

/**
 * Explanation of why a permission decision was made.
 */
export type PermissionDecisionReason =
  | {
      type: 'rule'
      rule: PermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'subcommandResults'
      reasons: Map<string, PermissionResult>
    }
  | {
      type: 'permissionPromptTool'
      permissionPromptToolName: string
      toolResult: unknown
    }
  | {
      type: 'hook'
      hookName: string
      hookSource?: string
      reason?: string
    }
  | {
      type: 'asyncAgent'
      reason: string
    }
  | {
      type: 'sandboxOverride'
      reason: 'excludedCommand' | 'dangerouslyDisableSandbox'
    }
  | {
      type: 'classifier'
      classifier: string
      reason: string
    }
  | {
      type: 'workingDir'
      reason: string
    }
  | {
      type: 'safetyCheck'
      reason: string
      classifierApprovable: boolean
    }
  | {
      type: 'other'
      reason: string
    }

/**
 * Permission result with additional passthrough option.
 * This extends the simplified version in tool.ts.
 */
export type PermissionResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecisionReason
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      pendingClassifierCheck?: PendingClassifierCheck
    }

// ============================================================================
// Bash Classifier Types
// ============================================================================

/**
 * Result from a bash classifier evaluation.
 */
export interface ClassifierResult {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

/**
 * Classifier behavior decision.
 */
export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

/**
 * Token usage from a classifier API call.
 */
export interface ClassifierUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * Detailed classifier result with stage tracing info.
 */
export interface YoloClassifierResult {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  transcriptTooLong?: boolean
  model: string
  usage?: ClassifierUsage
  durationMs?: number
  promptLengths?: {
    systemPrompt: number
    toolCalls: number
    userPrompts: number
  }
  errorDumpPath?: string
  stage?: 'fast' | 'thinking'
  stage1Usage?: ClassifierUsage
  stage1DurationMs?: number
  stage1RequestId?: string
  stage1MsgId?: string
  stage2Usage?: ClassifierUsage
  stage2DurationMs?: number
  stage2RequestId?: string
  stage2MsgId?: string
}

// ============================================================================
// Permission Explainer Types
// ============================================================================

/**
 * Risk level for permission explanations.
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

/**
 * Explanation of a permission decision for display.
 */
export interface PermissionExplanation {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

// ============================================================================
// Tool Permission Context
// ============================================================================

/**
 * Mapping of permission rules by their source.
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
}

/**
 * Full context needed for permission checking in tools.
 */
export interface ToolPermissionContext {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}
