/**
 * Main-process orchestration inputs for a single user send → model call.
 * Assembles system prompt with upstream AC-6.3-style **layers** (systemContext vs userContext)
 * before optional agent role suffixes elsewhere.
 */

import {
  buildSystemPromptLayers,
  buildUserMessageContextBody,
  mergeSystemPromptLayers,
  formatToolUseConventions,
  prependSystemAttribution,
  ANTI_ACTION_HALLUCINATION_BLOCK,
  ANTI_ACTION_HALLUCINATION_MARKER,
  HOST_RUNTIME_CONTRACT_BLOCK,
  HOST_RUNTIME_CONTRACT_MARKER_RECALL,
  INTENT_COMPREHENSION_BLOCK,
  INTENT_COMPREHENSION_MARKER,
  PERSISTENCE_BLOCK,
  PERSISTENCE_MARKER,
  COMPLETION_EVIDENCE_PROMPT_BLOCK,
  COMPLETION_EVIDENCE_PROMPT_MARKER,
  type SystemPromptLayers,
} from './systemPrompt'
import {
  completionEvidenceHandshakeApplies,
  isCompletionEvidenceGateEnabled,
} from './agenticLoop/completionEvidenceGate'
import { EDIT_FILE_CONTRACT_BLOCK } from '../constants/prompts/systemDirectives'

export type MainOrchestrationContext = {
  workspacePath: string | undefined
  cwd: string
  platform: NodeJS.Platform
  outputStyle: 'default' | 'concise' | 'explanatory'
  language: string
  /**
   * Recalled facts from the persistent memory store (semantic + bm25 hits).
   * Rendered as `<project-memory>` — the tag the model is trained to read as
   * "long-lived project notes / prior decisions". Keep this distinct from
   * {@link memoryCapabilities} so the model does not confuse the static
   * "you have a memory system" tutorial text with actual recalled facts.
   */
  memoryContext: string
  /**
   * Static educational text describing the memory subsystem (file format,
   * what to save, retention policy). Rendered as `<memory-capabilities>` —
   * a separate sibling of `<project-memory>` so the model does not treat
   * tutorial language ("You have access to a persistent memory system…")
   * as if it were a recalled fact, and vice versa. Optional — when absent
   * only `<project-memory>` ships, preserving the legacy single-tag layout.
   */
  memoryCapabilities?: string
  sessionContext: string
  /** Drained passive LSP batch for this turn (may be empty) */
  passiveLspDiagnostics: string
  /** If set, replaces default astra system prompt; LSP / skills / rules still go to userContext when non-empty */
  customSystemPrompt: string | undefined
  /** Settings → Rules (renderer); appended to userContext */
  userRulesPrompt: string | undefined
  /** When true, inject {@link EDIT_FILE_CONTRACT_BLOCK} (main chat has edit_file on the tool surface) */
  includeEditFileContract?: boolean
  /**
   * Pre-rendered companion / buddy intro text. Caller (streamHandler) computes
   * this with `buildBuddySystemPrompt(getBuddyState())` and we just route it
   * through `SystemPromptOptions.buddyPromptBody` so the prompt registry stays
   * pure. Empty / omitted when the buddy is disabled or muted. Audit P0-2a.
   */
  buddyPromptBody?: string
}

function formatUserRulesBlockBody(rules: string | undefined): string {
  const r = rules?.trim()
  if (!r) return ''
  return `# User-configured rules (Settings → Rules)
${r}`
}

// Stage 10 — custom path now reuses the default path's
// `buildUserMessageContextBody` (exported in `systemPrompt.ts`) so
// memory + LSP + env + session + skill are formatted by exactly one
// implementation. The previous `formatUserMessageContextBlock` and
// `formatEnvironmentSectionForCustomPath` helpers were duplicated copies
// kept in sync by hand; deleting them eliminates the drift surface.

/**
 * Same semantics as historical `buildMainSystemPromptFromOrchestration`, split for cache-tier / 注入边界。
 *
 * Returns three layers — see {@link SystemPromptLayers}:
 *   - `systemContext` / `userContext` are merged into the API `system` field.
 *   - `userMessageContext` ships separately as a `<system-reminder>` user-meta
 *     message at `messages[0]` (caller responsibility — see `streamHandler.ts`).
 */
export function buildMainSystemPromptLayersFromOrchestration(
  ctx: MainOrchestrationContext,
): SystemPromptLayers {
  const custom = ctx.customSystemPrompt?.trim()
  if (custom) {
    const userParts: string[] = []
    // Stage 4 + Stage 6: env + session_context + memory + LSP + skill
    // index all moved to `userMessageContext` (user-meta message). What
    // stays in userParts (system field) is the genuinely "instruction-
    // grade" content for the custom-bundle path: user-configured rules.
    // 2026-05 cleanup: edit-file contract was moved from `userParts` to
    // the cached `systemContext` (see `hostContractParts` below) so the
    // custom-bundle path matches the default path's cache layout — the
    // contract is session-stable (per-agent capability flag, not
    // per-turn input) and belongs in the cached prefix on BOTH paths.
    const rules = formatUserRulesBlockBody(ctx.userRulesPrompt)
    if (rules) userParts.push(rules)
    // Stage 5 — host runtime contract must travel with EVERY prompt,
    // bundle or default. The contract describes how the host injects
    // context (`<system-reminder>`, `<historical-snapshot>`,
    // `<recall-pointer>`), how to recall already-completed work after a
    // compact, and how to use the read_file → edit_file workflow.
    // These are not style choices that bundles legitimately rewrite —
    // they're the runtime API between host and model. Without this
    // injection a custom-bundle prompt would silently lose the
    // edit_file `baseReadId` discipline and the "do NOT redo summarized
    // work" recall ladder, both of which production users hit regularly.
    //
    // Idempotent: a bundle author who explicitly inlines either block
    // (e.g. a custom phrasing) is detected by marker substring and the
    // host injection is skipped.
    const hostContractParts: string[] = []
    // Audit fix R1-H2 (2026-05) — the previous gate required BOTH
    // `# System` (`HOST_RUNTIME_CONTRACT_MARKER_SYSTEM`) AND the recall
    // section header. `# System` is two extremely common words: any
    // bundle prompt with a `# System Architecture` / `# System
    // Requirements` / `# System Overview` heading that ALSO happened to
    // paraphrase the recall section would silently suppress the whole
    // host runtime contract — losing the `<system-reminder>` /
    // `<historical-snapshot>` / `<recall-pointer>` / side-channel-kinds
    // documentation the model needs to interpret host-injected context.
    // The recall header is much longer and uniquely identifies the
    // contract block, so use it alone as the idempotency guard.
    const carriesSystemBlock = custom.includes(HOST_RUNTIME_CONTRACT_MARKER_RECALL)
    if (!carriesSystemBlock) {
      hostContractParts.push(HOST_RUNTIME_CONTRACT_BLOCK)
    }
    const carriesToolConventions = custom.includes('# Tool-use conventions')
    if (!carriesToolConventions) {
      hostContractParts.push(formatToolUseConventions(ctx.platform))
    }
    // Edit-file contract — keep on the cached system side together with
    // the host contract (matches the default-path placement after the
    // 2026-05 cleanup that moved `editFileContractSection` to `layer:
    // 'system'`). Idempotent — bundles that already inline the contract
    // header should not get a second copy.
    if (
      ctx.includeEditFileContract &&
      !custom.includes('# edit_file / multi_edit_file contract')
    ) {
      hostContractParts.push(EDIT_FILE_CONTRACT_BLOCK)
    }

    // Behavioural floor — anti-action-hallucination must survive into
    // every custom-bundle prompt. Without this, the moment a user picks
    // a workpack whose primary agent supplies a non-empty
    // `systemPromptRaw` / `promptSections`, the entire default
    // 星构Astra prompt (including the "no past-tense completion claims
    // without a tool call" guardrail) is short-circuited; production
    // users have observed the model regress to "我已经修改了 X" without
    // actually invoking edit_file. The block is appended after the
    // bundle's own prompt so the bundle's wording (persona, tone,
    // domain rules) lands first; the guardrail is the LAST thing the
    // model reads before answering, which we want for max recency
    // weight.
    //
    // Idempotent: skip if the bundle author already inlined the block
    // (e.g. a future preset that wants to phrase it differently).
    let customWithGuardrail = custom.includes(ANTI_ACTION_HALLUCINATION_MARKER)
      ? custom
      : `${custom}\n\n${ANTI_ACTION_HALLUCINATION_BLOCK}`

    // Audit P0-COV — intent-comprehension floor. A bundle that replaces the
    // default `# Doing tasks` / `# Response style` sections loses the
    // "infer & echo the underlying objective" guidance (P0/P1); re-inject a
    // compact version so custom-bundle users keep deep-intent behavior.
    // Idempotent: skip if the bundle already inlines the marker.
    if (!customWithGuardrail.includes(INTENT_COMPREHENSION_MARKER)) {
      customWithGuardrail = `${customWithGuardrail}\n\n${INTENT_COMPREHENSION_BLOCK}`
    }

    // 2026-07 quality uplift — persistence / thoroughness floor. Same
    // rationale as the two blocks above: a bundle prompt replaces the
    // default sections, and without this floor every workpack silently
    // regresses to shallow "went through the motions" execution (the
    // documented cross-workpack failure). Idempotent via marker.
    if (!customWithGuardrail.includes(PERSISTENCE_MARKER)) {
      customWithGuardrail = `${customWithGuardrail}\n\n${PERSISTENCE_BLOCK}`
    }

    // 2026-07 completion-evidence handshake — protocol floor. The host-side
    // gate (row 12f) challenges every tool-using completion that lacks the
    // in-band `<complete-evidence>` tag. A bundle prompt that replaces the
    // default instruction section silently drops the protocol text, so the
    // model can never comply and EVERY completion pays a hidden challenge
    // round — user-visible as a multi-second stall between the last visible
    // sentence and message_stop. Force-inject so custom bundles stay on the
    // zero-latency happy path. Same env flag as the gate; idempotent via
    // marker.
    //
    // 2026-07 复审 N1 fix — work-package gated: ONLY bundles whose resolved
    // verification policy is `'code'` walk the host handshake (per product
    // design, only the built-in code-dev work package uses the internal
    // verification loop; every other domain is prompt-driven). Injecting
    // the protocol into a writing / legal bundle taught the model a ritual
    // the host would never check — pure token cost, no verification value.
    if (
      isCompletionEvidenceGateEnabled() &&
      completionEvidenceHandshakeApplies() &&
      !customWithGuardrail.includes(COMPLETION_EVIDENCE_PROMPT_MARKER)
    ) {
      customWithGuardrail = `${customWithGuardrail}\n\n${COMPLETION_EVIDENCE_PROMPT_BLOCK}`
    }

    // Final layout for the custom systemContext:
    //   [attribution] · [host runtime contract] · [tool conventions] · [bundle prompt + guardrail]
    // Attribution sits at the top for telemetry / cache identity.
    // Host contract + tool conventions land RIGHT AFTER attribution so
    // they're stable cache prefix shared across bundles. The bundle's
    // own persona / domain rules then land last (in `customWithGuardrail`)
    // for max recency.
    const systemContextBody = [...hostContractParts, customWithGuardrail]
      .filter(Boolean)
      .join('\n\n')

    return {
      systemContext: prependSystemAttribution(ctx.cwd, systemContextBody),
      userContext: userParts.join('\n\n'),
      userMessageContext: buildUserMessageContextBody({
        cwd: ctx.cwd,
        platform: ctx.platform,
        outputStyle: ctx.outputStyle,
        language: ctx.language,
        memoryContext: ctx.memoryContext,
        memoryCapabilities: ctx.memoryCapabilities,
        sessionContext: ctx.sessionContext,
        lspPassiveDiagnosticsContext: ctx.passiveLspDiagnostics,
        ...(ctx.buddyPromptBody ? { buddyPromptBody: ctx.buddyPromptBody } : {}),
      }),
    }
  }

  const layers = buildSystemPromptLayers({
    cwd: ctx.cwd,
    platform: ctx.platform,
    outputStyle: ctx.outputStyle,
    language: ctx.language,
    memoryContext: ctx.memoryContext,
    memoryCapabilities: ctx.memoryCapabilities,
    sessionContext: ctx.sessionContext,
    lspPassiveDiagnosticsContext: ctx.passiveLspDiagnostics,
    includeEditFileContract: ctx.includeEditFileContract,
    ...(ctx.buddyPromptBody ? { buddyPromptBody: ctx.buddyPromptBody } : {}),
  })
  const rules = formatUserRulesBlockBody(ctx.userRulesPrompt)
  if (!rules) return layers
  return {
    systemContext: layers.systemContext,
    userContext: layers.userContext.trim() ? `${layers.userContext}\n\n${rules}` : rules,
    userMessageContext: layers.userMessageContext,
  }
}

export function buildMainSystemPromptFromOrchestration(ctx: MainOrchestrationContext): string {
  const L = buildMainSystemPromptLayersFromOrchestration(ctx)
  return mergeSystemPromptLayers(L.systemContext, L.userContext)
}
