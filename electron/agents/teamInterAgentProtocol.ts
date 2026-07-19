/**
 * upstream report §7.7 / §7.8 — structured team / mailbox messages (in-process subset).
 *
 * Envelope lines are typically `[ISO8601] {json}` from {@link formatTeamMailboxEnvelopeLine}.
 * Protocol payloads may live in the outer JSON's `payload` string or as a top-level object.
 *
 * ## Typed handoff (this PR)
 *
 * Inter-agent messages used to be string blobs validated only by an ad-hoc
 * field allow-list. We now layer **per-kind Zod schemas** on top so:
 *
 *   1. Senders can opt into strict validation via SendMessage's `schema`
 *      parameter (e.g. `schema: 'plan_approval_response'`) — a malformed
 *      JSON or missing required field is rejected BEFORE the message is
 *      enqueued at the recipient.
 *   2. Receivers always run the schema (when one is registered for the
 *      kind) and surface ✓ / ⚠-FAILED tags inside the synthetic prompt
 *      injection so the model can spot bad protocol traffic instead of
 *      silently consuming malformed structured fields.
 *
 * The schemas use `.passthrough()` so future kinds / new optional fields
 * don't break old senders. The original `TeamInterAgentMessage` interface
 * is unchanged — strict typing is opt-in.
 */

import { z } from 'zod'
import type { ZodError, ZodTypeAny } from 'zod'

export const TEAM_INTER_AGENT_SCHEMA = 'openclaude.team.v1' as const

export type TeamInterAgentKind =
  | 'idle_notification'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'permission_forward'
  /** Leader → worker: completes teammate tool-permission wait (§7.9). */
  | 'permission_response'
  | 'mode_set_request'
  /**
   * Active-loop kind — emitted by `TaskUpdateTool` when a task's `owner`
   * is set/changed, addressed to the new owner so an idle teammate can
   * wake up and claim work without polling.
   *
   * Reference implementation: upstream-main
   * `src/tools/TaskUpdateTool/TaskUpdateTool.ts:276-297`.
   */
  | 'task_assignment'
  /**
   * Active-loop kind — emitted by a teammate after it marks an assigned
   * task `completed` (or `failed`). Surfaces back to the team lead so the
   * lead's next user-role turn carries a `<team-inbox>` block summarizing
   * what shipped.
   *
   * Reference implementation: upstream-main idle/completion path under
   * `src/utils/swarm/inProcessRunner.ts:1317-1342`.
   */
  | 'task_completion'

/**
 * Audit fix R2-M5 — optional sender attribution. Receiving sub-agents
 * previously could not tell who sent a `plan_approval_response` /
 * `shutdown_request` etc., because the protocol carried no `from`
 * field; in a 4-teammate team that turned into "approve from whom?"
 * ambiguity. Senders that want to be identifiable populate this; the
 * receiver-side rendering can then prefix the body with
 * `From: <agentType> (<id>) — ...` instead of just dropping a faceless
 * JSON envelope on the recipient.
 */
export interface TeamInterAgentSender {
  agentId: string
  agentType?: string
}

export interface TeamInterAgentMessage {
  schema: typeof TEAM_INTER_AGENT_SCHEMA
  kind: TeamInterAgentKind
  requestId?: string
  /** shutdown_response / plan_approval_response */
  approve?: boolean
  /** Free-form note shown to the model */
  detail?: string
  /** Audit fix R2-M5 — sender attribution; safe to omit on legacy senders. */
  from?: TeamInterAgentSender
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Strip `[timestamp] ` prefix from a mailbox line. */
export function stripMailboxLineTimestamp(line: string): string {
  const m = /^\[[^\]]+]\s+(.*)$/s.exec(line.trim())
  return m ? m[1].trim() : line.trim()
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const t = s.trim()
  if (!t.startsWith('{')) return null
  try {
    const v = JSON.parse(t) as unknown
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

function parseFromSender(v: unknown): TeamInterAgentSender | undefined {
  if (!isRecord(v)) return undefined
  if (typeof v.agentId !== 'string' || v.agentId.length === 0) return undefined
  const agentType = typeof v.agentType === 'string' ? v.agentType : undefined
  return { agentId: v.agentId, ...(agentType ? { agentType } : {}) }
}

function messageFromRecord(rec: Record<string, unknown>): TeamInterAgentMessage | null {
  if (rec.schema !== TEAM_INTER_AGENT_SCHEMA) return null
  const kind = rec.kind
  if (typeof kind !== 'string') return null
  const allowed: TeamInterAgentKind[] = [
    'idle_notification',
    'shutdown_request',
    'shutdown_response',
    'plan_approval_request',
    'plan_approval_response',
    'permission_forward',
    'permission_response',
    'mode_set_request',
    'task_assignment',
    'task_completion',
  ]
  if (!allowed.includes(kind as TeamInterAgentKind)) return null
  const requestId = typeof rec.requestId === 'string' ? rec.requestId : undefined
  const approve = typeof rec.approve === 'boolean' ? rec.approve : undefined
  const detail = typeof rec.detail === 'string' ? rec.detail : undefined
  const from = parseFromSender(rec.from)
  return {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: kind as TeamInterAgentKind,
    requestId,
    approve,
    detail,
    ...(from ? { from } : {}),
  }
}

/**
 * Parse a team protocol object from a single mailbox / queue line.
 */
export function parseTeamInterAgentLine(line: string): TeamInterAgentMessage | null {
  const inner = stripMailboxLineTimestamp(line)
  const outer = tryParseJsonObject(inner)
  if (!outer) return null
  const direct = messageFromRecord(outer)
  if (direct) return direct
  const payload = outer.payload
  if (typeof payload !== 'string') return null
  const nested = tryParseJsonObject(payload)
  return nested ? messageFromRecord(nested) : null
}

/**
 * Serialize a protocol message for use as SendMessage `message` / envelope payload.
 *
 * Audit fix R2-M5 — if the caller did not supply `from`, attempt to
 * resolve it from the active agent context so the receiving side can
 * attribute the message. Resolution is best-effort: requires that
 * {@link getAgentContext} returns a context with an `agentId`. Callers
 * that want guaranteed attribution should set `from` themselves at the
 * send site; this is a safety net for legacy send-paths that pre-date
 * the protocol field.
 */
export function stringifyTeamInterAgentMessage(msg: TeamInterAgentMessage): string {
  const out = msg.from ? msg : autofillFrom(msg)
  return JSON.stringify(out)
}

function autofillFrom(msg: TeamInterAgentMessage): TeamInterAgentMessage {
  try {
    // Lazy require so vitest unit tests of this file (which don't load
    // the whole agent runtime) keep working without mocking the ALS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./agentContext') as typeof import('./agentContext')
    const ctx = mod.getAgentContext()
    if (!ctx?.agentId) return msg
    const sender: TeamInterAgentSender = {
      agentId: String(ctx.agentId),
      ...(ctx.sessionAgentType ? { agentType: ctx.sessionAgentType } : {}),
    }
    return { ...msg, from: sender }
  } catch {
    return msg
  }
}

/**
 * Like {@link parseTeamInterAgentLine} but also returns the inner JSON record
 * (timestamp + envelope unwrapped) so callers can run additional validation
 * — e.g. {@link validateInterAgentMessage} — against the raw record.
 */
export function parseTeamInterAgentLineWithRecord(
  line: string,
): { message: TeamInterAgentMessage; record: Record<string, unknown> } | null {
  const inner = stripMailboxLineTimestamp(line)
  const outer = tryParseJsonObject(inner)
  if (!outer) return null
  const direct = messageFromRecord(outer)
  if (direct) return { message: direct, record: outer }
  const payload = outer.payload
  if (typeof payload !== 'string') return null
  const nested = tryParseJsonObject(payload)
  if (!nested) return null
  const m = messageFromRecord(nested)
  return m ? { message: m, record: nested } : null
}

// ===========================================================================
// Per-kind Zod schemas + name-keyed registry
// ===========================================================================

/**
 * Common base — every inter-agent message must declare the protocol schema id.
 * `passthrough()` lets future fields land without breaking old senders.
 */
const baseInterAgentObject = <K extends TeamInterAgentKind>(kind: K) =>
  z
    .object({
      schema: z.literal(TEAM_INTER_AGENT_SCHEMA),
      kind: z.literal(kind),
      requestId: z.string().min(1).optional(),
      approve: z.boolean().optional(),
      detail: z.string().optional(),
      // Audit fix R2-M5 — optional sender attribution; reject malformed
      // `from` (must be `{ agentId: <non-empty>, agentType?: string }`)
      // but accept legacy senders that omit it entirely.
      from: z
        .object({
          agentId: z.string().min(1),
          agentType: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()

/** Lightweight informational ping; `detail` is the human-readable status. */
export const idleNotificationSchema = baseInterAgentObject('idle_notification')

/**
 * Leader asks a worker to wind down. `requestId` is required so the worker's
 * reply (`shutdown_response`) can be correlated.
 */
export const shutdownRequestSchema = baseInterAgentObject('shutdown_request').extend({
  requestId: z.string().min(1),
})

/** Worker → leader reply confirming/rejecting a shutdown_request. */
export const shutdownResponseSchema = baseInterAgentObject('shutdown_response').extend({
  requestId: z.string().min(1),
  approve: z.boolean(),
})

/**
 * Worker asks the leader to approve a plan. The plan body lives in `detail`
 * by current convention (some kinds carry richer bodies in the future — keep
 * the schema strict on what we promise today).
 */
export const planApprovalRequestSchema = baseInterAgentObject('plan_approval_request').extend({
  requestId: z.string().min(1),
  detail: z.string().min(1, 'plan_approval_request requires plan text in `detail`'),
})

/** Leader → worker reply approving/rejecting a plan_approval_request. */
export const planApprovalResponseSchema = baseInterAgentObject('plan_approval_response').extend({
  requestId: z.string().min(1),
  approve: z.boolean(),
})

/** Worker → leader: forward a tool-permission decision request. */
export const permissionForwardSchema = baseInterAgentObject('permission_forward').extend({
  requestId: z.string().min(1),
})

/** Leader → worker: completes teammate tool-permission wait (§7.9). */
export const permissionResponseSchema = baseInterAgentObject('permission_response').extend({
  requestId: z.string().min(1),
  approve: z.boolean(),
})

/**
 * Leader instructs a worker to set its permission mode. The mode lives in
 * `detail` by convention; restrict to known modes.
 */
export const modeSetRequestSchema = baseInterAgentObject('mode_set_request').extend({
  detail: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']),
})

/**
 * Sender → assignee: a task has been assigned/reassigned. `detail` is the
 * (already-formatted) task id for legacy senders that don't populate
 * `metadata.taskId`; the metadata block is the source of truth.
 *
 * Reference: upstream-main `TaskUpdateTool.ts:276-297` writes a JSON envelope
 * with `{type:'task_assignment', taskId, subject, assignedBy}`. We mirror
 * that contract here as a typed schema instead of a free-form blob.
 */
export const taskAssignmentSchema = baseInterAgentObject('task_assignment').extend({
  detail: z.string().min(1, 'task_assignment requires taskId in `detail`'),
  metadata: z
    .object({
      taskId: z.string().min(1),
      taskSubject: z.string().optional(),
      assignedBy: z.string().optional(),
    })
    .passthrough(),
})

/**
 * Teammate → lead: a previously-owned task reached a terminal state. Lead
 * uses these envelopes to render `<team-inbox kind="task_completion">`
 * blocks in its next user-role attachment.
 */
export const taskCompletionSchema = baseInterAgentObject('task_completion').extend({
  detail: z.string().min(1, 'task_completion requires taskId in `detail`'),
  metadata: z
    .object({
      taskId: z.string().min(1),
      status: z.enum(['completed', 'failed']),
      finalSummary: z.string().optional(),
    })
    .passthrough(),
})

const BUILTIN_SCHEMAS: ReadonlyArray<{ name: TeamInterAgentKind; schema: ZodTypeAny }> = [
  { name: 'idle_notification', schema: idleNotificationSchema },
  { name: 'shutdown_request', schema: shutdownRequestSchema },
  { name: 'shutdown_response', schema: shutdownResponseSchema },
  { name: 'plan_approval_request', schema: planApprovalRequestSchema },
  { name: 'plan_approval_response', schema: planApprovalResponseSchema },
  { name: 'permission_forward', schema: permissionForwardSchema },
  { name: 'permission_response', schema: permissionResponseSchema },
  { name: 'mode_set_request', schema: modeSetRequestSchema },
  { name: 'task_assignment', schema: taskAssignmentSchema },
  { name: 'task_completion', schema: taskCompletionSchema },
]

/** Names of all built-in inter-agent schemas (also = TeamInterAgentKind names). */
export const BUILTIN_INTER_AGENT_SCHEMA_NAMES: ReadonlyArray<string> = BUILTIN_SCHEMAS.map(
  (s) => s.name,
)

const SCHEMA_REGISTRY = new Map<string, ZodTypeAny>()

function seedBuiltinSchemas(): void {
  for (const { name, schema } of BUILTIN_SCHEMAS) {
    SCHEMA_REGISTRY.set(name, schema)
  }
}

seedBuiltinSchemas()

/**
 * Register (or replace) a schema by name. Returns an unregister function that
 * restores the previous binding (or removes the entry if there was none).
 *
 * Names should be unique strings; built-in kind names occupy their slots by
 * default but can be overridden — useful when a deployment wants to tighten
 * a built-in schema for its own discipline.
 */
export function registerInterAgentSchema(name: string, schema: ZodTypeAny): () => void {
  const prev = SCHEMA_REGISTRY.get(name)
  SCHEMA_REGISTRY.set(name, schema)
  return () => {
    if (prev) {
      SCHEMA_REGISTRY.set(name, prev)
    } else {
      SCHEMA_REGISTRY.delete(name)
    }
  }
}

export function getInterAgentSchema(name: string): ZodTypeAny | undefined {
  return SCHEMA_REGISTRY.get(name)
}

export function listInterAgentSchemas(): string[] {
  return Array.from(SCHEMA_REGISTRY.keys()).sort()
}

/** Test helper — restore registry to the built-in baseline. */
export function clearInterAgentSchemasForTests(): void {
  SCHEMA_REGISTRY.clear()
  seedBuiltinSchemas()
}

export type SchemaValidationResult =
  | { ok: true; name: string }
  | { ok: false; name: string; errors: string[] }

function summarizeZodIssues(err: ZodError): string[] {
  return err.issues.map((i) => {
    const p = i.path.length ? i.path.map(String).join('.') : '(root)'
    return `${p}: ${i.message}`
  })
}

/**
 * Validate a parsed JSON record against a registered schema name. Pass-through
 * fields are tolerated; only declared fields are checked.
 *
 * Returns `{ ok: false, errors }` on validation failure (for caller-side
 * decision-making) or `{ ok: false, errors: ['unknown schema'] }` when no
 * schema is registered under `name` — callers can treat that the same way
 * (no validation) or surface it as a configuration error.
 */
export function validateInterAgentMessage(
  record: unknown,
  name: string,
): SchemaValidationResult {
  const schema = SCHEMA_REGISTRY.get(name)
  if (!schema) {
    return { ok: false, name, errors: [`(root): unknown schema "${name}"`] }
  }
  const r = schema.safeParse(record)
  if (r.success) return { ok: true, name }
  return { ok: false, name, errors: summarizeZodIssues(r.error) }
}
