/**
 * Declared-intent guard — 2026-06 multi-turn degradation fix (root cause 5 / P2).
 *
 * Failure mode: in long conversations (~13-18 rounds) the model emits a
 * no-tool-use turn whose text DECLARES future work ("我现在开始修改 X" /
 * "Let me now run the tests") and then stops. The no-tool decision table
 * (`iterationDecision.ts` row 13) treated that as a benign `completed`
 * termination because the only continuation interceptor —
 * `activeTodoPanelGuard` — requires the model to have an active TodoWrite
 * panel, which is exactly the discipline a degraded model drops first.
 *
 * This guard adds a deterministic, host-side check on the FINAL portion
 * of the assistant text. When the tail announces an imminent action and
 * the turn produced no tool_use, the loop continues ONCE with a
 * side-channel directive: execute now, or explicitly tell the user why
 * not. One-shot per stall episode (`state.declaredIntentNudgeCount`,
 * reset only after a successful tool batch — see `iteration.ts`) so a
 * model that genuinely wants to stop can still stop on the next iteration
 * — no infinite nudge loop, no interference with the stall guard or the
 * stop-hook circuit breaker (both rank higher in the decision table).
 *
 * Deliberately conservative:
 *   - Only the tail (last {@link INTENT_TAIL_WINDOW_CHARS} chars) is
 *     scanned — an intent phrase in the middle of a long answer is
 *     usually narration, not a dangling commitment.
 *   - A tail that ends with a question is exempt: asking the user
 *     something and ending the turn is correct behaviour.
 *   - Completion-style tails ("已完成" / "done") are exempt — those are
 *     P3's territory (claim downgrade), not P2's.
 *
 * Disable via `POLE_DECLARED_INTENT_GUARD=0`.
 */

/** Marker for tests / telemetry greps. */
export const DECLARED_INTENT_MARKER = '[Declared intent without action — host check]'

export const INTENT_TAIL_WINDOW_CHARS = 240

/**
 * Chinese action verbs shared by the intent patterns below. 2026-07
 * screenshot fix ("现在修正：" slipped through): the original list missed
 * 修正/实施/补充/调整/完善/优化 — the most common editing verbs after 修改.
 */
const CN_ACTION_VERBS =
  '开始|进行|执行|实施|修改|修正|创建|实现|编写|运行|继续|处理|修复|检查|分析|调整|补充|完善|优化'

/** Future-intent phrasings (Chinese + English), tail-scanned. */
const INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // 中文：我现在/马上/这就/接下来 + 动作动词；让我(们)先/来…；下一步…
  new RegExp(`我(?:现在|马上|这就|立刻|接下来|随后)(?:就|会|将|去|来)?(?:${CN_ACTION_VERBS})`),
  new RegExp(`(?:让我|我先|我来|我去|我将|我会)(?:[^，。！？\\n]{0,12})?(?:${CN_ACTION_VERBS}|读取|查看)`),
  /(?:下一步|接下来)(?:我)?(?:将|会|是|要)/,
  // 2026-07 screenshot fix — 现在/马上/立刻 + 动词直连（"现在修正"、
  // "马上补充"），不再强制要求中间的 开始|来|就。
  new RegExp(`(?:现在|马上|立刻|这就)(?:开始|来|就)?(?:${CN_ACTION_VERBS})`),
  // English: "I'll now…", "Let me…", "I'm going to…", "Next, I will…"
  /\b(?:I[' ]?(?:ll|will)|I am going to|I'm going to)\s+(?:now\s+)?(?:start|begin|run|edit|modify|create|implement|write|fix|update|execute|proceed|read|check|analyze)/i,
  /\b[Ll]et me\s+(?:now\s+)?(?:start|begin|run|edit|modify|create|implement|write|fix|update|execute|proceed|read|check)/,
  /\b[Nn]ow I[' ]?(?:ll|will)\b/,
  /\b[Nn]ext,?\s+I[' ]?(?:ll|will)\b/,
]

/**
 * Dangling-colon tail (2026-07 screenshot fix, language-agnostic layer).
 *
 * A reply whose LAST visible characters are a colon (full- or half-width,
 * optionally followed by markdown closers like `**` / quotes) announced
 * "content follows" — and nothing followed. This is a typographic signal,
 * not a semantic one: it works for "现在修正：", "Fix below:", "修正方案：",
 * and any language that uses a colon to introduce content, with no verb
 * enumeration needed. Exemptions run FIRST (a question or completion tail
 * still ends the turn), and the rule applies only to the user-VISIBLE
 * text: thinking routinely ends with a colon right before composing the
 * visible reply, so scanning thinking with this rule would false-positive.
 */
const DANGLING_COLON_TAIL_PATTERN = /[：:][\s*_`~"'”’」』】\])）>]*$/

/**
 * Question / clarification tails — the model is asking the USER something and
 * ending the turn is correct behaviour. Factored out so other guards (e.g. the
 * active-todo panel guard) can share the SAME "is this a genuine question to
 * the user?" check without inheriting the completion-claim exemption below.
 */
const QUESTION_TAIL_PATTERNS: ReadonlyArray<RegExp> = [
  /[?？]\s*$/, // asking the user something
  /(?:是否|要不要|需要我|可以吗|确认|请告诉我|请确认|let me know|should I|do you want|would you like)/i,
]

/** Completion-claim tails — "done" statements end a turn (P3's territory). */
const COMPLETION_TAIL_PATTERN =
  /(?:已完成|已全部完成|完成了|已修复|已处理|all done|completed|finished)[^\n]{0,40}$/i

/** Tails that legitimately end a turn even when an intent phrase matched. */
const EXEMPT_TAIL_PATTERNS: ReadonlyArray<RegExp> = [
  ...QUESTION_TAIL_PATTERNS,
  COMPLETION_TAIL_PATTERN,
]

/**
 * 2026-07 uplift #16 — reply-composition phrasings, exempted ONLY for the
 * `'thinking'` scan source. A thinking tail like "让我组织一下回答" / "Now
 * I'll write the response" announces writing the VISIBLE REPLY, not tool
 * work. Routing it through the declared-intent guard (row 12b) issues the
 * wrong directive ("execute the announced action with tools"); the
 * thinking-only silent-turn guard (row 12e, "surface your answer") is the
 * correct handler and sits right below 12b in the decision table — so
 * exempting here simply lets the turn fall through to it. Visible-text
 * tails keep the original behaviour: announcing "I'll write the summary"
 * in the USER-VISIBLE reply and then stopping IS a dangling commitment.
 */
const THINKING_REPLY_COMPOSITION_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:组织|整理|撰写|起草|输出|给出)(?:一下|好)?(?:最终)?(?:回答|回复|答复|总结|答案|报告)/,
  /(?:开始|现在)?(?:写|说)(?:出)?(?:最终)?(?:回答|回复|总结|结论)/,
  /\b(?:write|draft|compose|formulate|craft|give|provide)\s+(?:up\s+)?(?:the\s+|my\s+|a\s+)?(?:final\s+)?(?:answer|reply|response|summary|report)\b/i,
  /\b(?:summarize|summarise|respond)\b[^\n]{0,40}$/i,
]

/**
 * `true` when the FINAL portion of `text` is a genuine question / clarification
 * request to the user (NOT a completion claim). Shared by the active-todo
 * panel guard so a clarifying question yields the turn back to the user even
 * with open todos — symmetric with the declared-intent guard's question
 * exemption. Exported for tests.
 */
export function isUserQuestionTail(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const tail = t.slice(-INTENT_TAIL_WINDOW_CHARS)
  return QUESTION_TAIL_PATTERNS.some((re) => re.test(tail))
}

/**
 * `true` when the FINAL portion of `text` matches any exempting tail
 * (question to the user OR completion claim). Used by the noTools caller
 * to suppress the thinking-tail scan when the VISIBLE reply already ends
 * the turn legitimately — a thinking commitment must never override a
 * correct "ask the user / report done" visible ending. Exported for tests.
 */
export function hasExemptDeclaredIntentTail(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const tail = t.slice(-INTENT_TAIL_WINDOW_CHARS)
  return EXEMPT_TAIL_PATTERNS.some((re) => re.test(tail))
}

export function isDeclaredIntentGuardEnabled(): boolean {
  const raw = process.env.POLE_DECLARED_INTENT_GUARD?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Pure detection: does the FINAL portion of `accumulatedText` announce an
 * imminent action without an exempting tail? Exported for tests.
 *
 * 2026-07 uplift #16 — `source` tells the detector where the text came
 * from. `'text'` (default) is the user-visible reply: original behaviour,
 * unchanged. `'thinking'` scans a chain-of-thought tail: same intent
 * patterns and exemptions PLUS the reply-composition exemption ("让我组织
 * 一下回答" / "now I'll write the response"), because inside thinking that
 * phrasing announces composing the visible reply — the thinking-only
 * silent-turn guard's territory, not a dangling tool commitment.
 */
export function detectDeclaredIntentTail(
  accumulatedText: string,
  source: 'text' | 'thinking' = 'text',
): boolean {
  const text = accumulatedText.trim()
  if (!text) return false
  const tail = text.slice(-INTENT_TAIL_WINDOW_CHARS)
  if (EXEMPT_TAIL_PATTERNS.some((re) => re.test(tail))) return false
  if (
    source === 'thinking' &&
    THINKING_REPLY_COMPOSITION_PATTERNS.some((re) => re.test(tail))
  ) {
    return false
  }
  // Language-agnostic layer: a visible reply ending on a colon promised
  // content that never arrived ("现在修正：" / "The fix:"). Visible text
  // only — thinking naturally ends with a colon before reply composition.
  if (source === 'text' && DANGLING_COLON_TAIL_PATTERN.test(tail)) return true
  return INTENT_PATTERNS.some((re) => re.test(tail))
}

/**
 * Directive body injected as a `<system-reminder>` side-channel message
 * (the caller wraps it via `injectSideChannelKind`, same plumbing as the
 * active-todo guard, so smoosh / compact / detection treat it as host
 * context rather than user speech).
 */
export function buildDeclaredIntentDirective(): string {
  return (
    `${DECLARED_INTENT_MARKER}\n\n` +
    `Your last reply announced an action you were about to take, but the turn ` +
    `ended without any tool call. Pick exactly one:\n` +
    `  (a) execute the announced action NOW by calling the appropriate tool(s) — ` +
    `do not re-describe the plan; or\n` +
    `  (b) if you cannot or should not execute it, say so explicitly and tell ` +
    `the user what is blocking you.\n\n` +
    `Never describe work as in progress or finished without tool evidence in ` +
    `this conversation.`
  )
}
