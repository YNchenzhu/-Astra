// ============================================================================
// Permission Types (simplified from upstream permissions.ts)
// ============================================================================

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'dontAsk'
  /** Main-process / advanced: bash classifier auto-approve (report §5.1 / §5.8). */
  | 'auto'
  /** Internal: effective policy same as `default` (report §5.1). */
  | 'bubble'
export type DiffPermissionMode = 'default' | 'bypassPermissions'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'ask'; message: string; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
