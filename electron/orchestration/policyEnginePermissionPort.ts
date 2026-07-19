/**
 * The kernel's sole {@link PermissionPort} factory — wraps the unified
 * {@link PolicyEngine} so every preflight decision (chat-mode, workspace permission rules,
 * agent allowlist / denylist, global rules, resource quota admission, cross-agent
 * repeat-failure history) goes through one function call.
 *
 * Chunk 6 collapsed the previous three-layer composition
 * (`createRulePermissionPort` → `createChatModePermissionPort` →
 * `createPolicyEnginePermissionPort`) into PolicyEngine's `evaluate()` itself. The
 * `POLE_ORCHESTRATION_POLICY_ENGINE` and `POLE_ORCHESTRATION_CHATMODE` flags were removed
 * along with the layering — the engine is now the only PEP and is always on.
 */

import type { PolicyDecision, PolicyEngine } from './toolRuntime/policy'
import type { PermissionPort, PermissionPreflightResult } from './ports'
import type { AgentId } from '../tools/ids'
import type { ChatMode } from './chatMode'
import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import { ToolPriority } from './toolRuntime/scheduler'

/**
 * Resolver for the agent-scoped policy context fetched once per preflight call.
 *
 * All fields are optional except `agentId`. Supply only the ones that apply — the
 * engine treats missing fields as "no restriction at this layer".
 */
export type PolicyContextResolver = () => {
  agentId: AgentId
  agentType?: string
  conversationId?: string
  permissionMode?:
    | 'default'
    | 'plan'
    | 'bypassPermissions'
    | 'acceptEdits'
    | 'dontAsk'
    | 'auto'
    | 'bubble'
  toolAllowlist?: string[]
  toolDenylist?: string[]
  /** Chunk 6 — chat interaction mode (`agent`/`plan`/`ask`). */
  chatMode?: ChatMode
  /** Chunk 6 — workspace permission rule patterns. */
  permissionRules?: PermissionRulePayload[]
  /** Chunk 6 — default-mode-deny gate. */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
}

export function createPolicyEnginePermissionPort(options: {
  /** The engine instance. Use `getPolicyEngine()` to get the singleton. */
  engine: PolicyEngine
  /** Resolves the agent-scoped policy context per call. Optional. */
  resolveContext?: PolicyContextResolver
}): PermissionPort {
  const { engine, resolveContext } = options
  return {
    preflight(req) {
      let ctxResolved: ReturnType<PolicyContextResolver> | undefined
      try {
        ctxResolved = resolveContext?.()
      } catch (e) {
        if (process.env.POLE_PREFLIGHT_FAIL_OPEN !== '1') {
          return {
            decision: 'deny',
            reason: `Policy context resolver threw: ${e instanceof Error ? e.message : String(e)}`,
            matchedRule: 'policyEnginePort:resolver-error',
          }
        }
        // P0 fix (audit §4.4) — fail-open symmetry with the engine-throw
        // branch below: when fail-open is enabled, return `allow` immediately
        // rather than fall through into `engine.evaluate({ agentId: 'unknown' })`
        // which is a third, undocumented behaviour ("evaluate with synthetic
        // context"). Both throw points now resolve to `allow` under fail-open.
        return { decision: 'allow' }
      }
      const context = ctxResolved ?? { agentId: 'unknown' as AgentId }
      let decision: PolicyDecision
      try {
        decision = engine.evaluate({
          toolName: req.toolName,
          toolInput: req.toolInput,
          toolUseId: req.toolUseId,
          context,
          // The kernel preflight does not have semantic knowledge of "read vs write" without
          // calling into the tool registry. The conservative default `isReadOnly: false`
          // ensures PolicyEngine applies the stricter mutation-side quotas. Callers that
          // know better can plug a custom port instead of this adapter.
          isReadOnly: false,
          priority: ToolPriority.NORMAL,
          // Audit P1 — defer quota + history to `DefaultToolRuntimePort`'s
          // Phase 8 / Phase 7, which evaluate them with the REAL `isReadOnly`,
          // `priority`, and caller `agentId`. Running them here too would (a)
          // double-evaluate every tool and (b) use the wrong inputs: the
          // `isReadOnly:false` default misclassifies read-only tools into the
          // mutation quota (false denials), and the `agentId:'main'` context
          // collapses H4 sibling-isolation back into "all outcomes count"
          // (a sub-agent gets blocked by unrelated siblings' failures).
          skipQuota: true,
          skipHistory: true,
        })
      } catch (e) {
        if (process.env.POLE_PREFLIGHT_FAIL_OPEN !== '1') {
          return {
            decision: 'deny',
            reason: `PolicyEngine.evaluate threw: ${e instanceof Error ? e.message : String(e)}`,
            matchedRule: 'policyEnginePort:engine-error',
          }
        }
        return { decision: 'allow' }
      }
      return policyDecisionToPreflight(decision)
    },
  }
}

/** Translate the rich `PolicyDecision` shape into the kernel's preflight result. */
export function policyDecisionToPreflight(decision: PolicyDecision): PermissionPreflightResult {
  if (decision.allowed) return { decision: 'allow' }
  return {
    decision: 'deny',
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.matchedRules && decision.matchedRules.length > 0
      ? { matchedRule: decision.matchedRules.join(',') }
      : { matchedRule: 'policyEngine' }),
  }
}
