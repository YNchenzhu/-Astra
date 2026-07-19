/**
 * Tool Middleware — in-process programmatic wrap-around for tool execution.
 *
 * Why this exists:
 *   - Existing hooks (`PreToolUse` / `PostToolUse` in `electron/tools/hooks/engine.ts`)
 *     are subprocess-based and have fire-and-forget event semantics — they can
 *     gate tool execution but cannot transform the tool_result block.
 *   - Middleware fills the "missing middle" (LangChain Middleware 2026 pattern):
 *     a function that wraps the actual tool call with `(ctx, next) => result`,
 *     letting callers transform input, post-process output, cache, retry,
 *     short-circuit, or inject context — all in-process, with full async/await
 *     control.
 *
 * Composition order:
 *   - First registered runs **outermost** (matches Express / Koa convention).
 *   - Each middleware receives `next(input?)` — passing a new input object
 *     replaces what the inner tool sees; passing nothing forwards the
 *     original `ctx.toolInput` unchanged.
 *
 * Lifecycle:
 *   - Middlewares are process-singletons (registered at app startup).
 *   - `registerToolMiddleware` returns an unregister function for cleanup.
 *   - `clearToolMiddlewareForTests` resets the registry between vitest runs.
 *
 * Scope:
 *   - This is for **tool** execution wrap-around. Model-call wrap-around
 *     (`wrap_model_call` in LangChain) lives in the agentic loop and is
 *     deliberately out of scope here — adding it would touch `agenticLoop.ts`
 *     and `kernel.ts` and is a larger change. Tool middleware solves the
 *     90% case for now (caching, retry, dynamic context injection,
 *     approval gates, etc).
 */

import type { AgentId } from '../tools/ids'

export interface ToolMiddlewareContext {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  agentId: AgentId
  agentType?: string
  conversationId?: string
}

/**
 * Inner-call signature — pass an explicit `effectiveInput` to override what
 * the wrapped tool sees, or omit to forward `ctx.toolInput` unchanged.
 */
export type ToolMiddlewareNext = (
  effectiveInput?: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export type ToolMiddleware = (
  ctx: ToolMiddlewareContext,
  next: ToolMiddlewareNext,
) => Promise<Record<string, unknown>>

interface RegisteredMiddleware {
  name: string
  matcher?: string | RegExp
  fn: ToolMiddleware
}

const REGISTRY: RegisteredMiddleware[] = []

export interface RegisterToolMiddlewareOptions {
  /**
   * Optional tool-name filter. When set, the middleware only runs for tools
   * whose name matches the pattern (string = case-insensitive equality;
   * RegExp = `.test`). Omit to apply to every tool.
   */
  matcher?: string | RegExp
}

/**
 * Register a tool middleware. Returns an unregister function — calling it
 * removes this exact middleware from the chain (no-op if already removed).
 */
export function registerToolMiddleware(
  name: string,
  fn: ToolMiddleware,
  options?: RegisterToolMiddlewareOptions,
): () => void {
  const entry: RegisteredMiddleware = {
    name,
    fn,
    ...(options?.matcher !== undefined ? { matcher: options.matcher } : {}),
  }
  REGISTRY.push(entry)
  return () => {
    const idx = REGISTRY.indexOf(entry)
    if (idx >= 0) REGISTRY.splice(idx, 1)
  }
}

/** Test helper — drop every registered middleware (call in `beforeEach`). */
export function clearToolMiddlewareForTests(): void {
  REGISTRY.length = 0
}

/** Diagnostic — number of registered middlewares (used by tests / dev panel). */
export function getRegisteredToolMiddlewareCount(): number {
  return REGISTRY.length
}

function matchesMatcher(toolName: string, matcher: string | RegExp | undefined): boolean {
  if (matcher === undefined) return true
  if (typeof matcher === 'string') {
    return toolName === matcher || toolName.toLowerCase() === matcher.toLowerCase()
  }
  return matcher.test(toolName)
}

/**
 * Run the registered middleware chain around `inner`.
 *
 * `inner` is the actual tool execution (e.g. wrapping `runAgenticToolUse`).
 * It receives the effective input (after every middleware has had a chance
 * to substitute it) and returns the raw `tool_result` block.
 *
 * If no middleware matches the tool, `inner` is invoked directly with
 * `ctx.toolInput`.
 */
export async function applyToolMiddleware(
  ctx: ToolMiddlewareContext,
  inner: (effectiveInput: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const matched = REGISTRY.filter((m) => matchesMatcher(ctx.toolName, m.matcher))
  if (matched.length === 0) {
    return inner(ctx.toolInput)
  }

  // Build the chain right-to-left so the first registered middleware runs outermost.
  // Each layer captures `currentInput` so substitutions stack correctly:
  // mw1 calls next({a: 2}) → mw2 sees ctx with a:2 in toolInput.
  let dispatch = (effectiveInput: Record<string, unknown>): Promise<Record<string, unknown>> =>
    inner(effectiveInput)

  for (let i = matched.length - 1; i >= 0; i--) {
    const layer = matched[i]
    const downstream = dispatch
    dispatch = (effectiveInput) => {
      const layerCtx: ToolMiddlewareContext = { ...ctx, toolInput: effectiveInput }
      const next: ToolMiddlewareNext = (override) =>
        downstream(override !== undefined ? override : effectiveInput)
      return layer.fn(layerCtx, next)
    }
  }

  return dispatch(ctx.toolInput)
}
