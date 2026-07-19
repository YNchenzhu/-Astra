/**
 * Tool type system — unified interface for all AI-callable tools.
 * The agentic loop discovers tools via the registry, sends their schemas
 * to the API, and invokes them by name when the model requests a tool call.
 */

import type { ZodTypeAny } from 'zod'
import type { ToolUseContext } from './toolExecContext'

export type { ToolUseContext, ToolProgressEvent, ToolPermissionMode, ToolPermissionDefault } from './toolExecContext'

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  default?: unknown
  enum?: string[]
  /** JSON-Schema fragment for `array` element types (may include nested properties/required). */
  items?: Record<string, unknown>
  /** JSON-Schema fragment for `object` property definitions (may include nested properties/required). */
  properties?: Record<string, unknown>
}

export interface Tool {
  /** Unique tool name, e.g. "read_file", "glob" */
  name: string

  /** Human-readable description shown to the AI model */
  description: string

  /** JSON Schema for the tool's input parameters */
  inputSchema: ToolParameter[]

  /**
   * Optional Zod schema for API/tool_use input (upstream `inputSchema.safeParse`).
   * When set, validated in {@link runAgenticToolUse} before hooks/execute.
   */
  zInputSchema?: ZodTypeAny

  /** Whether this tool only reads data (safe to run in parallel) */
  isReadOnly: boolean

  /**
   * Extra keywords for {@link ToolSearchTool} (name/description may not contain natural phrases
   * like "Explore agent" as a single substring).
   */
  searchHint?: string

  /**
   * Validate input before execution. Returns { valid, message? }.
   * Defaults to a no-op validator that always returns { valid: true }.
   */
  validateInput?: (input: Record<string, unknown>) => Promise<{ valid: boolean; message?: string }>

  /**
   * Optional per-tool permission gate (upstream `checkPermissions` analogue — report §4.1).
   * Runs after Zod + {@link validateInput}, before session permission rules / UI.
   */
  checkPermissions?: (
    input: Record<string, unknown>,
  ) => Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string }

  /**
   * Extra model-facing text appended to {@link description} in API tool listings only
   * (upstream separate `prompt()` / extended guidance analogue — report §4.1).
   */
  modelDescriptionExtension?: string

  /** Alternate names the LLM may use to call this tool (resolved at dispatch). */
  aliases?: string[]

  /** Runtime toggle: return false to exclude this tool from the current session. */
  isEnabled?: () => boolean

  /**
   * upstream-style parallel safety. Omitted = fail-closed (not parallel).
   * Use `(input) => boolean` when safety depends on arguments (e.g. Bash).
   */
  isConcurrencySafe?: boolean | ((input: Record<string, unknown>) => boolean)

  /** Whether this tool performs destructive mutations (delete, overwrite, etc.). */
  isDestructive?: boolean

  /**
   * Whether this tool consumes the shared *network* resource lane (outbound
   * HTTP / remote server calls). Used by the orchestration `ResourceQuotaManager`
   * to throttle concurrent network requests (`maxGlobalNetworkRequests`) and to
   * pick preemption victims on the `network` lane.
   *
   * Prefer this explicit, registry-driven flag over name heuristics. Set `true`
   * on web tools (`web_fetch`, `WebSearch`) and on MCP bridge tools (external
   * server calls). A genuinely local-compute MCP tool can declare
   * `networkBound: false` to opt out of network throttling.
   *
   * When undefined the quota manager falls back to a name heuristic for the
   * well-known web tools only.
   */
  networkBound?: boolean

  /**
   * upstream Phase 4 — interrupt behavior when user submits new input during tool execution.
   *
   *   - `'cancel'` (default at the orchestrator level): tool aborts on `kernel.interrupt('user')`,
   *     new input is processed immediately. Suitable for fast, idempotent, or restart-cheap tools.
   *   - `'block'`: tool keeps running through a soft user interrupt and only aborts on
   *     `kernel.interrupt(..., { hard: true })`, the auto-grace promotion (default 30s), or
   *     process shutdown. Suitable for long-running work where restart cost >> wait cost
   *     (rsync, DB migration, remote polling, large bash commands with explicit long timeout).
   *
   * The function form receives the tool's `input` so heuristics can pick per-invocation
   * (e.g. bash decides based on `timeoutMs`). The zero-arg form is supported for back-compat.
   *
   * When undefined the orchestrator treats the tool as `'cancel'`.
   */
  interruptBehavior?:
    | 'cancel'
    | 'block'
    | (() => 'cancel' | 'block')
    | ((input: Record<string, unknown>) => 'cancel' | 'block')

  /** Whether this tool should be deferred (loaded lazily). */
  shouldDefer?: boolean

  /**
   * When `shouldDefer` is true: if set, tool is exposed when this returns true;
   * otherwise falls back to ToolSearch discovery ({@link isToolVisibleInPrompt}).
   */
  deferUntil?: () => boolean

  /** Whether this tool should always be loaded regardless of filtering. */
  alwaysLoad?: boolean

  /**
   * Execute the tool with the given input.
   * Input keys match the `name` fields in `inputSchema`.
   *
   * The optional `ctx` (added in upstream alignment stage 1) carries
   * per-execution metadata: abort signal, agent identity, permission mode,
   * progress emitter. Tools written before the alignment work ignore it
   * and remain functionally correct — only tools that need per-call
   * state (e.g. honoring abort mid-stream, emitting progress events)
   * should read from it. See {@link ToolUseContext}.
   */
  execute: (input: Record<string, unknown>, ctx?: ToolUseContext) => Promise<ToolResult>

  /**
   * upstream-style per-tool cap before spill ({@link applyToolResultSizeBudget}).
   * Omitted → pipeline default (see `toolResultBudget.ts`).
   */
  maxResultChars?: number

  /**
   * P2.2 — Optional unified retry policy. When set, the tool runtime SHOULD wrap
   * {@link execute} with `withRetry(policy)` (see `electron/orchestration/retryPolicy.ts`).
   *
   * Default behaviour is `undefined` → no retry (preserves the pre-P2.2 single-attempt
   * semantics). The opt-in is intentional: most tools either succeed quickly or fail with
   * a user-visible error the agent should reason about, not silently retry.
   *
   * Tools that already implement their own retry (e.g. MCP shells with bespoke 5xx logic)
   * should leave this `undefined` to keep their behaviour intact and migrate over time.
   */
  retryPolicy?: import('../orchestration/retryPolicy').RetryPolicy

  /**
   * When true, API `input_schema` uses `additionalProperties: true`
   * (upstream MCPTool `z.object({}).passthrough()` analogue; see `electron/tools/schema.ts`).
   */
  openEndedJsonSchema?: boolean

  /** Registered from an MCP server list_tools row (telemetry / policy hooks). */
  isMcpBridge?: boolean

  /**
   * Execution location. When omitted (default) or `'main'`, the tool's
   * `execute()` runs in the Electron main process — the canonical home
   * for `hooks` / `PermissionManager` / `readFileState`. Per-process
   * concurrency primitives (`fileLock`, `writeIntegrityGuard`) ALSO exist
   * in the worker as independent copies — see `executors.ts` header — so
   * write-path tools tagged `'worker'` get their own isolated locks
   * rather than sharing the main-process ones. That isolation is
   * intentional (the worker is a separate `utilityProcess`).
   *
   * When `'worker'`, {@link ToolRegistry.execute} routes the call
   * through {@link toolWorkerHost.dispatch}, which forwards `(name,
   * input, ctx)` to the isolated `utilityProcess`. The result is the
   * same shape as a main-process execution; structured errors surface
   * as `{ success: false, error, toolErrorClass }` on worker crash.
   *
   * Phase 1 of the migration only ships the host + a `ping` echo tool;
   * production tools are migrated incrementally (phases 2-4).
   */
  runIn?: 'main' | 'worker'

  /**
   * Anthropic **Tool Use Examples** (beta `tool-examples-2025-10-29`).
   *
   * Each entry is a valid invocation of this tool that exemplifies a recommended
   * usage pattern. On the `anthropic` wire (+ supported model) the pipeline
   * emits them verbatim as `input_examples` in the tool definition; on every
   * other wire they are rendered into a compact `### Examples` section and
   * appended to the tool description, so the accuracy bump still applies.
   *
   * Constraints (enforced by the sanitizer):
   *   - at most 20 entries per tool
   *   - each entry must structurally match {@link inputSchema}
   *   - only allowed on user-defined tools (not server-side tools)
   *
   * See Anthropic "Advanced tool use" (2025-11-24) — internal tests show
   * parameter accuracy improving from 72% → 90% on complex schemas.
   */
  examples?: ReadonlyArray<Record<string, unknown>>

  /**
   * Anthropic **Programmatic Tool Calling** (PTC) opt-in.
   *
   * When set, the schema builder advertises this tool via `allowed_callers`
   * in the Anthropic wire format, so Claude can invoke it from inside the
   * `code_execution_20260120` sandbox (via generated Python) instead of a
   * round-trip through the model.
   *
   *   - `'direct'`         — only Claude calls directly (default; equivalent to omitting)
   *   - `'code_execution'` — only callable from inside PTC (Python only)
   *   - `'both'`           — callable both ways
   *
   * The PTC runtime honors this ONLY on providers whose `supportsPTC` is true.
   * On every other wire, `allowed_callers` is stripped and the tool behaves as
   * a direct-only tool. MCP bridge tools and deferred tools are NOT eligible
   * for PTC (the schema builder will assert on misuse).
   */
  ptcAllowedCaller?: 'direct' | 'code_execution' | 'both'
}

export interface ToolResult {
  success: boolean
  output?: string
  error?: string
  /** For write_file tool: whether the file was created or updated */
  writeType?: 'update' | 'create'
  /** Approximate serialized size for message/tool budget (optional; filled by pipeline) */
  persistedResultPath?: string
  /**
   * Inline Skill tool: narrow tools / model for the remainder of this `runAgenticLoop`
   * (upstream-style contextModifier).
   */
  inlineSkillSession?: {
    skillName?: string
    allowedTools?: string[]
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'max'
  }
  /** When true (Skill tool), clear the active inline skill session for subsequent turns. */
  clearInlineSkillSession?: boolean
  /** Content blocks for rich responses (images, PDFs, etc.). */
  contentBlocks?: Array<{ type: string; base64?: string; mediaType?: string; originalSize?: number }>
  /** upstream-style error bucket for logging / future telemetry. */
  toolErrorClass?: string
  telemetryHint?: string
  /**
   * Structured failure shape — mirrors the `What / Tried / Context / Next`
   * sections of {@link formatToolError}'s output but as separate fields so
   * the renderer can give each its own visual region (headline emphasis,
   * collapsible "Tried", inline recovery affordance for `errorNext`).
   *
   * The plain `error` field above is still the canonical model-visible
   * payload — populated by `buildToolFailure(input).error`. These fields
   * are additive and exist solely so the UI doesn't have to reverse-parse
   * the formatted string. Tools that haven't migrated to `buildToolFailure`
   * leave them undefined; the renderer falls back to rendering `error`
   * verbatim when so.
   */
  errorWhat?: string
  errorTried?: string[]
  errorContext?: Record<string, string | number | null | undefined>
  errorNext?: string[]
  /** MCP protocol echo / bridge metadata (subset). */
  mcpMeta?: Record<string, unknown>
  /** Optional telemetry for Glob/Grep-style tools (ignored by strict API typing). */
  numFiles?: number
  numMatches?: number
  numLines?: number
  /** True when output was capped/truncated for size limits */
  truncated?: boolean
  /**
   * Set by file-mutation tools (edit_file / write_file / NotebookEdit) when
   * they have already appended a fresh LSP diagnostics trailer to {@link output}.
   * The agentic loop's loop-level diagnostics decorator (see
   * `runAgenticToolUseBody`) honors this flag to avoid double-wrapping the
   * same trailer. Tools that do NOT await for fresh diagnostics should leave
   * this unset so the loop-level decorator can attach a best-effort trailer
   * read from the (possibly slightly stale) diagnostics store.
   */
  diagnosticsAttached?: boolean
  /**
   * When `true`, the tool has already returned a tool_result to the model BUT
   * the underlying long-running task is still in flight (e.g. background
   * `Agent` spawn). The agentic loop MUST NOT call
   * `taskRuntimeStore.markCompleted/markFailed` on this tool_use_id; the
   * tool itself owns the runtime record's terminal transition (and emits
   * `markCompleted` / `markFailed` from its own callback).
   *
   * Without this flag, the runtime record flips to `completed` the moment
   * the spawn returns its `{status: "running", agentId}` JSON — which then
   * makes `TaskOutput` lie to the parent agent, telling it "task done, no
   * useful output" while the sub-agent is in fact still booting/working.
   */
  deferredRuntimeStoreCompletion?: boolean
}

/**
 * Tool definition suitable for sending to the AI API.
 * Matches Anthropic's tool format; other providers will be adapted in the client layer.
 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
    additionalProperties?: boolean
  }
  /**
   * Anthropic Tool Use Examples wire field. Populated only for the `anthropic`
   * family of wires; stripped by {@link sanitizeToolSchemaForWire} everywhere
   * else (and optionally folded into {@link description} via the same pass).
   */
  input_examples?: Array<Record<string, unknown>>
  /**
   * Anthropic Programmatic Tool Calling wire field. Populated when the
   * underlying {@link Tool.ptcAllowedCaller} is set AND the wire supports PTC.
   */
  allowed_callers?: string[]
}

/** Canonical PTC caller type identifier (reused by the server-tool block). */
export const PTC_CODE_EXECUTION_TYPE = 'code_execution_20260120' as const

/**
 * Server-side tool block advertised alongside regular tools when any tool
 * opts into PTC. Emitted as the **first** entry of the tools array so cache
 * hits stay stable when other tools rotate.
 */
export interface CodeExecutionServerTool {
  type: typeof PTC_CODE_EXECUTION_TYPE
  name: 'code_execution'
}

/** Union emitted by the tool schema layer when PTC is active on the wire. */
export type AnthropicToolsWireEntry = ToolDefinition | CodeExecutionServerTool
