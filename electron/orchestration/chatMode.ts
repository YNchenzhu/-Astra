/**
 * ChatMode policy primitives.
 *
 * the IDE exposes three first-class interaction modes:
 *   - `agent` — normal tool execution (default).
 *   - `plan`  — read-only tools allowed + `ExitPlanMode`; every file-mutation / shell /
 *     permission-sensitive tool is denied pre-flight. `ExitPlanMode` is the exit ramp.
 *   - `ask`   — no tool execution at all; any tool_use is denied pre-flight.
 *
 * Chunk 6 collapsed the standalone `createChatModePermissionPort` factory into
 * `PolicyEngine.evaluate` (see `toolRuntime/policy.ts`). What lives here today is
 * just the `ChatMode` type plus the {@link isPlanModeBlockingTool} predicate the
 * engine calls.
 */

import { toolRegistry } from '../tools/registry'
import { canonicalBuiltinToolName } from '../tools/builtinToolAliases'

export type ChatMode = 'agent' | 'plan' | 'ask'

/**
 * P2-7 / P1-5 — map a sub-agent's captured `AgentContext.permissionModeOverride`
 * to the blocking {@link ChatMode} the PolicyEngine understands, for the
 * fallback tool-execution path (`toolExec.ts#executeFallbackBatchWithWiring`).
 *
 * Parity contract with the orchestrated main-chat PEP: ONLY `'plan'` maps to a
 * blocking chat mode (mutating tools denied, read-only allowed). Every other
 * permission mode — including the internal-fork modes `'dontAsk'` /
 * `'bypassPermissions'` and the no-opinion `'default'` / `'acceptEdits'` /
 * `'bubble'` / `undefined` — maps to `undefined` (no chatMode constraint), so:
 *
 *   - a Task / teammate sub-agent spawned while the parent is in Plan mode
 *     (which captures `'plan'` via `resolveSubAgentPermissionOverride`) gets its
 *     mutating tools blocked, exactly like the main agent, AND
 *   - internal forks (session-memory-internal / dream) that capture
 *     `'dontAsk'` / `'bypassPermissions'` are NOT swept into plan-blocking just
 *     because the parent conversation happens to be in Plan mode.
 *
 * `'ask'` mode is intentionally NOT produced here: Ask mode is enforced upstream
 * by disabling tools entirely, not by this preflight gate.
 */
export function resolveFallbackChatMode(
  permissionModeOverride: string | undefined,
): ChatMode | undefined {
  return permissionModeOverride === 'plan' ? 'plan' : undefined
}

/**
 * Plan-mode allow/deny is now derived from the {@link toolRegistry}'s `isReadOnly` flag.
 * The hardcoded lists below cover only the edge cases the registry can't express:
 *
 *   - {@link PLAN_MODE_EXIT_TOOLS}              — always allowed (the exit ramp).
 *   - {@link PLAN_MODE_HOST_TOOL_ALLOWLIST}     — host-environment tools (e.g. the IDE's
 *                                                 SemanticSearch) that aren't in the local
 *                                                 registry but are read-only by contract.
 *   - {@link PLAN_MODE_REGISTRY_DENYLIST}       — registry-marked `isReadOnly: true` tools whose
 *                                                 effect is to "spawn work that may mutate";
 *                                                 still blocked in Plan mode.
 */

const PLAN_MODE_EXIT_TOOLS: ReadonlySet<string> = new Set<string>([
  'ExitPlanMode',
])

const PLAN_MODE_HOST_TOOL_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'SemanticSearch',
  // MCP resource tools are factory-registered at runtime (require MCPClientManager) so they
  // may be absent from the registry during early init / unit tests. Read-only by contract.
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])

const PLAN_MODE_REGISTRY_DENYLIST: ReadonlySet<string> = new Set<string>([
  'Agent',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
])

function isToolAllowedInPlanMode(toolName: string): boolean {
  if (PLAN_MODE_EXIT_TOOLS.has(toolName)) return true

  // `canonicalBuiltinToolName` resolves legacy aliases to their canonical name
  // (e.g. `ReadMcpResource` → `ReadMcpResourceTool`, `web_fetch` → `WebFetch`).
  const canonical = canonicalBuiltinToolName(toolName)
  if (PLAN_MODE_HOST_TOOL_ALLOWLIST.has(canonical)) return true
  if (PLAN_MODE_REGISTRY_DENYLIST.has(canonical)) return false

  // toolRegistry.get internally re-canonicalises via registryPrimaryToolName, so it accepts
  // both raw and canonical names; it returns undefined for unregistered tools (default-deny).
  const tool = toolRegistry.get(canonical) ?? toolRegistry.get(toolName)
  if (tool?.isReadOnly === true) return true

  return false
}

function isToolMutatingForPlanMode(toolName: string): boolean {
  return !isToolAllowedInPlanMode(toolName)
}

/** Plan-mode predicate consumed by `PolicyEngine.evaluate` and ad-hoc call sites. */
export function isPlanModeBlockingTool(toolName: string): boolean {
  return isToolMutatingForPlanMode(toolName)
}
