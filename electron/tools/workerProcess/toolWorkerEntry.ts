/**
 * utilityProcess entry for the tool execution subsystem.
 *
 * Loaded by `utilityProcess.fork(<this file>)` from
 * {@link toolWorkerHost}. Runs in an isolated V8 — does NOT import:
 *   - hooks engine, PermissionManager, the main toolRegistry
 *   - LSP / cron / tasks / MCP
 *
 * Owns:
 *   - The host RPC pump (read parentPort, dispatch, reply)
 *   - Per-request AbortController so {@link ToolRpcAbort} cancels
 *     real fs.read / fetch calls inside executors
 *   - Per-request {@link runWithWorkerAgentGateAsync} so
 *     session-memory belt-and-suspenders gates see `sessionAgentType`
 *   - Optional {@link runWithWorkerToolProgressAsync} for `web_fetch`
 *
 * Pure executors live in {@link ./executors.ts}.
 */

import { classifyToolError } from '../../ai/classifyToolError'
import { getExecutor } from './executors'
import {
  applyDiskSettingsForExecution,
  applyReadReceiptsForExecution,
  applyToolInit,
} from './workerSideState'
import { runWithWorkerAgentGateAsync } from './workerAgentGateContext'
import { runWithWorkerToolProgressAsync } from './workerToolProgressContext'
import type {
  HostToWorker,
  ToolRpcAbort,
  ToolRpcError,
  ToolRpcInit,
  ToolRpcReady,
  ToolRpcRequest,
  ToolRpcResponse,
  WorkerToHost,
} from './wireProtocol'

interface ParentPort {
  on(event: 'message', handler: (event: { data: unknown }) => void): void
  postMessage(message: WorkerToHost): void
}

function getParentPort(): ParentPort | null {
  const pp = (process as unknown as { parentPort?: ParentPort }).parentPort
  return pp ?? null
}

const inflightAborts = new Map<number, AbortController>()

async function handleRequest(
  parentPort: ParentPort,
  req: ToolRpcRequest,
): Promise<void> {
  const exec = getExecutor(req.name)
  if (!exec) {
    const err: ToolRpcError = {
      kind: 'tool_error',
      reqId: req.reqId,
      ok: false,
      error: `tool worker has no executor for '${req.name}'`,
      errorClass: 'unknown_tool',
    }
    parentPort.postMessage(err)
    return
  }

  const controller = new AbortController()
  inflightAborts.set(req.reqId, controller)

  const gateSnap = {
    sessionAgentType: req.ctx?.sessionAgentType,
    sessionMemoryWritableTargetPath: req.ctx?.sessionMemoryWritableTargetPath,
  }

  await runWithWorkerAgentGateAsync(gateSnap, async () => {
    applyDiskSettingsForExecution(req.diskSettingsSnapshot)
    // SA-5: make main-process read receipts visible to this process's
    // read-before-write gates BEFORE the executor runs.
    applyReadReceiptsForExecution(req.readReceipts)

    const runCore = async (): Promise<void> => {
      try {
        const result = await exec(req.input, controller.signal, req.ctx)
        const resp: ToolRpcResponse = {
          kind: 'tool_response',
          reqId: req.reqId,
          ok: true,
          result,
        }
        parentPort.postMessage(resp)
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        // Classify by message (same helper main-process tools use) so an
        // executor that throws gets an actionable `ToolErrorClass` instead of
        // the raw `Error.name` (usually the useless `"Error"`), which the
        // main-path classifier would treat as an explicit class and skip.
        // The original `Error.name` is preserved in `telemetryHint` so the
        // worker-executor origin stays observable.
        let errorClass: string
        let telemetryHint: string
        if (controller.signal.aborted) {
          errorClass = 'aborted'
          telemetryHint = 'aborted'
        } else {
          const classified = classifyToolError(e, { toolName: req.name })
          errorClass = classified.class
          const originalName = e instanceof Error ? e.name : 'unknown'
          telemetryHint = `worker_executor_exception:${originalName}:${classified.telemetryHint}`
        }
        const resp: ToolRpcError = {
          kind: 'tool_error',
          reqId: req.reqId,
          ok: false,
          error,
          errorClass,
          telemetryHint,
        }
        parentPort.postMessage(resp)
      } finally {
        inflightAborts.delete(req.reqId)
      }
    }

    if (req.enableHostProgress) {
      await runWithWorkerToolProgressAsync((event) => {
        parentPort.postMessage({
          kind: 'tool_progress',
          reqId: req.reqId,
          event,
        })
      }, runCore)
    } else {
      await runCore()
    }
  })
}

function handleAbort(req: ToolRpcAbort): void {
  const controller = inflightAborts.get(req.reqId)
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error(req.reason ?? 'aborted by host'))
  }
}

function handleShutdown(): void {
  for (const ctrl of inflightAborts.values()) {
    if (!ctrl.signal.aborted) ctrl.abort(new Error('worker shutting down'))
  }
  setImmediate(() => process.exit(0))
}

function handleInit(msg: ToolRpcInit): void {
  applyToolInit(msg)
}

function boot(parentPort: ParentPort): void {
  parentPort.on('message', (event) => {
    const msg = event?.data as HostToWorker | undefined
    if (!msg || typeof msg !== 'object') return
    switch (msg.kind) {
      case 'tool_request':
        void handleRequest(parentPort, msg)
        return
      case 'tool_abort':
        handleAbort(msg)
        return
      case 'tool_shutdown':
        handleShutdown()
        return
      case 'tool_init':
        handleInit(msg)
        return
    }
  })

  const ready: ToolRpcReady = { kind: 'tool_ready', pid: process.pid }
  parentPort.postMessage(ready)
}

const parentPort = getParentPort()
if (parentPort) {
  try {
    boot(parentPort)
  } catch (e) {
    console.error(
      '[toolWorkerEntry] boot failed:',
      e instanceof Error ? (e.stack ?? e.message) : e,
    )
    process.exit(2)
  }
}
