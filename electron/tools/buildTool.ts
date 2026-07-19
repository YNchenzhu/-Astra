/**
 * upstream alignment stage 4 — typed factory for {@link Tool} definitions.
 *
 * # Why
 *
 * Hand-written `Tool` objects had `execute: (input: Record<string, unknown>, ctx?)`
 * so every implementation began with a manual `as { ... }` cast to extract
 * its fields:
 *
 *     execute: async (input, ctx) => {
 *       const { file_path, old_string, new_string } = input as {
 *         file_path: string
 *         old_string: string
 *         new_string: string
 *       }
 *       ...
 *     }
 *
 * The cast is unchecked: rename a Zod field, forget to update the
 * destructure, and the bug only surfaces at runtime. `buildTool` turns
 * the Zod schema into the source of truth for the call signature so a
 * mismatch is a compile-time error in the same file.
 *
 * # Design choices (loose mode)
 *
 * - **No registry signature change.** The factory still emits a stock
 *   `Tool` whose `execute` looks like `(input: Record<string, unknown>,
 *   ctx?) => Promise<ToolResult>`. The registry and agentic loop don't
 *   know `buildTool` exists. Backward-compatible with every hand-written
 *   tool in the codebase.
 *
 * - **No double validation.** Both {@link ToolRegistry.execute} and
 *   `runAgenticToolUseBody` already call `validateToolZodInput(tool, input)`
 *   at the entrypoint. Repeating the parse inside `call` would burn CPU
 *   on every invocation. By the time `call(args, ctx)` runs, `input` has
 *   already passed `safeParse`, so casting to `z.infer<S>` is sound.
 *
 * - **Zero-arg tools.** `zInputSchema` is optional; when omitted the
 *   `call` receives `Record<string, unknown>` (matching the legacy shape).
 *   Tools like `EnterPlanMode` / `AwaySummary` use this path.
 *
 * # Usage
 *
 *     import { z } from 'zod'
 *     export const readFile = buildTool({
 *       name: 'read_file',
 *       description: '…',
 *       inputSchema: [{ name: 'path', type: 'string', description: '…', required: true }],
 *       zInputSchema: z.object({ path: z.string() }),
 *       isReadOnly: true,
 *       async call({ path }, ctx) {
 *         // `path` is inferred as `string` here — no manual cast.
 *         return { success: true, output: await fs.readFile(path, 'utf-8') }
 *       },
 *     })
 */

import type { ZodTypeAny, infer as zInfer } from 'zod'
import type { Tool, ToolResult } from './types'
import type { ToolUseContext } from './toolExecContext'

/**
 * All `Tool` interface fields *except* `execute` and `zInputSchema` —
 * those are supplied through the factory's `call` and explicit
 * `zInputSchema` arguments respectively.
 */
type ToolMeta = Omit<Tool, 'execute' | 'zInputSchema'>

/** Overload — Zod-schema'd tool: `call` receives the inferred input type. */
export function buildTool<S extends ZodTypeAny>(
  opts: ToolMeta & {
    zInputSchema: S
    call: (input: zInfer<S>, ctx?: ToolUseContext) => Promise<ToolResult>
  },
): Tool
/** Overload — schema-less tool (zero-arg or trust-the-caller). */
export function buildTool(
  opts: ToolMeta & {
    zInputSchema?: undefined
    call: (input: Record<string, unknown>, ctx?: ToolUseContext) => Promise<ToolResult>
  },
): Tool
export function buildTool(
  opts: ToolMeta & {
    zInputSchema?: ZodTypeAny
    // `call` is intentionally widened to the loose shape in the runtime
    // signature; the public overloads above narrow it for callers.
    call: (input: Record<string, unknown>, ctx?: ToolUseContext) => Promise<ToolResult>
  },
): Tool {
  const { call, ...rest } = opts
  return {
    ...rest,
    execute: (input, ctx) => call(input, ctx),
  }
}
