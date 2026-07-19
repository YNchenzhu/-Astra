/**
 * Worker-side tool executor registry.
 *
 * Each entry here is a **pure** function: it accepts the tool input,
 * an {@link AbortSignal}, and an optional small subset of
 * {@link ToolUseContext}, and returns a {@link ToolResult}. No
 * imports allowed from:
 *   - readFileState / fileLock / writeIntegrityGuard
 *   - hooks engine, PermissionManager
 *   - the main toolRegistry (or anything that loads it)
 *
 * Phases 2-4 extend this registry. Phase 1 ships only the `ping`
 * executor used to smoke-test the host → worker → host roundtrip.
 */

import type { ToolResult } from '../types'
import type { ToolRpcRequest } from './wireProtocol'

import { toolReadFile } from '../../ai/toolReadFile'
import { toolGlob } from '../../ai/toolGlob'
import { toolGrep, type GrepOutputMode } from '../../ai/toolGrep'
import { toolWebFetch } from '../../ai/toolWebFetch'
import { toolWebSearch, type WebSearchEngine } from '../../ai/toolWebSearch'
import {
  toolWriteFile,
  toolEditFile,
  toolMultiEditFile,
} from '../../ai/tools'
import { runSandboxedCommand } from '../../utils/sandbox/sandbox-command'
import { validateBashCommand } from '../bashSecurity'
import { runPowerShellCommand } from '../shellRunner'
import { appendPreExecutionWarnings } from '../shellErrorFormat'
import type { ToolErrorClass } from '../../ai/classifyToolError'
import { validatePowerShellCommand } from '../powershell/validatePowerShellCommand'
import { getWorkspacePath } from '../workspaceState'
import { getWorkerToolProgressEmitter } from './workerToolProgressContext'

/**
 * Per-tool worker executor.
 *
 * `signal` is fed by the host's {@link ToolRpcAbort} — long-running
 * executors (fetch, fs.readFile) should pass it through.
 *
 * `ctx` is a structured-clone-safe subset of {@link ToolUseContext}
 * (closures don't survive the IPC boundary). Worker executors must
 * not assume an emitter is wired up.
 */
export type Executor = (
  input: Record<string, unknown>,
  signal: AbortSignal,
  ctx?: ToolRpcRequest['ctx'],
) => Promise<ToolResult>

const registry = new Map<string, Executor>()

export function registerExecutor(name: string, fn: Executor): void {
  registry.set(name, fn)
}

export function getExecutor(name: string): Executor | undefined {
  return registry.get(name)
}

export function listExecutors(): string[] {
  return Array.from(registry.keys())
}

// ─── Phase 1: ping echo ───
// A no-op executor that simply echoes a string. Used by
// `toolWorkerHost.test.ts` to smoke-test the full RPC chain end-to-end
// without depending on any real tool's side effects.

registerExecutor('__tool_worker_ping', async (input) => {
  if (typeof input.delayMs === 'number' && input.delayMs > 0) {
    await new Promise((r) => setTimeout(r, input.delayMs as number))
  }
  if (input.fail === true) {
    throw new Error(typeof input.error === 'string' ? input.error : 'forced failure')
  }
  const echo = typeof input.echo === 'string' ? input.echo : ''
  return { success: true, output: `pong:${echo}` }
})

// ─── Phase 2: read-only tool executors ───
//
// These wrap the existing main-process tool functions verbatim, the
// same way `subAgentWorker.ts#registerLocalTools` already does. The
// worker process has its own `workspaceState` singleton (hydrated by
// {@link workerSideState.applyToolInit}) and its own per-worker
// `readFileState` — that is acceptable because:
//
//   1. `recordSuccessfulRead` is consumed by `tryConsumeReadDedup` on
//      the same process. Migrating both calls to the worker keeps the
//      dedup semantics coherent within a worker lifetime.
//   2. The main-process loop wraps tool execution with `runAgenticToolUseBody`
//      which serializes Read calls; the worker only sees one Read at a
//      time per agent.
//
// `import.meta` lazy loading isn't useful here — the worker is dedicated
// to tool execution and these modules are always wanted. Top-level
// imports (already at the file header) also keep stack traces clean
// for diagnostics.

registerExecutor('read_file', async (input) => {
  const { filePath, offset, limit, maxSizeBytes, maxTokens } = input as Record<string, unknown>
  return toolReadFile(String(filePath ?? ''), {
    offset: typeof offset === 'number' ? offset : undefined,
    limit: typeof limit === 'number' ? limit : undefined,
    maxSizeBytes: typeof maxSizeBytes === 'number' ? maxSizeBytes : undefined,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
  })
})

registerExecutor('glob', async (input) => {
  const { pattern, cwd, maxResults, includeDirs } = input as Record<string, unknown>
  return toolGlob(
    String(pattern ?? ''),
    typeof cwd === 'string' ? cwd : undefined,
    {
      maxResults: typeof maxResults === 'number' ? maxResults : undefined,
      includeDirs: typeof includeDirs === 'boolean' ? includeDirs : undefined,
    },
  )
})

registerExecutor('grep', async (input) => {
  const i = input as Record<string, unknown>
  return toolGrep(
    String(i.pattern ?? i.query ?? ''),
    typeof i.cwd === 'string'
      ? i.cwd
      : typeof i.path === 'string'
        ? i.path
        : undefined,
    {
      include: typeof i.include === 'string' ? i.include : undefined,
      exclude: typeof i.exclude === 'string' ? i.exclude : undefined,
      maxResults: typeof i.maxResults === 'number' ? i.maxResults : undefined,
      context: typeof i.context === 'number' ? i.context : undefined,
      caseInsensitive: i.caseInsensitive === true,
      outputMode:
        typeof i.outputMode === 'string'
          ? (i.outputMode as GrepOutputMode)
          : undefined,
      headLimit: typeof i.headLimit === 'number' ? i.headLimit : undefined,
      offset: typeof i.offset === 'number' ? i.offset : undefined,
      multiline: i.multiline === true,
      type: typeof i.type === 'string' ? i.type : undefined,
      lineNumbers: i.lineNumbers !== false,
    },
  )
})

registerExecutor('web_fetch', async (input) => {
  const { url, maxLength } = input as { url: string; maxLength?: number }
  const emit = getWorkerToolProgressEmitter()
  const onProgress = emit
    ? (note: string) =>
        emit({
          type: 'text',
          data: { text: `${note}\n` },
        })
    : undefined
  return toolWebFetch(String(url ?? ''), {
    maxLength: typeof maxLength === 'number' ? maxLength : undefined,
    onProgress,
  })
})

registerExecutor('WebSearch', async (input) => {
  const { query, maxResults, engine, freshness } = input as Record<string, unknown>
  return toolWebSearch(String(query ?? ''), {
    maxResults: typeof maxResults === 'number' ? maxResults : undefined,
    engine: typeof engine === 'string' ? (engine as WebSearchEngine) : undefined,
    freshness: typeof freshness === 'string' ? freshness : undefined,
  })
})

// ─── Phase 3: write-class tool executors ───
//
// `toolWriteFile` / `toolEditFile` / `toolMultiEditFile` are the same
// implementations the main-process tool wrapper uses. They internally
// rely on:
//
//   - `fileLock` (per-process mutex on write paths)
//   - `writeIntegrityGuard` (per-process receipt: was the post-write
//     re-read identical to what we just wrote?)
//   - `readFileState.baseReadId` (anchor check for `multi_edit_file`)
//
// All three are module singletons. In the worker process they get a
// **fresh** copy — coherent within the worker but NOT shared with the
// main process. That matches the same semantics already accepted by
// `subAgentWorker.ts`'s `registerLocalTools`: as long as **all writes
// to a given file** flow through the same process, locks and integrity
// receipts sequence them correctly.
//
// PreToolUse hooks / permission gates still run **in main** before
// dispatch reaches the worker (the agentic loop's
// `runAgenticToolUseBody` calls them around `toolRegistry.execute`),
// so this migration does not weaken policy enforcement.

registerExecutor('write_file', async (input) => {
  const { filePath, content, baseReadId } = input as {
    filePath?: string
    content: string
    baseReadId?: string
  }
  // baseReadId is forwarded so the missing-filePath fallback inside
  // `toolWriteFile` can recover the path from `findReadReceiptByReadId`
  // — mirrors the wiring in `registryBuiltinTools.ts` for the main-
  // process executor.
  const anchor =
    typeof baseReadId === 'string' && baseReadId.trim() ? baseReadId.trim() : undefined
  return toolWriteFile(String(filePath ?? ''), String(content ?? ''), {
    baseReadId: anchor,
  })
})

registerExecutor('edit_file', async (input) => {
  // The worker receives input AFTER `editFileInputZod.transform` (see
  // `registry.ts:134-141` — Zod runs in main BEFORE dispatch), so the
  // fields are already canonical: `baseReadId` is trimmed-or-undefined,
  // `expectedLineRange` is `[number, number]`, `hashAnchor` is the
  // structured `HashLineAnchor` object (NOT a `line:hash` string).
  // Mirrors the call site in `registryBuiltinTools.ts#edit_file` so the
  // worker path carries the same protocol fields as main.
  const i = input as {
    filePath: string
    oldString: string
    newString: string
    replaceAll?: boolean
    replace_all?: boolean
    baseReadId?: string
    expectedLineRange?: [number, number]
    hashAnchor?: {
      startLine: number
      startHash: string
      endLine?: number
      endHash?: string
    }
  }
  return toolEditFile(i.filePath, i.oldString, i.newString, {
    replaceAll: i.replaceAll === true || i.replace_all === true,
    baseReadId: i.baseReadId,
    expectedLineRange: i.expectedLineRange,
    hashAnchor: i.hashAnchor,
  })
})

registerExecutor('multi_edit_file', async (input) => {
  const { filePath, edits, baseReadId, base_read_id } = input as {
    filePath: string
    edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
    baseReadId?: string
    base_read_id?: string
  }
  const rawAnchor = baseReadId ?? base_read_id
  const anchor =
    typeof rawAnchor === 'string' && rawAnchor.trim() !== ''
      ? rawAnchor.trim()
      : undefined
  return toolMultiEditFile(String(filePath ?? ''), edits, { baseReadId: anchor })
})

// ─── Phase 4 (optional): shell executors ───
//
// Bash + PowerShell are **registered but not tagged** `runIn:'worker'`
// in `registryBuiltinTools.ts`. The capability exists for callers
// who explicitly want it, but the default routing stays on the main
// process for two reasons:
//
//   1. **Background tasks lose ShellTaskManager registration**. A
//      `runInBackground:true` bash invocation registers a long-lived
//      task in the worker's `ShellTaskManager` singleton — main's
//      TaskOutput tool consults main's singleton and would not see
//      the worker-side task. Fixing this requires a "PID handoff"
//      RPC frame, which the plan explicitly flags as the heavy
//      engineering item (`stdout stream IPC + PID 跨进程跟踪`).
//
//   2. **stdout streaming is buffered**. The current synchronous
//      RPC returns the full result at exit; that's fine for
//      foreground commands but degrades UX for `npm run dev` style
//      long jobs. A chunked `tool_stream` frame in the wire protocol
//      is the planned follow-up.
//
// Phase 4 intentionally ships the executors so future work just
// flips `runIn:'worker'` on the tools and adds the streaming /
// handoff frames — no architectural rework needed.

registerExecutor('bash', async (input, signal) => {
  void signal // current sandbox runner doesn't accept an AbortSignal
  const { command, cwd, runInBackground, timeoutMs } = input as Record<
    string,
    unknown
  >
  const cmd = String(command ?? '')
  const effectiveCwd =
    (typeof cwd === 'string' ? cwd.trim() : undefined) ||
    getWorkspacePath()?.trim() ||
    undefined
  const analysis = validateBashCommand(cmd, { defaultShell: 'bash', cwd: effectiveCwd })
  if (analysis.verdict === 'deny') {
    return {
      success: false,
      error:
        analysis.reasons.join('; ') ||
        `Command denied (${analysis.codes.join(', ') || 'policy'})`,
    }
  }
  const sand = await runSandboxedCommand(cmd, {
    cwd: effectiveCwd,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
    label: 'bash',
    runInBackground: runInBackground === true,
  })
  const { sandboxed: _s, violations: _v, ...rest } = sand
  void _s
  void _v
  // Mirror the main-process path: when the validator emitted warn-level
  // hints AND the runtime failed, append them so the agent isn't blind to
  // the likely cause. See `appendPreExecutionWarnings` for rationale.
  if (
    rest.success === false &&
    typeof rest.error === 'string' &&
    analysis.verdict === 'warn' &&
    analysis.reasons.length > 0
  ) {
    // Audit D4: same shape as the main-process path — structured
    // fields ride along with the warning bullets.
    const withWarnings = appendPreExecutionWarnings(
      {
        error: rest.error,
        errorWhat: rest.errorWhat ?? rest.error,
        errorTried: rest.errorTried,
        errorContext: rest.errorContext,
        errorNext: rest.errorNext,
        toolErrorClass: rest.toolErrorClass as ToolErrorClass | undefined,
      },
      analysis.reasons,
    )
    return { ...rest, ...withWarnings } as ToolResult
  }
  return rest as ToolResult
})

registerExecutor('PowerShell', async (input, signal) => {
  void signal
  const { command, cwd, runInBackground, timeoutMs } = input as Record<
    string,
    unknown
  >
  const cmd = String(command ?? '')
  const effectiveCwd =
    (typeof cwd === 'string' ? cwd.trim() : undefined) ||
    getWorkspacePath()?.trim() ||
    undefined
  const analysis = validatePowerShellCommand(cmd, { cwd: effectiveCwd })
  if (analysis.verdict === 'deny') {
    return {
      success: false,
      error: analysis.reasons.join('; ') || 'Command denied',
    }
  }
  const psResult = await runPowerShellCommand(cmd, effectiveCwd, {
    runInBackground: runInBackground === true,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  })
  if (
    psResult.success === false &&
    typeof psResult.error === 'string' &&
    analysis.verdict === 'warn' &&
    analysis.reasons.length > 0
  ) {
    const withWarnings = appendPreExecutionWarnings(
      {
        error: psResult.error,
        errorWhat: psResult.errorWhat ?? psResult.error,
        errorTried: psResult.errorTried,
        errorContext: psResult.errorContext,
        errorNext: psResult.errorNext,
        toolErrorClass: psResult.toolErrorClass as ToolErrorClass | undefined,
      },
      analysis.reasons,
    )
    return { ...psResult, ...withWarnings } as ToolResult
  }
  return psResult
})
