/**
 * Recall-pipeline tuning constants — single source of truth.
 *
 * All knobs that previously lived as scattered `const FOO = 6` near their
 * point of use (recallPipeline.ts, embeddingRecall.ts, findRelevantMemories.ts,
 * memoryPrompt.ts, retrievalPrefetch.ts, vectorStore.ts, subAgentRunner.ts)
 * are now centralised here. Each knob has:
 *
 *   - a hard-coded fallback (the historical default that shipped before
 *     the audit)
 *   - an optional disk-settings override (read fresh per call, so settings
 *     UI changes take effect immediately without restart)
 *   - a documented sane range — any out-of-range value is clamped, not
 *     thrown, so a hand-edited settings.json never DoSes the pipeline
 *
 * Keep this file dependency-light — it must be safe to import from
 * worker_threads (subAgentRunner sub-modules), the renderer-side type-only
 * imports, and the main process. The only allowed import is settingsAccess
 * which itself is dependency-light.
 */

import { readDiskSettings } from '../settings/settingsAccess'

interface RawSettings {
  // Existing
  memoryAiRecallEnabled?: boolean
  memoryHybridRecallEnabled?: boolean
  memoryFreshnessWeight?: number
  // New (this audit pass)
  memoryRecallMinScore?: number
  memoryRecallSkipShortQueryChars?: number
  memoryRecallTopK?: number
  memoryRecallMaxBytes?: number
  memoryRecallSessionBudgetBytes?: number
  workspaceContextEnabled?: boolean
  workspaceContextTopK?: number
  workspaceContextMinScore?: number
  attachmentContextTopK?: number
  attachmentContextMinScore?: number
}

export interface RecallTuning {
  /**
   * Final number of memories injected into the prompt. Replaces the
   * historical MAX_RELEVANT (8 in embeddingRecall.ts, 5 in
   * findRelevantMemories.ts, FINAL_TOP=8 in recallPipeline.ts).
   */
  memoryTopK: number
  /**
   * Cosine floor for any retrieval result (memory vector / workspace /
   * attachment). Hits below this are dropped, not just demoted. The
   * default 0.30 reflects BGE-M3 measured "relevant vs noise" boundary.
   * Setting to 0 restores legacy behaviour (return everything regardless
   * of relevance).
   */
  minScore: number
  /**
   * Skip the entire retrieval pipeline when the trimmed user query is
   * shorter than this. Stops `ok` / `继续` / `谢谢` from paying for an
   * embed forward pass + RRF + LLM selector that was never going to find
   * anything useful.
   */
  skipShortQueryChars: number
  /**
   * Per-recall character budget for the assembled "Recalled Memories"
   * section. Replaces MAX_RECALL_PROMPT_CHARS (24_000).
   */
  recallMaxChars: number
  /**
   * Session-level (per-conversation) byte budget. Once exceeded, further
   * memory recall in the same conversation is silently skipped. Replaces
   * MAX_SESSION_RECALL_BYTES (32_000).
   */
  sessionBudgetBytes: number
  /** Workspace semantic search master switch. */
  workspaceEnabled: boolean
  /** Workspace top-K (per query) — replaces hard-coded 6 in retrievalPrefetch.ts. */
  workspaceTopK: number
  /** Workspace cosine floor. */
  workspaceMinScore: number
  /** Attachment top-K. */
  attachmentTopK: number
  /** Attachment cosine floor. */
  attachmentMinScore: number
}

const DEFAULTS: RecallTuning = {
  memoryTopK: 5,
  minScore: 0.30,
  skipShortQueryChars: 10,
  recallMaxChars: 24_000,
  sessionBudgetBytes: 32_000,
  workspaceEnabled: true,
  workspaceTopK: 6,
  workspaceMinScore: 0.30,
  attachmentTopK: 6,
  attachmentMinScore: 0.30,
}

/** Inclusive clamp; NaN → fallback. */
function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/**
 * Read tuning from disk. Cheap (settings access is in-memory cached) so
 * callers may invoke per call without paying for IO.
 */
export function getRecallTuning(): RecallTuning {
  const s = readDiskSettings() as RawSettings
  return {
    memoryTopK: clamp(s.memoryRecallTopK, 1, 50, DEFAULTS.memoryTopK),
    minScore: clamp(s.memoryRecallMinScore, 0, 1, DEFAULTS.minScore),
    skipShortQueryChars: clamp(
      s.memoryRecallSkipShortQueryChars, 0, 200, DEFAULTS.skipShortQueryChars,
    ),
    recallMaxChars: clamp(s.memoryRecallMaxBytes, 1_000, 200_000, DEFAULTS.recallMaxChars),
    sessionBudgetBytes: clamp(
      s.memoryRecallSessionBudgetBytes, 1_000, 1_000_000, DEFAULTS.sessionBudgetBytes,
    ),
    workspaceEnabled: s.workspaceContextEnabled !== false,
    workspaceTopK: clamp(s.workspaceContextTopK, 1, 50, DEFAULTS.workspaceTopK),
    workspaceMinScore: clamp(s.workspaceContextMinScore, 0, 1, DEFAULTS.workspaceMinScore),
    attachmentTopK: clamp(s.attachmentContextTopK, 1, 50, DEFAULTS.attachmentTopK),
    attachmentMinScore: clamp(s.attachmentContextMinScore, 0, 1, DEFAULTS.attachmentMinScore),
  }
}

/**
 * Heuristic: should this query bypass retrieval entirely?
 *
 * Returns true for:
 *   - Empty / whitespace-only queries.
 *   - Sub-`skipShortQueryChars` queries (`ok`, `继续`, `谢谢`, `nice`,
 *     `continue`, `go ahead`, `thanks`, `好的`, `没问题`, …). The 2026-05
 *     bump from 8 → 10 chars sweeps up most trivial conversational
 *     phrases without needing a phrase list.
 *   - Slash-commands (`/clear`, `/memory list`, `/help`, …) — these are
 *     command intent, not semantic intent.
 *   - Pure punctuation / single emoji.
 *
 * False otherwise (i.e. the query gets the full prefetch pipeline).
 *
 * The check is intentionally conservative — every borderline case errs
 * toward "go ahead and retrieve". A few wasted embeds beat silently
 * skipping recall for a question the user actually wanted answered.
 *
 * Note (2026-05 cleanup): an earlier iteration added a `TRIVIAL_CONVERSATIONAL_PATTERNS`
 * regex array to catch 3 English phrases ("sounds good" / "looks good"
 * / "please continue") that length alone misses. It was removed: the
 * marginal benefit was not worth the maintenance burden, and the
 * Chinese half of the array caught nothing the length check did not
 * already cover (every entry was ≤ 4 chars). For those 3 borderline
 * phrases a single embed forward pass costs little — if it actually
 * matters in production, raise `skipShortQueryChars` instead and
 * update `retrievalPrefetch.test.ts` to use a longer test query.
 */
export function shouldSkipRetrievalForQuery(
  query: string,
  tuning: RecallTuning = getRecallTuning(),
): boolean {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (trimmed.length === 0) return true

  if (trimmed.length < tuning.skipShortQueryChars) return true

  // Slash-command intent. Allow `/` followed by the typical command alphabet
  // ([a-z0-9_-]); anything else (e.g. a path that happens to start with `/`)
  // falls through to normal retrieval.
  if (/^\/[a-z][a-z0-9_-]*\b/i.test(trimmed)) return true

  // Pure punctuation / symbols (e.g. `???`, `!!!`, `...`).
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) return true

  return false
}

/** Test seam: re-export defaults so unit tests can assert against them. */
export const __TUNING_DEFAULTS = DEFAULTS
