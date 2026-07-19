/**
 * Tool batch partition planner — single source of truth for "serial vs parallel" tool scheduling
 * used by both `runAgenticToolUseBatch` (live execution) and the orchestration kernel's planning
 * surface. Rules live here instead of being duplicated inside `agenticToolBatch.ts`.
 *
 * Two layers:
 *   1. `canToolUseRunInParallelBatch` — per-tool predicate (read-only + concurrency-safe).
 *   2. `planToolExecution` — carves the full `toolUses` sequence into ordered concrete
 *      execution steps respecting both parallel-eligibility AND max parallel chunk size
 *      (Agent vs non-Agent ceilings). Consumers just iterate the plan.
 *
 * Legacy export `partitionToolUsesIntoChunks` is retained as a thin wrapper over `planToolExecution`
 * for tests and telemetry that only care about the chunk grouping.
 */

import { toolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import { isAgenticWorkspaceFileMutationTool } from '../tools/builtinToolAliases'
import {
  MAX_PARALLEL_AGENT_TOOL_CALLS,
  MAX_PARALLEL_TOOL_CALLS,
} from '../tools/toolOrchestrationConstants'

export type ToolUseItem = {
  id: string
  name: string
  input: Record<string, unknown>
  thoughtSignature?: string
}

export type ToolUseChunk = ToolUseItem[]

/** Tools that must stay serial even when the registry reports them as concurrency-safe. */
export const NON_PARALLEL_TOOLS: ReadonlySet<string> = new Set<string>([
  'Skill',
  'AskUserQuestion',
  'SendMessage',
])

export function isShellToolName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'bash' || n === 'powershell'
}

function resolveIsConcurrencySafe(
  tool: Tool | undefined,
  toolInput: Record<string, unknown>,
): boolean {
  if (!tool) return false
  const ics = tool.isConcurrencySafe
  if (typeof ics === 'function') {
    try {
      return ics(toolInput)
    } catch {
      return false
    }
  }
  if (typeof ics === 'boolean') return ics
  return false
}

/**
 * Per-tool predicate — true when the tool may be executed concurrently with other parallel-safe
 * tools within the same chunk. Shared with `toolPipeline` consumers so both the planner and the
 * live executor evaluate the same policy.
 */
export function canToolUseRunInParallelBatch(
  toolName: string,
  toolInput?: Record<string, unknown>,
): boolean {
  const input = toolInput ?? {}
  if (NON_PARALLEL_TOOLS.has(toolName)) return false
  if (isAgenticWorkspaceFileMutationTool(toolName)) return false
  const tool = toolRegistry.get(toolName)
  return resolveIsConcurrencySafe(tool, input)
}

/** Effective max parallelism for a pending chunk — Agent tools use a stricter ceiling. */
export function maxParallelChunkSize(items: Array<{ name: string }>): number {
  const hasAgent = items.some((t) => t.name === 'Agent')
  return hasAgent ? MAX_PARALLEL_AGENT_TOOL_CALLS : MAX_PARALLEL_TOOL_CALLS
}

/**
 * Execution step — either one serial tool or one parallel chunk (already sized against the
 * max-parallel ceiling). `useShellSiblingCancel` is true for parallel chunks where a shell tool
 * failure should abort its siblings (preserves legacy `runAgenticToolUseBatch` semantics).
 */
export type ToolExecutionStep =
  | {
      kind: 'serial'
      item: ToolUseItem
      /** Position of `item` in the original `toolUses` array. */
      originalIndex: number
    }
  | {
      kind: 'parallel'
      items: ToolUseItem[]
      /** Position of `items[0]` in the original `toolUses` array. */
      originalIndex: number
      useShellSiblingCancel: boolean
    }

export type ToolExecutionPlan = ToolExecutionStep[]

/**
 * Compute the concrete execution plan for a batch of tool_use blocks. Consumers iterate the plan
 * top-to-bottom and execute each step; the planner guarantees:
 *   - serial-only tools never share a step with siblings;
 *   - parallel chunks never exceed the Agent / non-Agent size ceiling;
 *   - parallel chunks containing a shell tool are flagged so siblings can be aborted on failure.
 */
export function planToolExecution(toolUses: ToolUseItem[]): ToolExecutionPlan {
  const plan: ToolExecutionPlan = []
  let i = 0
  while (i < toolUses.length) {
    const head = toolUses[i]
    if (!canToolUseRunInParallelBatch(head.name, head.input)) {
      plan.push({ kind: 'serial', item: head, originalIndex: i })
      i++
      continue
    }
    // Greedy grow a parallel-eligible run.
    let j = i
    while (
      j < toolUses.length &&
      canToolUseRunInParallelBatch(toolUses[j].name, toolUses[j].input)
    ) {
      j++
    }
    const run = toolUses.slice(i, j)
    // Subdivide the run respecting max parallel chunk size (Agent-aware).
    let c = 0
    while (c < run.length) {
      const rest = run.slice(c)
      const limit = maxParallelChunkSize(rest)
      const chunk = rest.slice(0, limit)
      if (chunk.length === 1) {
        plan.push({ kind: 'serial', item: chunk[0], originalIndex: i + c })
      } else {
        const useShellSiblingCancel = chunk.some((tu) => isShellToolName(tu.name))
        plan.push({
          kind: 'parallel',
          items: chunk,
          originalIndex: i + c,
          useShellSiblingCancel,
        })
      }
      c += chunk.length
    }
    i = j
  }
  return plan
}

/**
 * Legacy chunk grouping — kept for backward compatibility with `partitionToolUsesIntoChunks` tests
 * and remote-trigger telemetry consumers. Flattens `ToolExecutionPlan` back into the pre-existing
 * "each chunk is a serial tool or a maximal run of parallel-safe tools" shape. New callers should
 * consume `planToolExecution` directly because it also respects max-parallel chunk sizing.
 */
export function partitionToolUsesIntoChunks(toolUses: ToolUseItem[]): ToolUseChunk[] {
  const chunks: ToolUseChunk[] = []
  let i = 0
  while (i < toolUses.length) {
    const tu = toolUses[i]
    if (!canToolUseRunInParallelBatch(tu.name, tu.input)) {
      chunks.push([tu])
      i++
      continue
    }
    const batch: ToolUseChunk = []
    let j = i
    while (
      j < toolUses.length &&
      canToolUseRunInParallelBatch(toolUses[j].name, toolUses[j].input)
    ) {
      batch.push(toolUses[j])
      j++
    }
    chunks.push(batch)
    i = j
  }
  return chunks
}
