/**
 * Unified Tool Registry.
 *
 * Wraps all existing tool implementations (file tools, advanced tools, bash)
 * behind the standard `Tool` interface. The agentic loop discovers tools here,
 * gets their API schemas, and invokes them by name.
 *
 * Public API surface — implementation details live in sub-modules:
 *   - `registryBuiltinTools.ts`   built-in tool definitions
 *   - `registryHelpers.ts`        attachBuiltinExamples + assertAdvancedToolUseCoherence
 *   - `registryAgentTools.ts`     agent registration + custom-agent lifecycle
 */

import type { Tool, ToolResult, ToolUseContext } from './types'
import { registryPrimaryToolName } from './builtinToolAliases'
import { validateToolZodInput } from './toolInputZod'
import { guardAgainstDestructiveEmptyWrite } from './fileMutationGuard'
import { builtinTools } from './registryBuiltinTools'
import {
  attachBuiltinExamples,
  assertAdvancedToolUseCoherence,
} from './registryHelpers'
import { formatUnknownToolError } from './unknownToolError'
import {
  getToolWorkerHost,
  isWorkerFileMutationTool,
} from './workerProcess/toolWorkerHost'
import { isToolWorkerDispatchEnabled } from './workerProcess/toolWorkerEnv'
import { getAgentContext } from '../agents/agentContext'
import { withFileLock } from './fileLock'
import { resolvePathForTool } from './workspaceState'
import { findReadReceiptByReadId } from './readFileState'

export { isToolWorkerDispatchEnabled } from './workerProcess/toolWorkerEnv'

/**
 * Routes `runIn: 'worker'` tools through the utilityProcess when
 * {@link isToolWorkerDispatchEnabled} is true (packaged app defaults ON;
 * dev defaults OFF unless `ASTRA_TOOL_WORKER=1`).
 */
function shouldRouteToToolWorker(): boolean {
  return isToolWorkerDispatchEnabled()
}

export * from './registryAgentTools'

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private toolsetRevision = 0

  /**
   * @param tools Initial tool set. Defaults to {@link builtinTools} so production
   *   wiring (`new ToolRegistry()`) is unchanged; tests can inject a minimal/fake set
   *   to exercise registry logic in isolation without booting the full app.
   */
  constructor(tools: Tool[] = builtinTools) {
    for (const tool of tools) {
      const withExamples = attachBuiltinExamples(tool)
      assertAdvancedToolUseCoherence(withExamples)
      this.tools.set(withExamples.name, withExamples)
    }
  }

  /** Monotonic revision for agentic loop to detect tool list changes (register/unregister). */
  getToolsetRevision(): number {
    return this.toolsetRevision
  }

  /**
   * Bump the revision when the *visible* toolset changes without a
   * register/unregister — i.e. a deferred tool became exposed via
   * `ToolSearch` discovery. The agentic loop only refreshes its wire tool
   * list when {@link getToolsetRevision} changes, so discovery must surface
   * here too; otherwise a discovered deferred tool's full schema never reaches
   * the next request's `tools` array (and Zhipu/GLM, told "items not on this
   * list need ToolSearch", loops forever re-discovering it).
   */
  bumpVisibleToolsetRevision(): void {
    this.toolsetRevision += 1
  }

  /** Register a new tool (or replace an existing one) */
  register(tool: Tool): void {
    assertAdvancedToolUseCoherence(tool)
    this.tools.set(tool.name, tool)
    this.toolsetRevision += 1
  }

  /** Unregister a tool by name */
  unregister(name: string): boolean {
    const removed = this.tools.delete(registryPrimaryToolName(name))
    if (removed) {
      this.toolsetRevision += 1
    }
    return removed
  }

  /** Get a tool by name */
  get(name: string): Tool | undefined {
    return this.tools.get(registryPrimaryToolName(name))
  }

  /** List all registered tool names */
  list(): string[] {
    return [...this.tools.keys()]
  }

  /** Get all registered tools */
  getAll(): Tool[] {
    return [...this.tools.values()]
  }

  /**
   * Execute a tool by name with the given input.
   * @param options.skipRegistryInputValidation — when true, skips Zod + `validateInput` here
   *   (caller already ran them in `runAgenticToolUse` before PreToolUse hooks).
   * @param options.ctx — per-execution context (upstream alignment stage 1).
   *   Transparently forwarded to `tool.execute(input, ctx)`. Tools that don't
   *   declare a `ctx` parameter are unaffected (JS optional argument semantics).
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: { skipRegistryInputValidation?: boolean; ctx?: ToolUseContext },
  ): Promise<ToolResult> {
    const primary = registryPrimaryToolName(name)
    const tool = this.tools.get(primary)
    if (!tool) {
      return { success: false, ...formatUnknownToolError(name, this.list()) }
    }
    if (!options?.skipRegistryInputValidation) {
      const zod = validateToolZodInput(tool, input)
      if (!zod.ok) {
        // Audit P2#4: input-validation failures carry a stable
        // `toolErrorClass` like every other failure shape, so telemetry /
        // cross-agent guards classify them as validation instead of unknown.
        return { success: false, error: zod.message, toolErrorClass: 'validation' }
      }
      input = zod.data
      if (tool.validateInput) {
        try {
          const v = await tool.validateInput(input)
          if (!v.valid) {
            return {
              success: false,
              error: v.message || 'Invalid tool input.',
              toolErrorClass: 'validation',
            }
          }
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : String(e),
            toolErrorClass: 'validation',
          }
        }
      }
    }

    // Centralized destructive-empty-write guard. Runs for EVERY execution path
    // (agentic loop, IPC UI, MCP bridge, direct ops) regardless of whether Zod
    // was skipped above — an empty-content write from a PreToolUse hook or a
    // misbehaving MCP server can still be caught here. See
    // `electron/tools/fileMutationGuard.ts` for the invariant details.
    const destructiveCheck = guardAgainstDestructiveEmptyWrite(primary, input)
    if (!destructiveCheck.ok) {
      return { success: false, error: destructiveCheck.error }
    }
    if (tool.runIn === 'worker' && shouldRouteToToolWorker()) {
      // The worker is the only thing executing here — all surrounding
      // state (Zod, validateInput, destructive-empty guard,
      // PreToolUse/PostToolUse hooks, permission gates) has already
      // run in this main-process wrapper, so the worker sees a
      // pre-validated input it can trust.
      const agentCtxForDispatch = getAgentContext()
      const dispatchToWorker = (): Promise<ToolResult> =>
        getToolWorkerHost().dispatch(
          primary,
          input,
          {
            agentId: options?.ctx?.agentId,
            permissionMode: options?.ctx?.permissionMode,
            sessionAgentType: agentCtxForDispatch?.sessionAgentType,
            sessionMemoryWritableTargetPath:
              agentCtxForDispatch?.sessionMemoryWritableTargetPath,
          },
          options?.ctx?.abortSignal,
          options?.ctx?.emitToolProgress,
        )
      // SA-5 P0 fix: the worker holds a FRESH copy of `fileLock`, so its
      // internal per-file lock cannot exclude main-process mutators (e.g.
      // NotebookEdit) on the same path. For single-file mutation tools we
      // hold MAIN's per-file lock for the whole worker round-trip — main
      // stays the single lock authority; the worker's own lock remains as
      // harmless redundancy. Read-only worker tools are never locked
      // (parallel reads must stay parallel). If the path cannot be
      // resolved, dispatch unlocked and let the tool surface the error.
      if (tool.isReadOnly === false && isWorkerFileMutationTool(primary)) {
        const rawPath =
          typeof input.filePath === 'string'
            ? input.filePath
            : typeof input.file_path === 'string'
              ? (input.file_path as string)
              : ''
        if (rawPath.trim()) {
          const resolved = resolvePathForTool(rawPath)
          if (resolved.ok) {
            return withFileLock(resolved.resolved, dispatchToWorker)
          }
        } else {
          // Audit fix (2026-07, P1): the `filePath`-omitted + `baseReadId`
          // fallback used to dispatch UNLOCKED — the worker recovers the
          // path from the receipt, so main can too. Without this, a
          // baseReadId-only write raced main-process mutators on the same
          // file with zero mutual exclusion.
          const rawAnchor = input.baseReadId ?? input.base_read_id
          const anchor =
            typeof rawAnchor === 'string' && rawAnchor.trim() ? rawAnchor.trim() : undefined
          const receiptPath = anchor
            ? findReadReceiptByReadId(anchor)?.record.absPath
            : undefined
          if (receiptPath) {
            return withFileLock(receiptPath, dispatchToWorker)
          }
        }
      }
      return dispatchToWorker()
    }
    return tool.execute(input, options?.ctx)
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(registryPrimaryToolName(name))
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry()

/** upstream `getAllBaseTools()` analogue — full registered tool list (report §4.2). */
export function getAllBaseTools(): Tool[] {
  return toolRegistry.getAll()
}

// Debug: Log registered tools on startup
if (process.env.DEBUG_TOOLS) {
  console.log('[Tool Registry] Initialized with tools:', toolRegistry.list())
}
