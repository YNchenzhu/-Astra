/**
 * P2 — Streaming-executor bypass policy.
 *
 * Audit P0b: when permission policy is non-trivial, route tool execution
 * through `DefaultToolRuntimePort` / fallback batch instead of the
 * streaming executor so the `PolicyEngine` preflight (chat-mode,
 * workspace permission rules, agent allowlist/denylist, global rules)
 * and the `permission_denied_preflight` phase event run as the
 * orchestrated path would.
 *
 * Pure function — moved out of `stream.ts` for testability and so
 * unrelated changes to the streaming executor don't drift it.
 *
 * "Non-trivial" today:
 *   - `chatMode !== 'agent'` (Plan / Ask) — these modes deny mutating / all
 *     tools at preflight via `PolicyEngine.evaluate`'s chat-mode gate, which
 *     only runs on the orchestrated batch path. Forcing the fallback here
 *     makes the implicit "plan/ask never reaches the streaming executor"
 *     invariant an enforced guarantee (covers sub-agent / teammate / future
 *     callers, not just main chat);
 *   - any workspace `permissionRules` configured;
 *   - `permissionDefaultMode === 'deny'` (default-deny rejects every tool);
 *   - explicitly disabled via `POLE_STREAMING_TOOL_EXECUTOR=0`.
 *
 * Trivial case (agent mode, no rules, default mode allow/ask) keeps the
 * streaming executor on for latency parity with upstream —
 * `runAgenticToolUseBody` still enforces ask-flow permissions deep in the
 * call stack, and `StreamingToolExecutor.executeToolUse` runs a defense-in-
 * depth `PolicyEngine.evaluate` (with `chatMode`) for any tool that still
 * starts on the streaming path.
 */

export function shouldBypassStreamingExecutorForPolicy(input: {
  permissionRules?: ReadonlyArray<unknown> | undefined
  permissionDefaultMode?: 'allow' | 'ask' | 'deny' | string | undefined
  chatMode?: 'agent' | 'plan' | 'ask' | string | undefined
  envOverride?: string | undefined
}): boolean {
  if (input.envOverride === '0') return true
  if (input.chatMode && input.chatMode !== 'agent') return true
  if ((input.permissionRules?.length ?? 0) > 0) return true
  if (input.permissionDefaultMode === 'deny') return true
  return false
}
