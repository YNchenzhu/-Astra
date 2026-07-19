/**
 * Wire protocol for the tool worker utilityProcess.
 *
 * The protocol is intentionally tiny: a single request / response /
 * abort triplet routed over the `MessageChannelMain` between
 * {@link toolWorkerHost} (main process) and {@link toolWorkerEntry}
 * (utilityProcess child).
 *
 * Invariants enforced here:
 *   - There is **no reverse RPC** into main (no tool calls, no shared
 *     mutable singleton sync). One-way {@link ToolRpcProgress} frames
 *     are allowed so long-running tools can surface status to the host.
 *     Hooks / PermissionManager / write guards still run only in main
 *     around `toolRegistry.execute()` before dispatch.
 *   - `reqId` is monotonic per host instance. The worker echoes it
 *     verbatim in every response / progress frame.
 *   - `result` is the same {@link import('../types').ToolResult} shape
 *     a main-process tool returns. The worker is forbidden from
 *     producing fields not in that shape (a Zod-style guard on the
 *     host filters unknown keys defensively).
 */

import type { ToolProgressEvent } from '../toolExecContext'
import type { ToolResult } from '../types'
import type { ReadFileRecord } from '../readFileState'

/**
 * A main-process read receipt forwarded alongside a file-mutation
 * `tool_request` (SA-5 / P0 main↔worker guard-state split fix).
 *
 * The worker's `readFileState` is a fresh per-process copy, so receipts
 * recorded in main (read_file executed in main, approval-chain re-reads,
 * PostToolUse hook re-stamps) are invisible to the worker's
 * `assertReadBeforeWrite` / `findReadReceiptByReadId` gates. The host
 * snapshots the relevant receipt(s) at dispatch time and the worker
 * imports them (idempotently) before executing the tool.
 */
export interface ToolRpcReadReceipt {
  /** Lowercased, forward-slash-normalised path key (same form `readFileState` uses). */
  pathKey: string
  /** Shallow copy of the main-process receipt. */
  record: ReadFileRecord
}

/** Sent from host → worker to ask for a tool execution. */
export interface ToolRpcRequest {
  kind: 'tool_request'
  reqId: number
  /** Tool name (must match a registered worker-side executor). */
  name: string
  /** Tool input — assumed to be Zod-validated by the host before send. */
  input: Record<string, unknown>
  /**
   * Fresh merged settings snapshot from the main process (`readDiskSettings`).
   * Required on every request so WebSearch keys and other tool reads stay
   * in sync without the child needing `setDiskSettingsLoader`.
   */
  diskSettingsSnapshot: Record<string, unknown>
  /**
   * When true, the worker may emit {@link ToolRpcProgress} (e.g. `web_fetch`
   * status lines). Host forwards them to `ToolUseContext.emitToolProgress`.
   */
  enableHostProgress?: boolean
  /**
   * Optional — only set on file-mutation tools (write_file / edit_file /
   * multi_edit_file). Main-process read receipts for the target path
   * (and the `baseReadId` anchor) so the worker-side read-before-write
   * gates see what main saw. Backward compatible: workers that predate
   * this field ignore unknown keys (the entry handler destructures only
   * the fields it knows).
   */
  readReceipts?: ToolRpcReadReceipt[]
  /**
   * Subset of {@link import('../toolExecContext').ToolUseContext} that
   * survives structured clone. Closures (progress emitter, abort signal)
   * are recreated inside the worker from primitive flags.
   */
  ctx?: {
    agentId?: string
    permissionMode?: string
    workspacePath?: string | null
    /** Forwarded for session-memory-internal belt-and-suspenders gates in the child. */
    sessionAgentType?: string
    /** Forwarded for session-memory-internal single-target write enforcement in the child. */
    sessionMemoryWritableTargetPath?: string
  }
}

/**
 * Sent from host → worker right after `tool_ready`. Carries
 * one-time, process-level state the executors need (workspace path,
 * web-search API keys, etc.). The host re-sends this after a respawn
 * so a fresh worker is fully configured before the first dispatch.
 *
 * Reads + writes happen against a worker-local copy of these values;
 * mutations in the main process get propagated via additional
 * `tool_init` messages (treated as "patch the worker's view").
 */
export interface ToolRpcInit {
  kind: 'tool_init'
  workspacePath: string | null
  /**
   * Initial settings snapshot (same shape as {@link ToolRpcRequest.diskSettingsSnapshot}).
   */
  diskSettingsSnapshot?: Record<string, unknown>
}

/** Sent from host → worker to cancel an in-flight request. */
export interface ToolRpcAbort {
  kind: 'tool_abort'
  reqId: number
  reason?: string
}

/** Sent from worker → host on completion. */
export interface ToolRpcResponse {
  kind: 'tool_response'
  reqId: number
  ok: true
  result: ToolResult
}

/** Sent from worker → host when execution throws (or rejects). */
export interface ToolRpcError {
  kind: 'tool_error'
  reqId: number
  ok: false
  /** Plain string — Error.message + classname stripped of stack. */
  error: string
  /**
   * Stable {@link import('../../ai/classifyToolError').ToolErrorClass} value
   * derived from the thrown error's message (or `'aborted'`), NOT the raw
   * `Error.name` — so a generic `Error` no longer collapses to the useless
   * `"Error"` bucket that the main-path classifier then skips.
   */
  errorClass?: string
  /**
   * Stable snake_case telemetry label. For executor exceptions it carries the
   * original `Error.name` so observability keeps the infra origin
   * (`worker_executor_exception:<Name>:<hint>`).
   */
  telemetryHint?: string
}

/**
 * One-time handshake on worker boot. Host blocks the first dispatch
 * until this arrives so we don't race the worker's module-init phase.
 */
export interface ToolRpcReady {
  kind: 'tool_ready'
  pid: number
}

/** Worker → host mid-flight progress (`web_fetch`, future stream tools). */
export interface ToolRpcProgress {
  kind: 'tool_progress'
  reqId: number
  event: ToolProgressEvent
}

/**
 * Host → worker meta message. Currently only used to nudge the worker
 * into clean shutdown; reserved for future feature flags / hot-reload.
 */
export interface ToolRpcShutdown {
  kind: 'tool_shutdown'
}

export type HostToWorker =
  | ToolRpcRequest
  | ToolRpcAbort
  | ToolRpcShutdown
  | ToolRpcInit
export type WorkerToHost =
  | ToolRpcResponse
  | ToolRpcError
  | ToolRpcReady
  | ToolRpcProgress

/**
 * Strict runtime validator for any worker → host frame.
 *
 * The host receives these over `MessageChannelMain` from an isolated
 * utilityProcess and must not blindly trust the shape: a buggy / mismatched
 * worker build could otherwise resolve a pending RPC with `undefined`
 * (`tool_response` without a `result`) or a non-string `error`, crashing the
 * agentic loop downstream. We validate every field per `kind` here so
 * malformed frames are rejected at the boundary (see
 * `ToolWorkerHost.handleMessage`).
 */
export function isWorkerToHost(msg: unknown): msg is WorkerToHost {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  switch (m.kind) {
    case 'tool_ready':
      return typeof m.pid === 'number'
    case 'tool_progress':
      return typeof m.reqId === 'number' && !!m.event && typeof m.event === 'object'
    case 'tool_response':
      return (
        typeof m.reqId === 'number' &&
        m.ok === true &&
        !!m.result &&
        typeof m.result === 'object' &&
        typeof (m.result as Record<string, unknown>).success === 'boolean'
      )
    case 'tool_error':
      return (
        typeof m.reqId === 'number' &&
        m.ok === false &&
        typeof m.error === 'string' &&
        (m.errorClass === undefined || typeof m.errorClass === 'string') &&
        (m.telemetryHint === undefined || typeof m.telemetryHint === 'string')
      )
    default:
      return false
  }
}
