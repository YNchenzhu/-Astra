/**
 * Team trigger matcher — heuristic mapping from a user message to the
 * most-relevant `TeamTemplate` inside the currently active Bundle.
 *
 * Why this exists: `teamAutoLauncher.ts` can spawn a full multi-agent team
 * from a single template reference, but today the main AI has to decide
 * *which* template to use by reading a markdown listing injected into its
 * system prompt. Empirically, that markdown-driven discovery misses many
 * obvious matches — the AI falls back to "call Agent() one-by-one" or just
 * answers directly. This module injects a cheap, deterministic hint on the
 * top candidate so the AI at least gets a strong suggestion before deciding.
 *
 * Design notes:
 *   - **Pure function, no LLM call** — runs on every user turn and must
 *     cost microseconds. We use character-and-word overlap scoring that
 *     works reasonably for both CJK and Latin prompts without a tokenizer.
 *   - **Suggestion, not enforcement** — the main AI keeps full veto power.
 *     The feature flag `POLE_TEAM_AUTO_SUGGEST=1` gates only the injection;
 *     the auto-launch execution still requires the AI to call `TeamCreate`
 *     with `{ template }` (which itself needs `POLE_TEAM_AUTO_LAUNCH=1`).
 *   - **Multi-template bundles** — we return a ranked list so callers can
 *     either pick top-1 or show the top few.
 */

import type { TeamTemplate, TeamTrigger } from './bundles/types'

// ============================================================
// Feature flag
// ============================================================

const AUTO_SUGGEST_ENV_KEYS = ['POLE_TEAM_AUTO_SUGGEST', 'ASTRA_TEAM_AUTO_SUGGEST'] as const

export function isTeamAutoSuggestEnabled(): boolean {
  for (const k of AUTO_SUGGEST_ENV_KEYS) {
    const v = process.env[k]?.trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes') return true
  }
  return false
}

// ============================================================
// Tokenisation
// ============================================================

/**
 * Extract comparable surface-form tokens from a piece of text.
 *
 * Two token streams are returned:
 *   - `words`: whitespace / punctuation-split Latin words (≥ 2 chars, lowercased).
 *   - `cjkBigrams`: sliding 2-character windows over every CJK run, which
 *     gives a cheap bag-of-phrases for Chinese / Japanese without needing
 *     a real segmenter.
 *
 * Both streams are lowercased + deduped before return. The separation is
 * important: scoring weights them slightly differently (a Latin word match
 * is rarer + more specific than a single CJK bigram, so worth more).
 */
export interface TokenisedText {
  words: Set<string>
  cjkBigrams: Set<string>
}

/** Lowercased whole-word matcher (Latin). `-` sits at the end of the
 *  character class so it's literal — no escape needed. */
const WORD_RE = /[a-z0-9][a-z0-9_-]*/g

/**
 * Unicode ranges covering common CJK ideographs + Hiragana + Katakana +
 * full-width punctuation marks we treat as word boundaries. Ranges are
 * intentionally conservative — we only care about splitting "runs" for the
 * bigram builder, not full linguistic analysis.
 */
const CJK_RUN_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]+/g

export function tokenise(text: string): TokenisedText {
  const raw = (text ?? '').toLowerCase()
  const words = new Set<string>()
  for (const m of raw.matchAll(WORD_RE)) {
    if (m[0].length >= 2) words.add(m[0])
  }
  const cjkBigrams = new Set<string>()
  for (const m of raw.matchAll(CJK_RUN_RE)) {
    const run = m[0]
    if (run.length === 1) {
      cjkBigrams.add(run) // single char still counts as a trigger
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        cjkBigrams.add(run.slice(i, i + 2))
      }
    }
  }
  return { words, cjkBigrams }
}

function unionTokenise(parts: ReadonlyArray<string | undefined | null>): TokenisedText {
  const combined: TokenisedText = { words: new Set(), cjkBigrams: new Set() }
  for (const p of parts) {
    if (!p) continue
    const t = tokenise(p)
    for (const w of t.words) combined.words.add(w)
    for (const b of t.cjkBigrams) combined.cjkBigrams.add(b)
  }
  return combined
}

// ============================================================
// Scoring
// ============================================================

/** Per-template match result; exposed so callers can render explanations. */
export interface TemplateMatch {
  template: TeamTemplate
  score: number
  /** Latin word hits shared between user text and template surface. */
  matchedWords: string[]
  /** CJK bigram hits — paired + deduped. */
  matchedCjkBigrams: string[]
  /**
   * Set when the score came from a bundle-author-provided `TeamTrigger`
   * rule rather than the implicit token-overlap heuristic. Lets the hint
   * formatter say "matched author-defined rule" instead of fishing for
   * matched tokens that may not exist on the explicit path.
   */
  explicit?: {
    matchedKeywords: string[]
    matchedRegex: string[]
    /** True when the rule used `allKeywords` and every keyword was present. */
    allKeywordsSatisfied?: boolean
  }
}

/**
 * Implicit-path weighting (unchanged): word hits matter ~3× a single bigram
 * hit (because bigrams are lower-entropy).
 */
const WORD_WEIGHT = 3
const CJK_BIGRAM_WEIGHT = 1

/**
 * Explicit-path weighting (NEW). One author-declared keyword / regex hit
 * scores high enough that an explicit single-hit beats virtually any
 * implicit token spray — the bundle author's intent dominates. Bumped to
 * 100 (vs implicit ~3-5 per hit) to make the priority unambiguous in
 * sorted output and avoid "implicit happens to find more tokens" upsets.
 */
const EXPLICIT_HIT_WEIGHT = 100
/** `allKeywords` clauses earn this base bonus once they are fully satisfied. */
const EXPLICIT_ALL_KEYWORDS_BONUS = 50

/** Tunable threshold. Values below this score are dropped. */
export const TEAM_SUGGEST_MIN_SCORE = 2

/**
 * Build a per-template surface: everything the user might plausibly mention
 * when describing a task that maps to this template.
 *
 * Includes `id`, `name`, `description`, each member's `agentType` + `role`.
 * Kept outside `matchTeamTrigger` so tests can override it if needed.
 */
function templateSurface(template: TeamTemplate): TokenisedText {
  const parts: Array<string | undefined> = [
    template.id,
    template.name,
    template.description,
  ]
  for (const m of template.members ?? []) {
    parts.push(m.agentType)
    parts.push(m.role)
  }
  return unionTokenise(parts)
}

/**
 * Compile a regex string into a RegExp safely. Unparseable patterns are
 * skipped (returning `null`) — bundle authors shouldn't be able to crash
 * the matcher with a typo. Cached per call site (the closure here) — the
 * outer `evaluateExplicitTriggers` rebuilds each call, which is fine
 * because user message changes every turn anyway.
 */
function safeCompileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

interface ExplicitEvalResult {
  score: number
  vetoed: boolean
  matchedKeywords: string[]
  matchedRegex: string[]
  allKeywordsSatisfied?: boolean
}

/**
 * Evaluate ONE `TeamTrigger` rule against the lowercased user text.
 * `excludeKeywords` is checked first — any hit immediately vetoes the
 * whole rule (score 0, regardless of other matches). After veto, the
 * function combines per-rule fields with AND semantics.
 *
 * The function's contract is local to this module — it does not normalize
 * the rule itself (callers pass post-normalize triggers from
 * `bundleSerialize`), and it does not do template-surface scoring.
 */
function evaluateOneTrigger(rule: TeamTrigger, userTextLower: string): ExplicitEvalResult {
  const out: ExplicitEvalResult = {
    score: 0,
    vetoed: false,
    matchedKeywords: [],
    matchedRegex: [],
  }

  // 1. Exclusion check (highest priority, immediate veto).
  if (rule.excludeKeywords && rule.excludeKeywords.length > 0) {
    for (const ex of rule.excludeKeywords) {
      if (userTextLower.includes(ex.toLowerCase())) {
        out.vetoed = true
        return out
      }
    }
  }

  // 2. allKeywords gate — every entry must appear, otherwise rule scores 0.
  if (rule.allKeywords && rule.allKeywords.length > 0) {
    let allHit = true
    for (const k of rule.allKeywords) {
      if (!userTextLower.includes(k.toLowerCase())) {
        allHit = false
        break
      }
    }
    if (!allHit) {
      // Without allKeywords satisfied, regular `keywords` / `regex` matches
      // can still contribute — but the all-bonus is forfeit. We KEEP scanning
      // them so a rule like `{ allKeywords: [...], keywords: [...] }` can
      // partially match via the loose path; the bundle author can force the
      // strict semantic by using `allKeywords` without `keywords`.
      out.allKeywordsSatisfied = false
    } else {
      out.allKeywordsSatisfied = true
      out.matchedKeywords.push(...rule.allKeywords)
      out.score += EXPLICIT_ALL_KEYWORDS_BONUS + rule.allKeywords.length * EXPLICIT_HIT_WEIGHT
    }
  }

  // 3. Loose keywords — each unique hit adds `EXPLICIT_HIT_WEIGHT`.
  if (rule.keywords && rule.keywords.length > 0) {
    const seen = new Set<string>()
    for (const k of rule.keywords) {
      const lower = k.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      if (userTextLower.includes(lower)) {
        out.matchedKeywords.push(k)
        out.score += EXPLICIT_HIT_WEIGHT
      }
    }
  }

  // 4. Regex — same scoring per match.
  if (rule.regex && rule.regex.length > 0) {
    for (const pattern of rule.regex) {
      const re = safeCompileRegex(pattern)
      if (!re) continue
      if (re.test(userTextLower)) {
        out.matchedRegex.push(pattern)
        out.score += EXPLICIT_HIT_WEIGHT
      }
    }
  }

  // 5. minConfidence gate. Default 1 — any positive score wins. Bundle
  // authors raise it when they want a stricter rule like "needs ≥ 3 hits".
  const minC = typeof rule.minConfidence === 'number' ? rule.minConfidence : 1
  if (out.score < minC) {
    out.score = 0
  }

  return out
}

interface ExplicitTemplateOutcome {
  /** Best scoring (non-vetoed) rule, or null when no rule scored. */
  best: ExplicitEvalResult | null
  /**
   * True when AT LEAST ONE rule fired its veto (excludeKeywords hit).
   * The author has explicitly told us "don't use this template in this
   * case" — the matcher honours that and skips the implicit fallback,
   * even if the template surface tokens happen to overlap.
   */
  anyVetoed: boolean
}

/**
 * Evaluate ALL triggers on a template. Two-channel outcome:
 *
 *   - `best` holds the highest-scoring rule that scored > 0.
 *   - `anyVetoed` is set whenever ONE OR MORE rules' `excludeKeywords`
 *     fired — bundle authors use that to say "absolutely not in this
 *     situation", which should trump implicit token similarity (otherwise
 *     a template's own surface tokens can sneak it back in via the
 *     fallback path, defeating the point of excludeKeywords).
 */
function evaluateExplicitTriggers(
  template: TeamTemplate,
  userTextLower: string,
): ExplicitTemplateOutcome {
  if (!template.triggers || template.triggers.length === 0) {
    return { best: null, anyVetoed: false }
  }
  let best: ExplicitEvalResult | null = null
  let anyVetoed = false
  for (const rule of template.triggers) {
    const r = evaluateOneTrigger(rule, userTextLower)
    if (r.vetoed) {
      anyVetoed = true
      continue
    }
    if (r.score <= 0) continue
    if (best === null || r.score > best.score) {
      best = r
    }
  }
  return { best, anyVetoed }
}

/**
 * Rank every template in `teams` by relevance to `userText`. Returns a
 * descending-score array; callers usually want `.slice(0, 1)` for a top-1
 * hint, but we expose the full ranking for debugging + future "maybe you
 * also want…" UIs.
 *
 * Two scoring paths:
 *
 *   - **Explicit** — when a template declares `triggers: TeamTrigger[]`,
 *     the bundle-author-provided rules dominate. Hits score with
 *     `EXPLICIT_HIT_WEIGHT` so an explicit-matched template always sorts
 *     above any implicit-matched template. Author intent wins.
 *   - **Implicit (legacy fallback)** — when `triggers` is absent OR all
 *     declared triggers scored 0, the matcher falls back to token-overlap
 *     against `id`/`name`/`description`/member surface. This keeps every
 *     pre-existing bundle working without a schema migration.
 *
 * Ties broken by the template's position in `teams` (stable sort preserves order).
 */
export function matchTeamTrigger(
  userText: string,
  teams: ReadonlyArray<TeamTemplate>,
): TemplateMatch[] {
  if (!userText || userText.trim().length === 0) return []
  if (!Array.isArray(teams) || teams.length === 0) return []

  const userTextLower = userText.toLowerCase()
  const userTokens = tokenise(userText)
  const noUserTokens =
    userTokens.words.size === 0 && userTokens.cjkBigrams.size === 0

  const scored: TemplateMatch[] = []
  for (const template of teams) {
    // ── Explicit path ──
    const { best: explicit, anyVetoed } = evaluateExplicitTriggers(template, userTextLower)
    if (explicit) {
      scored.push({
        template,
        score: explicit.score,
        matchedWords: [],
        matchedCjkBigrams: [],
        explicit: {
          matchedKeywords: explicit.matchedKeywords,
          matchedRegex: explicit.matchedRegex,
          ...(explicit.allKeywordsSatisfied !== undefined
            ? { allKeywordsSatisfied: explicit.allKeywordsSatisfied }
            : {}),
        },
      })
      continue
    }

    // Author said "definitely not in this case" — skip implicit fallback so
    // template surface tokens can't sneak the template back in.
    if (anyVetoed) continue

    // ── Implicit fallback path ──
    if (noUserTokens) continue
    const surface = templateSurface(template)
    const matchedWords: string[] = []
    for (const w of userTokens.words) {
      if (surface.words.has(w)) matchedWords.push(w)
    }
    const matchedCjkBigrams: string[] = []
    for (const b of userTokens.cjkBigrams) {
      if (surface.cjkBigrams.has(b)) matchedCjkBigrams.push(b)
    }
    const score =
      matchedWords.length * WORD_WEIGHT + matchedCjkBigrams.length * CJK_BIGRAM_WEIGHT
    if (score > 0) {
      scored.push({ template, score, matchedWords, matchedCjkBigrams })
    }
  }

  return scored
    .filter((m) => m.score >= TEAM_SUGGEST_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
}

/**
 * Build the Markdown snippet the stream-handler injects into the main AI's
 * system prompt when `POLE_TEAM_AUTO_SUGGEST=1` is on AND there is at least
 * one qualifying match.
 *
 * Deliberately concise + actionable: name the top template, surface why it
 * matched, and spell out the single tool call needed to accept the hint.
 * The AI still chooses whether to accept — we never bypass its judgement.
 */
export function formatSuggestionHint(
  userText: string,
  matches: TemplateMatch[],
): string | null {
  if (matches.length === 0) return null
  const top = matches[0]!
  const reasons: string[] = []
  if (top.explicit) {
    if (top.explicit.matchedKeywords.length > 0) {
      reasons.push(
        `作者声明关键词: ${top.explicit.matchedKeywords.slice(0, 5).map((w) => `\`${w}\``).join(' · ')}`,
      )
    }
    if (top.explicit.matchedRegex.length > 0) {
      reasons.push(
        `作者声明正则: ${top.explicit.matchedRegex.slice(0, 3).map((r) => `\`${r}\``).join(' · ')}`,
      )
    }
    if (top.explicit.allKeywordsSatisfied) {
      reasons.push('严格关键词集 (allKeywords) 已全部满足')
    }
  } else {
    if (top.matchedWords.length > 0) {
      reasons.push(`共现关键词: ${top.matchedWords.slice(0, 5).map((w) => `\`${w}\``).join(' · ')}`)
    }
    if (top.matchedCjkBigrams.length > 0) {
      reasons.push(
        `中文关键词: ${top.matchedCjkBigrams.slice(0, 5).map((w) => `\`${w}\``).join(' · ')}`,
      )
    }
  }
  const others =
    matches.length > 1
      ? `\n\n次选模板（按相关性）:\n${matches
          .slice(1, 4)
          .map((m) => `- \`${m.template.id}\` / ${m.template.name} (score ${m.score}${m.explicit ? ', explicit' : ''})`)
          .join('\n')}`
      : ''

  void userText // reserved for future heuristics; currently only matches drive the hint
  const confidenceTag = top.explicit ? '高置信度（作者显式规则命中）' : '启发式匹配（隐式相似度）'
  return [
    '### Team template suggestion (auto-detected)',
    '',
    `根据用户本轮消息，推荐优先使用团队模板 **${top.template.name}** (id \`${top.template.id}\`, score ${top.score}, ${confidenceTag})。`,
    '',
    `**命中依据**: ${reasons.join(' · ') || '(综合匹配)'}`,
    '',
    '**使用方式**:',
    '```',
    `TeamCreate({ team_name: "<your-name>", template: "${top.template.id}", description: "<restate user goal>" })`,
    '```',
    'This is advisory — if the user intent clearly diverges from the template, ignore this hint and proceed normally.',
    others,
  ].join('\n')
}
