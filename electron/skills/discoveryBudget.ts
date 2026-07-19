/**
 * Centralized character/token budget for skill-related prompt injection.
 *
 * Audit fix S-4 (2026-05) — previously these budgets were sprinkled
 * across three files as defaulted function parameters:
 *   - `skillDiscovery.buildSkillDiscoveryInjection` topK=5, maxChars=5500, promptPreviewChars=380
 *   - `skillTool.computeCompactSkillIndexPrompt` — no caps
 *   - `subAgentSkillPreload` MAX_SKILL_BODY_CHARS=12_000
 *   - `invokedSkillsRegistry` content slice 8_000
 * Reading any one site told the reader nothing about total context
 * spend on skill injection. upstream (`tools/SkillTool/prompt.ts:20-41`)
 * solves the same problem by pinning a single "% of context window"
 * formula plus per-entry caps in one place. We do the same here so the
 * Skill subsystem's worst-case token footprint is auditable at a glance.
 *
 * Tunable at runtime via env vars (mainly for tests and forced limits).
 */

export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
/** Fallback when no context window is supplied: 1% of 200k × 4 chars/token. */
export const DEFAULT_CHAR_BUDGET = 8_000

/** Hard cap per skill description in a listing — discovery, not body. */
export const MAX_LISTING_DESC_CHARS = 250

/** Skill body preview length in `<skill-discovery>` follow-up injection. */
export const DISCOVERY_PROMPT_PREVIEW_CHARS = 380

/** Default top-K for discovery (both initial and follow-up). */
export const DISCOVERY_TOP_K = 5

/**
 * Minimum combined score to include a skill in automatic injection.
 *
 * Calibration 2026-07 (`skillDiscovery.ts#_scoreSkillsForCalibration`,
 * 45-skill workspace, 7 code + 4 doc queries): the old 0.08 floor was
 * dead — CJK unigram/bigram overlap gives EVERY doc-heavy skill a
 * score of 5–17 against any Chinese query, so pure-code tasks injected
 * doc/PPT/bid skills every turn. Genuinely relevant skills scored
 * 8–36. A flat floor alone cannot separate the two bands (they
 * overlap), hence the dominance gate below.
 */
export const DISCOVERY_INJECTION_MIN_SCORE = 8

/**
 * Dominance gate: a skill is only injected when its score is at least
 * this multiple of the (lower) median positive score for the same
 * query. Rationale from the same calibration run: when a query truly
 * matches a skill, that skill towers over the pack (doc-bid: 36 vs
 * median ~7; doc-arch: 31 vs ~8). Pure-code queries produce a FLAT
 * profile (top ≈ 15–18, median ≈ 7 — common-character inflation lifts
 * everything evenly) where nothing dominates, so nothing is injected
 * and the model falls back to the explicit `DiscoverSkills` tool.
 * floor=8 + ratio=2.5 scored: code-task noise 8→0 injections across
 * the probe set while keeping every strong true match.
 */
export const DISCOVERY_DOMINANCE_MEDIAN_RATIO = 2.5

/** Hard cap on preloaded skill body bytes injected into sub-agent prompts. */
export const PRELOADED_SKILL_BODY_MAX_CHARS = 12_000

/**
 * Skill-resource attention uplift (2026-07) — bounded per-file hint for
 * `references/` docs. The B2 contract (bodies stay on disk) starved the
 * model of any signal about WHAT a reference contains, so it rarely chose
 * to read one. A one-line hint (first heading / first prose line) restores
 * the selection signal at ~120 chars/file resident cost.
 */
export const REFERENCE_HINT_MAX_CHARS = 120
/** Max reference files that get a hint (and a listing row) per skill. */
export const MAX_HINTED_REFERENCES = 20
/** Bytes read from the head of each reference file for hint extraction. */
export const REFERENCE_HINT_READ_BYTES = 2_048

/**
 * Modular-router skills (2026-07) — cap on doc files collected from
 * NON-standard first-level subdirectories (e.g. `common/`, `modules/` in
 * bidding-writer-pro-style skills). These skills route via relative paths
 * in the SKILL.md body instead of `references/`; the host must still
 * surface them (path + hint) or the whole resource-attention layer goes
 * blind for this skill shape.
 */
export const MAX_RESOURCE_DOCS = 40

/**
 * Hard cap on the `content` field recorded into the invoked-skills
 * registry for compaction reinjection. Lower than fork/inline body cap
 * because the reinjection is metadata-style — full body is recoverable
 * by re-reading SKILL.md.
 */
export const INVOKED_SKILL_CONTENT_MAX_CHARS = 8_000

/**
 * Returns the character budget for an injection block given the model's
 * context window. upstream parity (`prompt.ts:31-41`): an explicit env
 * override wins, otherwise scale to 1% of the window, otherwise fall
 * back to the 8k default.
 */
export function getSkillCharBudget(contextWindowTokens?: number): number {
  const envOverride = Number(process.env.POLE_SKILL_CHAR_BUDGET)
  if (Number.isFinite(envOverride) && envOverride > 0) {
    return envOverride
  }
  if (contextWindowTokens && contextWindowTokens > 0) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

/**
 * Audit fix S-5 (2026-05) — `POLE_SKILL_DISCOVERY_PREFETCH` previously
 * gated only the first-turn injection in `preModel.ts`; the per-tool
 * follow-up injection in `toolExec.ts` always ran regardless. That left
 * operators thinking they could silence skill auto-discovery via the
 * `..._PREFETCH` env var while the noisier per-turn site kept running.
 *
 * The two flags now have explicit, separately-documented semantics:
 *   - `POLE_SKILL_DISCOVERY_PREFETCH` — opt-in (default OFF) for the
 *     turn-1 prefetch in `preModel.ts`. Untouched by this audit, kept
 *     so existing `promptInjectionBudget.test.ts` assertions still pass.
 *   - `POLE_SKILL_DISCOVERY_FOLLOWUP` — opt-out (default ON) for the
 *     per-tool follow-up injection in `toolExec.ts`. Set to `0`/`false`/
 *     `off`/`no` to disable; explicit `DiscoverSkills` tool stays usable.
 */
export function isSkillDiscoveryFollowUpEnabled(): boolean {
  const raw = process.env.POLE_SKILL_DISCOVERY_FOLLOWUP?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}
