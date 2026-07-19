/**
 * Sub-agent worker — runs a sub-agent in an isolated `worker_threads` Worker
 * with local tool execution for file I/O and RPC delegation to the parent
 * for tools that need main-process state (Agent, TaskCreate, MCP, etc.).
 *
 * Lifecycle: ready → init → started → loop events → done/fail
 * Tool RPC:   tool_call → tool_result / tool_error
 */

import { parentPort } from 'node:worker_threads'
import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoopAsync,
} from '../orchestration/hostedAgentLoop'
import type { AgenticLoopResult } from '../ai/loopEvents'
import type { AgenticLoopCallbacks, AgenticLoopParams } from '../ai/agenticLoopTypes'
import type { ProviderConfig } from '../ai/client'
import { getAgentContext, runWithAgentContextAsync } from './agentContext'
import {
  READONLY_AGENT_TYPES,
  computeReadonlyWindDownDirective,
  shouldInjectIterationWindDown,
  buildIterationWindDownDirective,
} from './subAgentReadonlyBudget'
import { MAX_ITERATIONS } from '../constants/toolLimits'
import { asAgentId } from '../tools/ids'
import { parseParentMessage, type ParentMessage, type SessionInit } from '../bridge/sessionMessages'
import { RemoteAgentLoopHostController } from '../bridge/remoteHostProtocol'
import { ToolRegistry } from '../tools/registry'
import type { Tool, ToolResult } from '../tools/types'
// Sub-agent local tool execution. Each `execute` below forwards into
// the shared executor registry at `electron/tools/workerProcess/executors.ts`
// (phase 5 cleanup) so the per-tool input destructuring lives in one
// place. The sub-agent worker still runs everything inside its own
// `worker_threads` — the executor functions ARE pure forwards to the
// underlying tool functions, with no IPC or utilityProcess hop.
import { toolListFiles } from '../ai/tools'
import { getExecutor } from '../tools/workerProcess/executors'
import {
  readFileInputZod, writeFileInputZod, editFileInputZod, multiEditFileInputZod,
  listFilesInputZod, globInputZod, grepInputZod,
  webFetchInputZod, webSearchInputZod,
} from '../tools/toolInputZod'
import { validateEditToolPayload, validateMultiEditToolPayload } from '../utils/settings/validateEditTool'
import { setWorkspacePath } from '../tools/workspaceState'
import { buildRegistryTool } from '../tools/buildRegistryTool'
import { registryPrimaryToolName } from '../tools/builtinToolAliases'
import { setToolWorkerDiskSettingsOverride } from '../settings/settingsAccess'
import { WEB_SEARCH_MAX_RESULT_CHARS } from '../ai/toolWebSearch'
import { isSessionMemoryInternalAgentType } from './sessionMemorySandboxInvariant'
import { mergeAbortSignals } from '../ai/toolExecutionScope'

if (!parentPort) throw new Error('[subAgentWorker] must be loaded as a worker_thread')
const port = parentPort

// ─── State ───

let abortController: AbortController | null = null
let liveConfig: ProviderConfig | null = null
let currentSessionId: string | null = null
/**
 * SA-3 fix 4(b) — child agent type from {@link SessionInit.sessionAgentType}.
 * Consulted by {@link execLocal} to refuse local execution for the
 * sandboxed `session-memory-internal` scribe (its tool gate only exists
 * in the main process).
 */
let sessionAgentType: string | null = null
const workerToolRegistry = new ToolRegistry()
// Scheduler-drive (POLE_TOOL_SCHEDULER_DRIVE) captured from SessionInit. When
// true, LOCAL in-thread tools request accounting-only admission from main
// before executing so they participate in cross-agent holding + visibility.

// ─── RPC plumbing ───

let reqSeq = 0
const pendingRpc = new Map<number, { resolve: (v: ToolResult) => void; reject: (e: Error) => void }>()
// Local-tool admission decision returned by main (`admit_grant`/`admit_deny`).
type AdmitDecision = { ok: boolean; reason?: string }
// Pending local-tool admission requests, resolved when main replies.
const pendingAdmit = new Map<number, (d: AdmitDecision) => void>()
const localAdmissionControllers = new Map<number, AbortController>()

port.on('message', (raw: unknown) => {
  const msg = raw as Record<string, unknown>
  const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
  if (msg.kind === 'tool_result') {
    const p = pendingRpc.get(reqId)
    if (p) { pendingRpc.delete(reqId); p.resolve(msg.result as ToolResult) }
  } else if (msg.kind === 'tool_error') {
    const p = pendingRpc.get(reqId)
    if (p) { pendingRpc.delete(reqId); p.reject(new Error(String(msg.error))) }
  } else if (msg.kind === 'admit_grant') {
    const r = pendingAdmit.get(reqId)
    if (r) { pendingAdmit.delete(reqId); r({ ok: true }) }
  } else if (msg.kind === 'admit_deny') {
    const r = pendingAdmit.get(reqId)
    if (r) {
      pendingAdmit.delete(reqId)
      r({ ok: false, reason: typeof msg.reason === 'string' ? msg.reason : undefined })
    }
  } else if (msg.kind === 'admit_abort') {
    const controller = localAdmissionControllers.get(reqId)
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(typeof msg.reason === 'string' ? msg.reason : 'tool preempted'))
    }
  } else {
    handleControlMessage(raw)
  }
})

function rpcToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
  const reqId = ++reqSeq
  return new Promise<ToolResult>((resolve, reject) => {
    pendingRpc.set(reqId, { resolve, reject })
    port.postMessage({ kind: 'tool_call', reqId, toolName, toolInput: input })
  })
}

/**
 * Request accounting-only scheduler admission from main for a LOCAL in-thread
 * tool. Resolves on `admit_grant` (main has registered + held + marked the
 * tool running). Hold-only scope never denies, so this always eventually
 * resolves. Defensive: if main never replies (it always does), the worker's
 * own abort signal still terminates the surrounding loop.
 */
function admitLocalToolRpc(
  reqId: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  isReadOnly: boolean,
): Promise<AdmitDecision> {
  return new Promise<AdmitDecision>((resolve) => {
    pendingAdmit.set(reqId, resolve)
    port.postMessage({ kind: 'admit_request', reqId, toolName, toolInput, isReadOnly })
  })
}

/** Report local-tool completion so main marks the admission slot terminal. */
function postAdmitDone(reqId: number, success: boolean): void {
  port.postMessage({ kind: 'admit_done', reqId, success })
}

// ─── Tool classification ───

const LOCAL_TOOL_NAMES = new Set([
  'read_file', 'Read', 'write_file', 'Write', 'edit_file', 'Edit',
  'multi_edit_file', 'MultiEdit',
  'list_files', 'Glob', 'grep', 'Grep', 'WebFetch', 'WebSearch',
  'web_fetch', 'web_search', 'ToolSearch',
])

function isLocalTool(name: string): boolean {
  const primary = registryPrimaryToolName(name)
  return LOCAL_TOOL_NAMES.has(primary) || LOCAL_TOOL_NAMES.has(name)
}

// ─── Register local tools ───

/**
 * Sub-agent local tool registration.
 *
 * Phase 5 cleanup: each `execute` body forwards to the shared
 * `electron/tools/workerProcess/executors.ts` registry instead of
 * duplicating the input destructuring + tool function call. Tool
 * metadata (name, inputSchema, zInputSchema, validateInput) stays
 * here because it is sub-agent-specific (the main-process registry
 * has its own canonical definitions with longer model-facing
 * descriptions).
 */
function execLocal(name: string): (input: Record<string, unknown>) => Promise<ToolResult> {
  return async (input) => {
    // SA-3 fix 4(b) — sandbox invariant: the session-memory-internal
    // scribe's tool gate (`gateSessionMemoryInternalAgentToolUse`) only
    // runs in the MAIN process. Local execution inside this worker would
    // bypass it entirely, so refuse outright; only the RPC route back to
    // main (which runs the full gate) is acceptable for that agent.
    if (isSessionMemoryInternalAgentType(sessionAgentType)) {
      return {
        success: false,
        error:
          `[subAgentWorker] local execution of '${name}' is forbidden for ` +
          `session-memory-internal (sandbox gate only exists in the main process)`,
      }
    }
    const fn = getExecutor(name)
    if (!fn) {
      return { success: false, error: `[subAgentWorker] no executor for '${name}'` }
    }
    // SA-3 fix 1 — propagate the session-level abort signal so a parent
    // abort cancels in-flight local tools (bash, web fetch, …) instead of
    // letting them run to completion while only the NEXT loop iteration
    // observes the abort. Falls back to a dummy signal only when no
    // session is active (defensive; execLocal is only reachable mid-session).
    const sig = abortController?.signal ?? new AbortController().signal

    // Scheduler-drive: request accounting-only admission from main BEFORE
    // executing locally so this in-thread tool participates in cross-agent
    // holding + visibility, then report completion. Off → run directly.
    {
      const reqId = ++reqSeq
      const isReadOnly = workerToolRegistry.get(name)?.isReadOnly ?? false
      const preemptController = new AbortController()
      localAdmissionControllers.set(reqId, preemptController)
      const adm = await admitLocalToolRpc(reqId, name, input, isReadOnly)
      if (!adm.ok) {
        // Quota-denied by main (which already marked the slot terminal — do
        // NOT post admit_done). Return a model-visible error without executing.
        localAdmissionControllers.delete(reqId)
        return { success: false, error: adm.reason ?? 'denied by scheduler quota' }
      }
      try {
        const r = await fn(input, mergeAbortSignals(sig, preemptController.signal))
        postAdmitDone(reqId, !(r && (r as ToolResult).error))
        return r
      } catch (e) {
        postAdmitDone(reqId, false)
        throw e
      } finally {
        localAdmissionControllers.delete(reqId)
      }
    }
  }
}

function registerLocalTools(): void {
  const registry = workerToolRegistry

  registry.register(buildRegistryTool({
    name: 'read_file', inputSchema: [
      { name: 'filePath', type: 'string', description: '', required: true },
      { name: 'offset', type: 'number', description: '' },
      { name: 'limit', type: 'number', description: '' },
      { name: 'maxSizeBytes', type: 'number', description: '' },
      { name: 'maxTokens', type: 'number', description: '' },
    ],
    description: 'Read a file from disk.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: readFileInputZod, maxResultChars: 2_000_000,
    execute: execLocal('read_file'),
  }))

  registry.register(buildRegistryTool({
    name: 'write_file', inputSchema: [
      { name: 'filePath', type: 'string', description: '', required: true },
      { name: 'content', type: 'string', description: '', required: true },
    ],
    description: 'Write content to a file.', isReadOnly: false, isConcurrencySafe: false,
    zInputSchema: writeFileInputZod, maxResultChars: 100_000,
    execute: execLocal('write_file'),
  }))

  registry.register(buildRegistryTool({
    name: 'edit_file', inputSchema: [
      { name: 'filePath', type: 'string', description: '', required: true },
      { name: 'oldString', type: 'string', description: '', required: true },
      { name: 'newString', type: 'string', description: '', required: true },
      { name: 'replaceAll', type: 'boolean', description: '' },
      { name: 'replace_all', type: 'boolean', description: '' },
    ],
    description: 'Edit a file in place.', isReadOnly: false, isConcurrencySafe: false,
    zInputSchema: editFileInputZod, maxResultChars: 100_000,
    validateInput: async (input) => { const v = validateEditToolPayload(input); return v.ok ? { valid: true } : { valid: false, message: v.message } },
    execute: execLocal('edit_file'),
  }))

  registry.register(buildRegistryTool({
    name: 'multi_edit_file', inputSchema: [
      { name: 'filePath', type: 'string', description: '', required: true },
      {
        name: 'edits', type: 'array', description: '', required: true,
        items: {
          type: 'object',
          properties: {
            oldString: { type: 'string', description: '' },
            newString: { type: 'string', description: '' },
            replaceAll: { type: 'boolean', description: '' },
          },
          required: ['oldString', 'newString'],
        },
      },
      { name: 'baseReadId', type: 'string', description: '' },
      { name: 'base_read_id', type: 'string', description: '' },
    ],
    description: 'Apply a batch of substring edits to a single existing file atomically.',
    isReadOnly: false, isConcurrencySafe: false,
    zInputSchema: multiEditFileInputZod, maxResultChars: 100_000,
    validateInput: async (input) => {
      const v = validateMultiEditToolPayload(input)
      return v.ok ? { valid: true } : { valid: false, message: v.message }
    },
    execute: execLocal('multi_edit_file'),
  }))

  // list_files is the one tool not migrated to the shared executors
  // registry (it has no main-process state to migrate around and the
  // implementation is a 1-liner). Keeping it inline avoids an extra
  // executor registration for marginal gain.
  registry.register(buildRegistryTool({
    name: 'list_files', inputSchema: [
      { name: 'dirPath', type: 'string', description: '', required: true },
    ],
    description: 'List directory contents.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: listFilesInputZod,
    execute: async (input, _ctx) => toolListFiles(String((input as Record<string, unknown>).dirPath ?? '')),
  }))

  registry.register(buildRegistryTool({
    name: 'Glob', inputSchema: [
      { name: 'pattern', type: 'string', description: '', required: true },
      { name: 'cwd', type: 'string', description: '' },
      { name: 'maxResults', type: 'number', description: '' },
      { name: 'includeDirs', type: 'boolean', description: '' },
    ],
    description: 'Find files by glob pattern.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: globInputZod, maxResultChars: 100_000,
    execute: execLocal('glob'),
  }))

  registry.register(buildRegistryTool({
    name: 'Grep', inputSchema: [
      { name: 'pattern', type: 'string', description: '', required: true },
      { name: 'query', type: 'string', description: '' },
      { name: 'cwd', type: 'string', description: '' },
      { name: 'path', type: 'string', description: '' },
      { name: 'include', type: 'string', description: '' },
      { name: 'exclude', type: 'string', description: '' },
      { name: 'maxResults', type: 'number', description: '' },
      { name: 'context', type: 'number', description: '' },
      { name: 'caseInsensitive', type: 'boolean', description: '' },
      { name: 'outputMode', type: 'string', description: '' },
      { name: 'headLimit', type: 'number', description: '' },
      { name: 'offset', type: 'number', description: '' },
      { name: 'multiline', type: 'boolean', description: '' },
      { name: 'type', type: 'string', description: '' },
      { name: 'lineNumbers', type: 'boolean', description: '' },
    ],
    description: 'Search file contents with regex.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: grepInputZod, maxResultChars: 20_000,
    execute: execLocal('grep'),
  }))

  registry.register(buildRegistryTool({
    name: 'WebFetch', inputSchema: [
      { name: 'url', type: 'string', description: '', required: true },
      { name: 'maxLength', type: 'number', description: '' },
    ],
    description: 'Fetch a URL and return body as text.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: webFetchInputZod, maxResultChars: 50_000,
    execute: execLocal('web_fetch'),
  }))

  registry.register(buildRegistryTool({
    name: 'WebSearch', inputSchema: [
      { name: 'query', type: 'string', description: '', required: true },
      { name: 'maxResults', type: 'number', description: '' },
      { name: 'engine', type: 'string', description: '' },
      { name: 'freshness', type: 'string', description: '' },
    ],
    description: 'Search the public web.', isReadOnly: true, isConcurrencySafe: true,
    zInputSchema: webSearchInputZod, maxResultChars: WEB_SEARCH_MAX_RESULT_CHARS,
    execute: execLocal('WebSearch'),
  }))

  registry.register(buildRegistryTool({
    name: 'bash', inputSchema: [
      { name: 'command', type: 'string', description: '', required: true },
      { name: 'cwd', type: 'string', description: '' },
      { name: 'runInBackground', type: 'boolean', description: '' },
      { name: 'timeoutMs', type: 'number', description: '' },
    ],
    description: 'Execute a shell command.', isReadOnly: false,
    // bash has no Zod schema — runtime validation lives inside the
    // executor (`validateBashCommand`).
    execute: execLocal('bash'),
  }))

  registry.register(buildRegistryTool({
    name: 'PowerShell', inputSchema: [
      { name: 'command', type: 'string', description: '', required: true },
      { name: 'cwd', type: 'string', description: '' },
      { name: 'runInBackground', type: 'boolean', description: '' },
      { name: 'timeoutMs', type: 'number', description: '' },
    ],
    description: 'Execute a PowerShell command.', isReadOnly: false,
    isEnabled: () => process.platform === 'win32',
    execute: execLocal('PowerShell'),
  }))
}

// ─── Register RPC proxy tools from parent definitions ───

function registerRpcTools(toolDefs: Array<{ name: string; description: string; inputSchema: unknown }>): void {
  for (const def of toolDefs) {
    if (isLocalTool(def.name)) continue
    workerToolRegistry.register({
      name: def.name,
      description: def.description,
      inputSchema: (def.inputSchema as Tool['inputSchema']) ?? [],
      isReadOnly: false,
      isConcurrencySafe: false,
      maxResultChars: 50_000,
      execute: async (input: Record<string, unknown>, _ctx) => rpcToolCall(def.name, input),
    })
  }
}

// ─── Lifecycle ───

function send(msg: Record<string, unknown>): void {
  try { port.postMessage(msg) } catch { /* noop */ }
}

const remoteHost = new RemoteAgentLoopHostController((message) => send(message))

/**
 * T1 — build the worker-side graceful wind-down fan-out.
 *
 * Self-contained budget tracker (tool calls + tokens + iteration) mirroring
 * the in-process `subAgentLoopCallbacks` thresholds via the SHARED
 * `computeReadonlyWindDownDirective` (read-only agents only) and
 * `buildIterationWindDownDirective` (every agent, near `maxIterations`). On
 * crossing a soft line it returns the wind-down directive from
 * `onQueryLoopPreModel` so the loop core (`iteration.ts`) appends a forced
 * tool-free report turn — the agent then finishes cleanly (`completed`) and
 * the host reports `success: true` instead of a hard-aborted, truncated run.
 *
 * Token usage is tracked from `onMessageEnd` (per-turn `usage`), the only
 * usage signal the event-emitting bridge fans out; `onStreamUsage` is not
 * forwarded on the generator path. Required callbacks
 * (`onTextDelta`/`onToolResult`/`onError`) are no-ops — the worker's own
 * `LoopEvent` stream already drives the host.
 */
function buildReadonlyWindDownFanOut(
  agentType: string | null,
  maxIterationsOverride: number | undefined,
  onWindDown: (info: {
    trigger: 'tools' | 'tokens' | 'iterations'
    iteration?: number
    maxIterations?: number
  }) => void,
): AgenticLoopCallbacks | undefined {
  const isReadonly = !!agentType && READONLY_AGENT_TYPES.has(agentType)
  // Effective iteration cap: the forwarded override, or the loop default when
  // unset (mirrors `setup.ts:maxIterations = override || MAX_ITERATIONS`).
  const maxIterations = maxIterationsOverride ?? MAX_ITERATIONS
  let injected = false
  let toolUses = 0
  let latestInputTokens = 0
  let outputTokTotal = 0
  // Mirror the in-process accounting (`subAgentLoopCallbacks.recordUsageForBudgets`):
  // per-turn tokens arrive via `onStreamUsage` (fires every stream pass). The
  // loop-level `onMessageEnd` only fires ONCE at termination — too late for a
  // mid-run token-pressure wind-down — so it is only a fallback for provider
  // paths that emit no per-stream usage. `sawStreamUsage` prevents
  // double-counting the same turn from both signals.
  let sawStreamUsage = false
  const recordUsage = (usage: { inputTokens: number; outputTokens: number }): void => {
    latestInputTokens = Math.max(latestInputTokens, Math.max(0, usage.inputTokens))
    outputTokTotal += Math.max(0, usage.outputTokens)
  }
  return {
    onTextDelta: () => {},
    onToolStart: () => {
      toolUses++
    },
    onToolResult: () => {},
    onStreamUsage: (usage) => {
      sawStreamUsage = true
      recordUsage(usage)
    },
    onMessageEnd: (usage) => {
      if (usage && !sawStreamUsage) recordUsage(usage)
    },
    onError: () => {},
    onQueryLoopPreModel: (info) => {
      if (injected) return
      // Read-only tool/token pressure first (only for read-only agents), then
      // the generic iteration-limit wind-down that applies to EVERY agent.
      const directive =
        (isReadonly && agentType
          ? computeReadonlyWindDownDirective({
              agentType,
              totalToolUses: toolUses,
              effectiveTokens: latestInputTokens + outputTokTotal,
            })
          : undefined) ??
        (shouldInjectIterationWindDown({ iteration: info.iteration, maxIterations })
          ? buildIterationWindDownDirective({ iteration: info.iteration, maxIterations })
          : undefined)
      if (!directive) return
      injected = true
      onWindDown({
        trigger: directive.trigger,
        ...(directive.trigger === 'iterations'
          ? { iteration: info.iteration, maxIterations }
          : {}),
      })
      return {
        appendUserContent: directive.appendUserContent,
        disableToolsForThisTurn: directive.disableToolsForThisTurn,
      }
    },
  }
}

async function startSession(init: SessionInit): Promise<void> {
  if (currentSessionId) {
    // Duplicate `init` for the SAME session is a benign client-side race
    // (pool slow-path: eager init + late `ready` re-init — see
    // `subAgentWorkerClient.ts` `initPosted`). Ignore it silently instead
    // of failing, which would tear down the healthy in-flight session.
    if (currentSessionId === init.sessionId) return
    send({ kind: 'fail', error: 'session already running' })
    return
  }
  currentSessionId = init.sessionId
  abortController = new AbortController()
  // SA-3 fix 4(b) — record the child agent type BEFORE tools register so
  // the `execLocal` sandbox check observes it from the very first call.
  sessionAgentType = init.sessionAgentType?.trim() || null
  // Scheduler-drive flag (threaded via init, not env inheritance) gates the
  // local-tool admission RPC inside `execLocal`.

  liveConfig = { ...init.params.config, apiKey: init.accessToken ?? init.params.config.apiKey } as ProviderConfig

  // Propagate workspace path so worker-side file tools can resolve paths correctly.
  // Without this, getWorkspacePath() returns null and all read/write/list tools fail.
  setWorkspacePath(init.workspacePath ?? null)

  // Mirror main-process disk settings into this worker's V8 context so
  // `readDiskSettings()` (consumed by webSearchSettings, memoryFeatureFlags,
  // recallTuning, disabledServers, plugin/workspaceTrust policy, etc.)
  // returns the same shape as the main process. Without this, every
  // worker_threads sub-agent run sees `{}` for settings and downstream
  // tool helpers (e.g. Brave API key lookup) silently fail. Sub-agent
  // workers are one-shot, so a single snapshot at init time is enough —
  // see `bridge/sessionMessages.ts:SessionInitSchema.diskSettingsSnapshot`
  // for the wire-level rationale.
  setToolWorkerDiskSettingsOverride(init.diskSettingsSnapshot ?? null)

  // Register tools
  registerLocalTools()
  if (init.toolDefinitions) registerRpcTools(init.toolDefinitions)

  const params: AgenticLoopParams = {
    config: liveConfig,
    model: init.params.model,
    messages: init.params.messages as AgenticLoopParams['messages'],
    systemPrompt: init.params.systemPrompt,
    maxTokens: init.params.maxTokens,
    maxIterationsOverride: init.params.maxIterationsOverride,
    enableTools: init.params.enableTools ?? false,
    alwaysThinking: init.params.alwaysThinking,
    signal: abortController.signal,
    permissionDefaultMode: init.params.permissionDefaultMode,
    permissionRules: init.params.permissionRules,
  }

  send({ kind: 'started', sessionId: init.sessionId })

  // P1-2 (audit Bug-7 fix) — wrap the loop in `runWithAgentContextAsync` so
  // `getAgentContext()?.priority` returns the parent-supplied priority
  // inside this worker's V8 isolate. Without this wrap, every worker-bound
  // sub-agent's tool batches register in `ToolRuntimeState` under the
  // 'main' agentId fallback at HIGH priority — defeating the whole point
  // of declaring `defaultPriority: BACKGROUND` on session-memory-internal /
  // dream / future background agents.
  //
  // P1-2 (audit Bug-7 follow-up B7-B) — `agentId` MUST be the externally-
  // registered id from `init.agentId`, NOT `init.sessionId` (which is an
  // internal `sub-<timestamp>` string that doesn't match
  // `activeAgentRegistry`). Cross-cutting subsystems (quota preemption,
  // history lineage, scheduler.cancelAgent) key off the real id.
  // Falls back to `sessionId` for legacy test callers that don't supply
  // agentId — see SessionInitSchema doc.
  const workerAgentContext = {
    config: liveConfig,
    model: init.params.model,
    systemPrompt: init.params.systemPrompt ?? '',
    messages: params.messages as Array<Record<string, unknown>>,
    signal: abortController.signal,
    agentId: asAgentId(init.agentId?.trim() || init.sessionId),
    ...(init.parentAgentId?.trim()
      ? { parentAgentId: init.parentAgentId.trim() }
      : {}),
    ...(typeof init.priority === 'number' ? { priority: init.priority } : {}),
  }

  let result: AgenticLoopResult | null = null
  // Live loop transcript, captured INSIDE the ALS scope (where
  // `getAgentContext()` is populated) so the host can run the final-summary
  // rescue on budget-abort / max-iterations. `syncAgentContextConversation`
  // (orchestration/phases/iteration.ts) refreshes this every iteration, so at
  // capture time it holds the full assistant + tool_result transcript.
  let finalApiMessages: Array<Record<string, unknown>> | undefined

  // T1 — worker-path graceful wind-down. Two triggers, mirroring the
  // in-process `subAgentLoopCallbacks` path:
  //   - read-only budget (Explore / Plan / Verification): tool-call / token
  //     pressure at the 85% soft line.
  //   - iteration-limit (EVERY agent type): approaching `maxIterations`.
  // On either trigger it returns the wind-down directive from
  // `onQueryLoopPreModel` (a forced tool-free report turn). The agent then
  // finishes a clean tool-free turn → loop terminates `completed` → host
  // reports `success: true`, instead of a hard-aborted / max-turns truncated
  // run. The `sendBudgetAbort` ceiling + final-summary rescue remain the
  // backstop for the rare single-turn overshoot.
  const windDownFanOut = buildReadonlyWindDownFanOut(
    sessionAgentType,
    init.params.maxIterationsOverride,
    (info) => send({ kind: 'winddown', ...info }),
  )

  try {
    result = await runWithAgentContextAsync(workerAgentContext, async () => {
      try {
        const host = createInMemoryAgentLoopHost(params, {
          ...(init.initialTranscriptSnapshot
            ? { initialSnapshot: init.initialTranscriptSnapshot }
            : {}),
          onTranscriptCommit: (snapshot) => remoteHost.onTranscriptCommit(snapshot),
          iterationBoundary: (iteration) => remoteHost.iterationBoundary(iteration),
        })
        const gen = runHostedAgentLoopAsync(
          host,
          params,
          windDownFanOut,
        )
        while (true) {
          const r = await gen.next()
          if (r.done) {
            await remoteHost.awaitLatestAck()
            return r.value as AgenticLoopResult
          }
          send({ kind: 'event', event: r.value })
        }
      } finally {
        const ctxMsgs = getAgentContext()?.messages
        if (Array.isArray(ctxMsgs) && ctxMsgs.length > 0) {
          finalApiMessages = ctxMsgs as Array<Record<string, unknown>>
        }
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({
      kind: 'fail',
      error: message,
      ...(finalApiMessages ? { finalApiMessages } : {}),
    })
    return
  } finally {
    abortController = null
  }

  if (result) {
    send({ kind: 'done', result, ...(finalApiMessages ? { finalApiMessages } : {}) })
  } else {
    send({
      kind: 'fail',
      error: 'loop returned no result',
      ...(finalApiMessages ? { finalApiMessages } : {}),
    })
  }
}

function handleControlMessage(raw: unknown): void {
  const parsed = parseParentMessage(raw)
  if (!parsed.ok) return
  const msg = parsed.value as ParentMessage
  switch (msg.kind) {
    case 'init':
      void startSession(msg.payload as Parameters<typeof startSession>[0])
      break
    case 'abort':
      if (abortController) abortController.abort()
      break
    case 'update_token':
      if (liveConfig) liveConfig.apiKey = msg.token
      break
    case 'pause':
    case 'resume':
    case 'transcript_ack':
      remoteHost.handleParentMessage(msg)
      break
  }
}

// Signal ready
send({ kind: 'ready' })
