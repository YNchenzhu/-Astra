/**
 * Wire-protocol types for the main-process <-> sub-agent worker_thread channel.
 *
 * Extracted from `subAgentWorkerClient.ts` (file-split refactor). Both the RPC
 * bridge and the event bridge depend on these, so they live in their own
 * dependency-free module. The single source of truth for the init payload is
 * `bridge/sessionMessages.ts:SessionInitSchema` (re-exported here as
 * `InitPayload`).
 */

import type { LoopEvent, AgenticLoopResult } from '../ai/loopEvents'
import type {
  RemoteHostParentMessage,
  RemoteHostWorkerMessage,
  SessionInit,
} from '../bridge/sessionMessages'

// ─── worker -> main (tool RPC) ───

export interface WorkerToolCall {
  kind: 'tool_call'
  reqId: number
  toolName: string
  toolInput: Record<string, unknown>
}

// ─── main -> worker (tool RPC replies) ───

export interface WorkerToolResult {
  kind: 'tool_result'
  reqId: number
  result: Record<string, unknown>
}

export interface WorkerToolError {
  kind: 'tool_error'
  reqId: number
  error: string
}

/**
 * Wire shape sent to the worker on `kind: 'init'`. The single source of
 * truth is `bridge/sessionMessages.ts:SessionInitSchema` — both the client and
 * the worker (`subAgentWorker.ts` via `parseParentMessage`) consume the
 * zod-inferred type so any field added/changed on the schema flows to both
 * ends without a manual mirror.
 */
export type InitPayload = SessionInit

export type ParentMessage =
  | { kind: 'init'; payload: InitPayload; reqId?: number }
  | { kind: 'abort'; reason?: string }
  | { kind: 'update_token'; token: string }
  | RemoteHostParentMessage

export type WorkerMessage =
  | { kind: 'ready' }
  | { kind: 'started'; sessionId: string }
  | { kind: 'event'; event: LoopEvent }
  // Graceful wind-down fired inside the worker fan-out (read-only tool/token
  // pressure, or approaching the iteration cap). Not a `LoopEvent` — the loop
  // core doesn't know about wind-down; it's the sub-agent fan-out's decision —
  // so it rides its own message kind rather than polluting the 1:1
  // LoopEvent↔callback contract. The client re-emits it as
  // `subagent_winddown`.
  | {
      kind: 'winddown'
      trigger: 'tools' | 'tokens' | 'iterations'
      iteration?: number
      maxIterations?: number
    }
  | { kind: 'log'; level: string; message: string }
  // `finalApiMessages` carries the worker's live loop transcript (kept in
  // sync by `syncAgentContextConversation` each iteration). The host uses it
  // to run the final-summary rescue on budget-abort / max-iterations so the
  // worker path produces a complete report instead of a truncated fragment —
  // parity with the in-process path. Optional: legacy workers omit it and the
  // host simply skips the rescue.
  | { kind: 'done'; result: AgenticLoopResult; finalApiMessages?: Array<Record<string, unknown>> }
  | { kind: 'fail'; error: string; finalApiMessages?: Array<Record<string, unknown>> }
  | RemoteHostWorkerMessage
  | WorkerToolCall

// ─── scheduler-admission RPC (LOCAL worker-executed tools) ───
//
// These were previously matched untyped (`raw as Record<string, unknown>` +
// `msg.kind` string compares) in the client's message handler. Formalized here
// for documentation and so future consumers can switch on the union; the
// runtime handler may still narrow from the loose shape.

/** worker -> main: request scheduler admission for a LOCAL (worker-run) tool. */
export interface WorkerAdmitRequest {
  kind: 'admit_request'
  reqId: number
  toolName: string
  toolInput: Record<string, unknown>
  isReadOnly: boolean
}

/** main -> worker: admission granted. */
export interface MainAdmitGrant {
  kind: 'admit_grant'
  reqId: number
}

/** main -> worker: admission denied (e.g. quota). */
export interface MainAdmitDeny {
  kind: 'admit_deny'
  reqId: number
  reason?: string
}

/** main -> worker: the lease's effective preemption signal fired. */
export interface MainAdmitAbort {
  kind: 'admit_abort'
  reqId: number
  reason?: string
}

/** worker -> main: LOCAL tool finished, release the admission slot. */
export interface WorkerAdmitDone {
  kind: 'admit_done'
  reqId: number
  success?: boolean
}
