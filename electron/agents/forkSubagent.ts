/**
 * Fork subagent — inherits parent's full conversation context.
 *
 * When the Agent tool is called WITHOUT a subagent_type, the parent agent
 * forks itself. The fork inherits the parent's message history (shared
 * object references where possible for prompt-cache friendliness), then
 * receives a structured child directive + task prompt.
 */

import { getAgentContext } from './agentContext'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/** Detect nested fork: parent transcript must not already include this block. */
export const FORK_BOILERPLATE_TAG = '<fork-boilerplate>'

const FORK_BOILERPLATE_CLOSE = '</fork-boilerplate>'

/**
 * Internal metadata flag set on the injected boilerplate envelope. The recursive-fork
 * detector reads this flag rather than substring-matching `<fork-boilerplate>` in
 * arbitrary message content, which previously false-positived when the parent had
 * read `forkSubagent.ts` (or any file/tool result containing the literal tag) — see
 * audit report Bug F-1. Stripped before sending to the provider via
 * `INTERNAL_KEYS` in `normalizeMessagesForAPI.ts`.
 */
export const FORK_BOILERPLATE_FLAG = '_forkBoilerplate'

/** upstream fork child cap (报告 §3.3). */
export const FORK_SUBAGENT_MAX_ITERATIONS = 200

/**
 * Wall-clock budget for fork sub-agents (30 minutes).
 *
 * Without an explicit timeout on the FORK agent definition, `agentTool.ts`
 * applies the global background-subagent default
 * (`OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS`). 30 minutes matches the
 * foreground `DEFAULT_AGENT_TIMEOUT_MS` so foreground vs background fork
 * behave the same wall-clock-wise, and it gives forks enough headroom for
 * realistic workloads — forks routinely write large files, run long Bash,
 * or do multi-step implementation work, and were previously truncating
 * with `[Sub-agent stopped before completion (time limit or cancel)]`
 * before the work finished.
 *
 * Override per-call via the agent definition's `timeout` field; this is
 * just the FORK_AGENT default.
 */
export const FORK_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000

/** Cap inherited parent messages; keeps head + tail and summarizes the gap. */
export const MAX_FORKED_MESSAGES = 100

const HEAD_KEEP = 35
const TAIL_KEEP = 35

/**
 * Audit Bug A-1 (P0) — strip parent-side dynamic system-reminder injections
 * from the inherited transcript before handing it to the fork.
 *
 * Parent transcripts accumulate `user`-role messages whose `content` is a
 * `<system-reminder>` block produced by the agentic loop itself, NOT the
 * end user. Examples (all flagged with `_convertedFromSystem: true`):
 *   - "[Background sub-agents — new output]" deltas streamed back from
 *     OTHER sub-agents the parent spawned
 *   - Stop-hook blocking-error injections targeted at the parent
 *   - Pending tool-use summaries / synthetic tool_result pairings
 *
 * If we deep-clone these into the fork, the fork reads them as instructions
 * targeted at *itself* — the model has no way to tell the reminder was
 * aimed at the parent five turns ago. Symptoms include: fork trying to
 * consume background sub-agent output that belongs to the parent loop,
 * or fork "responding" to a stop-hook error the parent already handled.
 *
 * The flag-based filter is precise: every dynamic injection point in the
 * codebase tags its synthetic user message with `_convertedFromSystem`
 * (see `agenticLoop.ts`, `mainSubAgentContextInjection.ts`,
 * `agenticLoopHelpers.ts`, `ensureToolUseResultPairing.ts`,
 * `postCompactAttachments.ts`, `invokedSkillsRegistry.ts`,
 * `forkSubagent.ts` boilerplate envelope). Real user turns never carry it.
 *
 * Tool-use pairing is preserved because `_convertedFromSystem: true`
 * messages are always *standalone* synthetic turns — they never carry
 * `tool_result` blocks (which always live in the genuine user message
 * answering an assistant `tool_use`). Stripping them therefore cannot
 * orphan a `tool_use`.
 *
 * The fork's own boilerplate envelope is appended *after* this filter
 * (see {@link buildForkedMessages}), so it survives untouched.
 */
function isParentSystemNoiseMessage(m: Record<string, unknown>): boolean {
  if (!m || m.role !== 'user') return false
  if (m._convertedFromSystem !== true) return false
  // Defensive: never strip a message that carries tool_result blocks even
  // if it was somehow flagged — orphaning a tool_use causes a hard 400 at
  // the provider. Real `_convertedFromSystem` messages never contain
  // tool_result, but the check is cheap.
  const c = m.content
  if (Array.isArray(c)) {
    for (const b of c as Array<Record<string, unknown>>) {
      if (b && b.type === 'tool_result') return false
    }
  }
  return true
}

export function stripParentSystemNoiseFromForkInput(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.filter((m) => !isParentSystemNoiseMessage(m))
}

/**
 * Structured child-agent constraints (upstream-style; injected inside the boilerplate tag).
 */
export const CHILD_DIRECTIVES = `You are a child agent spawned by a parent agent. Obey all of the following:
1. Do not fork again — never call Agent without subagent_type or otherwise recurse into another fork.
2. Do not modify files outside the scope of your directive unless the parent explicitly required broader edits.
3. When you finish, reply with a concise structured summary: what you did, key findings, and any follow-ups for the parent.
4. Do not use AskUserQuestion — you cannot interact with the user directly; encode questions in your summary for the parent.
5. Prefer Read / Grep / Glob over Bash for file inspection; use Bash only when necessary for the task.
6. Stay within the tools and permissions available to your agent type; do not assume elevated access.
7. If blocked, report the blocker clearly so the parent can replan — do not fabricate results.
8. Do not send SendMessage to the end user; communicate only via your final output to the parent.
9. Keep outputs proportional to the ask — avoid huge dumps unless the parent asked for exhaustive detail.
10. Treat the directive after the boilerplate as the single source of task truth.`

export type ForkedMessagesBuildResult =
  | { ok: true; messages: Array<Record<string, unknown>>; strategy: ForkCacheStrategy }
  | { ok: false; error: string }

/**
 * Cache-friendliness strategy for fork message inheritance.
 *
 * **`'legacy'`** (default) — the historically-safe path:
 *   1. Strip parent-side dynamic `<system-reminder>` injections (Bug A-1).
 *   2. Deep-clone every retained message (Bug O9 isolation).
 *   3. Append the `<fork-boilerplate>` child-directive envelope as a final
 *      user message.
 *   Pros: fork never mis-reads parent-targeted reminders as its own
 *   directives, fork mutations cannot corrupt parent state mid-turn.
 *   Cons: the strip step removes user-role messages, so the JSON-serialised
 *   prefix sent to the provider differs from the prefix the parent sent
 *   on its last turn — Anthropic prompt-cache breakpoints will miss.
 *
 * **`'tight'`** (upstream §query/fork parity, opt-in via
 *   `POLE_FORK_CACHE_TIGHT=1`) — maximises prefix-cache hits:
 *   1. **Skip** the parent-system-noise strip — the fork sees the exact
 *      same `messages[]` the parent just sent on its previous turn, so
 *      the provider can reuse the cached prefix unchanged.
 *   2. **Skip** the per-message deep-clone — share refs with the parent.
 *      JSON serialisation is reference-agnostic, so this is purely a CPU
 *      win, not a correctness change.
 *   3. Append the same boilerplate envelope at the tail (this is the new
 *      `user` turn the cache is expected to "miss"; everything before
 *      stays cache-hot).
 *
 *   Trade-off: by NOT stripping parent reminders, a fork may read e.g.
 *   "[Background sub-agents — new output]" deltas or stop-hook error
 *   injections that were targeted at the parent. The model typically
 *   tolerates this because the boilerplate envelope at the end gives it
 *   a fresh, scoped directive — but it does increase the chance of fork
 *   mis-attribution. Opt in only when the cache savings matter more
 *   (e.g. very long parent transcripts with frequent forks).
 */
export type ForkCacheStrategy = 'legacy' | 'tight'

/** Read the cache-strategy preference from env. Defaults to `'legacy'`. */
export function readForkCacheStrategy(): ForkCacheStrategy {
  const raw = process.env.POLE_FORK_CACHE_TIGHT?.trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'tight') {
    return 'tight'
  }
  return 'legacy'
}

function messageContainsForkBoilerplate(m: Record<string, unknown>): boolean {
  // Bug F-1 fix: detect recursive fork via the metadata flag set on the
  // injected envelope, not via substring search of message content. The old
  // string check tripped any time the parent had read a file/tool result
  // containing the literal `<fork-boilerplate>` tag (e.g. `forkSubagent.ts`,
  // `docs/FORK_TEAM_*.md`, the user's own prompt discussing fork mechanics).
  return m[FORK_BOILERPLATE_FLAG] === true
}

/**
 * Deep clone a message (and its nested `content` array) so subsequent
 * mutations by parent/child are isolated. Audit Bug O9: the previous code
 * used `[...messages]` which left each message object (and its content
 * blocks) referenced by both parent and fork — a parent compaction /
 * thinking-strip / apiMessageInvariants mutation mid-fork would corrupt
 * the fork's transcript mid-turn.
 *
 * Uses `structuredClone` when available (Electron 20+ and Node 17+); falls
 * back to JSON roundtrip.
 */
function deepCloneMessage(
  m: Record<string, unknown>,
): Record<string, unknown> {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(m)
    }
  } catch {
    /* Fall through to JSON fallback — happens on objects with functions
     * / symbols / DOM nodes, none of which appear in API messages. */
  }
  try {
    return JSON.parse(JSON.stringify(m)) as Record<string, unknown>
  } catch {
    // Last-resort shallow copy; preserves previous behavior for payloads
    // that can't be serialized (e.g. circular refs — shouldn't happen).
    return { ...m }
  }
}

/**
 * Shallow-freeze a message envelope before handing it to a fork under
 * the `tight` strategy.
 *
 * Why: `tight` mode shares object refs between parent and fork to keep
 * the outbound JSON byte-identical for the Anthropic prompt cache. That
 * sharing is only sound if neither side mutates the message *envelope*
 * in place afterwards. The codebase currently treats messages as values
 * (all major normalisers — `normalizeMessagesForAPI`,
 * `ensureToolUseResultPairing` — do `{ ...m }` before any change), but
 * that's an unenforced convention. A future commit that adds something
 * like `state.messages.at(-1).cache_control = ...` would silently
 * corrupt forks under tight mode.
 *
 * `Object.freeze` turns any such accidental mutation into an immediate
 * `TypeError` (strict mode) or a no-op (sloppy mode) — either way the
 * fork's view is preserved. We freeze only the top-level envelope (not
 * the `content` array or its blocks) because:
 *   1. The known-safe normalisers all clone the envelope before touching
 *      content, so envelope-level freezing catches the realistic
 *      regression vector.
 *   2. Deep-freezing every content block would be O(messages × blocks)
 *      and defeat the cache-friendly cheapness of tight mode.
 *   3. The audit's Finding 6 (C) was explicitly about the envelope-level
 *      contract; content mutation has never been observed in practice.
 *
 * `legacy` mode deep-clones, so envelope freezing is unnecessary there.
 *
 * Note: `Object.freeze` is shallow and returns the same reference, so
 * byte-identity of the fork's outgoing JSON prefix vs the parent's most
 * recent request is preserved (Anthropic prompt cache still hits).
 */
function freezeForTightShare(m: Record<string, unknown>): Record<string, unknown> {
  // Idempotent — re-freezing a frozen object is a no-op and doesn't
  // throw, so re-fork or multi-fork scenarios are safe.
  if (!Object.isFrozen(m)) Object.freeze(m)
  return m
}

function sliceInheritedMessages(
  messages: Array<Record<string, unknown>>,
  strategy: ForkCacheStrategy = 'legacy',
): Array<Record<string, unknown>> {
  // `tight` strategy: keep shared refs — parent's transcript is treated
  // as effectively immutable for the fork's lifetime. We additionally
  // shallow-freeze each shared envelope so an accidental future mutation
  // surfaces as a `TypeError` instead of silently corrupting the fork
  // (audit Finding 6 — the contract was previously unenforced).
  // `legacy` strategy: deep-clone for isolation (no freeze needed).
  const transfer =
    strategy === 'tight'
      ? freezeForTightShare
      : deepCloneMessage

  if (messages.length <= MAX_FORKED_MESSAGES) {
    return messages.map(transfer)
  }
  const omitted = messages.length - HEAD_KEEP - TAIL_KEEP
  const summary: Record<string, unknown> = {
    role: 'user',
    content:
      omitted > 0
        ? `[Fork context truncated: ${omitted} intermediate messages omitted; retaining first ${HEAD_KEEP} and last ${TAIL_KEEP}.]`
        : '[Fork context truncated.]',
  }
  return [
    ...messages.slice(0, HEAD_KEEP).map(transfer),
    summary,
    ...messages.slice(-TAIL_KEEP).map(transfer),
  ]
}

/**
 * Build forked messages by inheriting the parent's conversation context.
 *
 * Returns an error when the parent transcript already contains a fork boilerplate (recursive fork).
 *
 * The cache strategy is chosen automatically from `POLE_FORK_CACHE_TIGHT`
 * unless explicitly overridden via the `strategy` argument (mostly used by
 * tests). See {@link ForkCacheStrategy} for the trade-offs.
 */
export function buildForkedMessages(
  forkPrompt: string,
  options?: { strategy?: ForkCacheStrategy },
): ForkedMessagesBuildResult {
  // FORK-01: reject empty/whitespace-only fork prompts to avoid
  // wasting resources on no-op forks.
  if (!forkPrompt || !forkPrompt.trim()) {
    return { ok: false, error: 'Fork requires a non-empty prompt.' }
  }
  const parentCtx = getAgentContext()
  if (!parentCtx || parentCtx.messages.length === 0) {
    return { ok: false, error: 'Fork requires a non-empty parent conversation.' }
  }

  if (parentCtx.messages.some(messageContainsForkBoilerplate)) {
    return {
      ok: false,
      error:
        'Recursive fork is not allowed: parent messages already contain a <fork-boilerplate> child directive.',
    }
  }

  const strategy: ForkCacheStrategy = options?.strategy ?? readForkCacheStrategy()

  // `legacy` strategy (Audit Bug A-1 P0): drop parent-only dynamic
  // system-reminder injections BEFORE truncation/cloning so the fork never
  // sees corrections, nudges, or background sub-agent output that were
  // aimed at the parent loop. Filtering before `sliceInheritedMessages`
  // keeps the head/tail window focused on real conversation turns instead
  // of letting noise consume scarce HEAD_KEEP / TAIL_KEEP slots.
  //
  // `tight` strategy (upstream §query/fork): intentionally SKIP the strip
  // so the fork's outbound JSON byte-matches the parent's most recent
  // request prefix → Anthropic prompt cache stays hot. See the strategy
  // doc for the correctness trade-off.
  const cleanedParentMessages =
    strategy === 'tight'
      ? parentCtx.messages
      : stripParentSystemNoiseFromForkInput(parentCtx.messages)

  if (cleanedParentMessages.length === 0) {
    return {
      ok: false,
      error:
        'Fork requires non-empty parent conversation after stripping system-only injections; ask the user a real question first.',
    }
  }

  const inherited = sliceInheritedMessages(cleanedParentMessages, strategy)

  // v1/H6 fix — wrap the child directive block in `<system-reminder>` and
  // tag the message `_convertedFromSystem` so:
  //   - The model reads the boilerplate as system-side identity guidance
  //     (the standing system prompt explicitly defines the tag's
  //     semantics) rather than as a fresh user statement clashing with
  //     "You are an interactive agent..." in the inherited system prompt.
  //   - Phantom-work / merge / smoosh passes correctly classify the
  //     boilerplate envelope.
  // The actual `forkPrompt` (the task) lives OUTSIDE the reminder tag so
  // it remains a real user instruction.
  const boilerplate = wrapSideChannelBody(
    SIDE_CHANNEL_KIND.forkBoilerplate,
    `${FORK_BOILERPLATE_TAG}\n${CHILD_DIRECTIVES}\n${FORK_BOILERPLATE_CLOSE}`,
  )
  const directiveBody = `${boilerplate}\n\n${forkPrompt}`

  // NB: the message body is a HYBRID — the `<system-reminder>` envelope on
  // the boilerplate is side-channel, but the trailing `forkPrompt` is a real
  // user task. We therefore do NOT set `_sideChannelKind` / `_convertedFromSystem`
  // on the wrapper message (would mislead downstream "drop side-channel" filters
  // into discarding the user task). The pre-existing `_forkBoilerplate: true`
  // is the canonical structural signal; consumers use `isFromForkBoilerplate(m)`.
  inherited.push({
    role: 'user',
    content: directiveBody,
    [FORK_BOILERPLATE_FLAG]: true,
  })

  return { ok: true, messages: inherited, strategy }
}

/**
 * Fork-specific prompt additions for the Agent tool description.
 * Appended when fork mode is enabled.
 */
export const FORK_PROMPT_SECTION = `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative — "will I need this output again" — not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork — a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the UI.

**Don't peek.** The tool result includes the fork's output — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives later; it is never something you write yourself.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.

**No recursive fork.** You cannot fork from inside a forked child — the tool will reject a second nested fork.
`

/**
 * Fork-specific examples for the Agent tool description.
 */
export const FORK_EXAMPLES = `

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this — it's a survey question.</thinking>
Agent({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist. Report a punch list — done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
</example>
`
