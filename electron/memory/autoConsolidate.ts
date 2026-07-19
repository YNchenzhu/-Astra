/**
 * Memory auto-consolidation — equivalent to upstream's auto-dream.
 *
 * Runs after N extraction cycles (or on-demand from Settings). Performs:
 *
 *   ① Merge duplicate memories (same name or near-identical content)
 *   ② Prune stale / disabled entries past the retention window
 *   ③ Compress overlong entries to a reasonable cap
 *   ④ Rebuild MEMORY.md from the resulting set
 *
 * Consolidation writes are protected by the same per-file lock as
 * the main agent and auto-extract writers, so this can safely run
 * in the background without colliding.
 *
 * Performance / safety properties (post-refactor):
 *   - {@link semanticDedup} is no longer O(n²): Pass 2 forwards "promising" Jaccard pairs to
 *     Pass 3, and Pass 3 buckets vectors via random-projection LSH so only same-bucket pairs
 *     plus the forwarded candidates are compared. With 500 entries the comparisons drop from
 *     ~125k to ~5–10k while preserving recall on near-duplicates.
 *   - Compression keeps integrity metadata (`originalLength` / `originalHash` /
 *     `truncatedHash`) in frontmatter so future tooling can detect that an entry was
 *     truncated and verify its surviving prefix. The compression marker text also explicitly
 *     warns that the operation is irreversible.
 *   - Merge priority uses {@link qualityScore} (length + markdown structure + scope=user
 *     boost + presence of explicit description) instead of bare `updated` timestamps —
 *     longer hand-curated entries beat short auto-extracted snippets even when the snippet
 *     is technically newer.
 *   - {@link consolidateMemories} accepts `{ dryRun: true }` and returns a detailed
 *     {@link ConsolidationPlan} without mutating any file. Settings UI renders this plan as
 *     a preview before the user confirms.
 *   - Incremental mode: entries whose `consolidatedAt` ≥ `updated` are considered "unchanged
 *     since last sweep" and skipped in pairwise compare against each other (their pair was
 *     evaluated before). A periodic full sweep is forced every {@link FULL_SWEEP_EVERY_N}
 *     incremental runs to catch drift.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MemoryEntry, MemoryFrontmatter } from './types'
import {
  listMemoriesAtRoot,
  writeMemoryFileAsync,
  deleteMemoryFileAsync,
  rebuildIndexInDirAsync,
} from './storage'
import {
  tryAcquireFileLock,
  releaseFileLock,
} from './extractionState'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Run consolidate every N extraction cycles. */
const CONSOLIDATE_EVERY_N_EXTRACTIONS = 8

/** Max content length before compression kicks in (chars). */
const MAX_CONTENT_LENGTH = 3000

/** Age threshold for stale pruning (days). User memories are exempt. */
const STALE_AGE_DAYS = 60

/** Jaccard threshold for near-duplicate detection (0–1). Pairs ≥ this merge in Pass 2. */
const JACCARD_DEDUP_THRESHOLD = 0.78

/**
 * Lower Jaccard threshold for forwarding pairs to Pass 3 (semantic). Pairs in [seed, dedup)
 * are "suspicious" but not enough to merge on Jaccard alone; semantic embedding decides.
 * This is the Pass 2 → Pass 3 coordination signal.
 */
const JACCARD_SEED_THRESHOLD = 0.45

/** Min content length for Jaccard comparison (skip tiny entries). */
const MIN_CONTENT_FOR_JACCARD = 80

/** Embedding cosine threshold for semantic dedup (only when embedding is available). */
const EMBEDDING_DEDUP_THRESHOLD = 0.88

/**
 * Number of random hyperplanes for LSH bucketing of normalised embedding vectors. With k=8
 * we get up to 256 buckets; for typical workspace memory sizes (≤ a few hundred entries)
 * this gives 1–4 entries per bucket on average → near-linear comparisons. Recall is
 * preserved by also evaluating Pass 2 forwarded candidates regardless of bucket.
 */
const LSH_HYPERPLANE_BITS = 8

/**
 * Force a full (non-incremental) sweep every N incremental runs so accumulated skipped
 * pairs eventually get re-evaluated.
 */
const FULL_SWEEP_EVERY_N = 5

// ---------------------------------------------------------------------------
// Trigger gating
// ---------------------------------------------------------------------------

let lastConsolidationAt = 0
let extractionCountSinceLastConsolidation = 0
let incrementalRunsSinceFullSweep = 0
// Tracks which memory directory the in-memory counters above belong to. When
// the user switches workspaces the new directory's persisted gate must take
// over cleanly — without this guard, `loadGateFromDisk` used `Math.max` and
// would inherit a higher counter from the previously open workspace,
// effectively poisoning the new workspace's consolidation cadence.
let loadedGateDir: string | null = null

/** Call after every extraction — returns true when consolidation should fire. */
export function markExtractionComplete(): boolean {
  extractionCountSinceLastConsolidation++
  return extractionCountSinceLastConsolidation >= CONSOLIDATE_EVERY_N_EXTRACTIONS
}

/** Reset the consolidation gate (after a successful run or test reset). */
export function resetConsolidationGate(): void {
  extractionCountSinceLastConsolidation = 0
  lastConsolidationAt = Date.now()
}

/** How many seconds since the last consolidation run. */
export function secondsSinceLastConsolidation(): number {
  if (lastConsolidationAt === 0) return Infinity
  return (Date.now() - lastConsolidationAt) / 1000
}

// ── Gate persistence (survives process restarts) ──

const GATE_FILENAME = '.consolidation-gate.json'

function normalizeMemoryDir(memoryDir: string): string {
  return memoryDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Narrow shape we accept from {@link GATE_FILENAME}. We deliberately do NOT
 * pull in zod here — this loader runs on every consolidation pass and zod
 * import-cost matters. The handwritten check below is enough: every field is
 * defended with `typeof === 'number'` + finiteness; non-conforming inputs are
 * silently ignored (caller falls back to "start from zero").
 */
function isValidGateShape(
  v: unknown,
): v is { extractionCountSinceLastConsolidation?: number; incrementalRunsSinceFullSweep?: number } {
  if (v === null || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  if (
    obj.extractionCountSinceLastConsolidation !== undefined &&
    (typeof obj.extractionCountSinceLastConsolidation !== 'number' ||
      !Number.isFinite(obj.extractionCountSinceLastConsolidation) ||
      obj.extractionCountSinceLastConsolidation < 0)
  ) {
    return false
  }
  if (
    obj.incrementalRunsSinceFullSweep !== undefined &&
    (typeof obj.incrementalRunsSinceFullSweep !== 'number' ||
      !Number.isFinite(obj.incrementalRunsSinceFullSweep) ||
      obj.incrementalRunsSinceFullSweep < 0)
  ) {
    return false
  }
  return true
}

async function loadGateFromDisk(memoryDir: string): Promise<void> {
  // Workspace switch: drop the previous workspace's in-memory counters so
  // they don't bleed into the freshly-loaded ones via Math.max below.
  const norm = normalizeMemoryDir(memoryDir)
  if (loadedGateDir !== null && loadedGateDir !== norm) {
    extractionCountSinceLastConsolidation = 0
    incrementalRunsSinceFullSweep = 0
    lastConsolidationAt = 0
  }
  loadedGateDir = norm
  try {
    const raw = await fsp.readFile(path.join(memoryDir, GATE_FILENAME), 'utf-8')
    // Audit fix F15: a corrupted `.consolidation-gate.json` (concurrent
    // write half-flushed, disk error, manual edit) used to crash here with
    // `SyntaxError: Unexpected token …`, and the surrounding `try { }
    // catch { /* file doesn't exist yet */ }` swallowed it silently —
    // hiding "schema corruption" under the same banner as "no file yet".
    // The JSON.parse is now isolated so we can tell the two cases apart in
    // the log, and the parsed payload is shape-checked before we trust
    // any of its fields.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (jsonErr) {
      console.warn(
        `[autoConsolidate] corrupt ${GATE_FILENAME} (will reset counters): ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
      )
      return
    }
    if (!isValidGateShape(parsed)) {
      console.warn(
        `[autoConsolidate] ${GATE_FILENAME} schema mismatch — ignoring contents`,
      )
      return
    }
    if (typeof parsed.extractionCountSinceLastConsolidation === 'number') {
      extractionCountSinceLastConsolidation = Math.max(
        extractionCountSinceLastConsolidation,
        parsed.extractionCountSinceLastConsolidation,
      )
    }
    if (typeof parsed.incrementalRunsSinceFullSweep === 'number') {
      incrementalRunsSinceFullSweep = parsed.incrementalRunsSinceFullSweep
    }
  } catch {
    /* file doesn't exist yet — start from zero */
  }
}

async function saveGateToDisk(memoryDir: string): Promise<void> {
  try {
    await fsp.mkdir(memoryDir, { recursive: true })
    await fsp.writeFile(
      path.join(memoryDir, GATE_FILENAME),
      JSON.stringify({
        extractionCountSinceLastConsolidation,
        incrementalRunsSinceFullSweep,
      }),
      'utf-8',
    )
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Result + plan shapes
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  /** Number of memory pairs that were merged into single entries. */
  merged: number
  /** Number of stale / disabled entries pruned. */
  pruned: number
  /** Number of overlong entries compressed. */
  compressed: number
  /** Number of entries left unchanged. */
  unchanged: number
  /** Errors encountered (non-fatal — single-file failures don't abort). */
  errors: string[]
  /**
   * Detailed plan when {@link ConsolidateOptions.dryRun} was set. Same shape as the actions
   * the live run would take, but no file mutations were performed.
   */
  plan?: ConsolidationPlan
}

export interface PlannedMerge {
  /** Filename that will be retained (the higher-quality of the pair). */
  keep: string
  /** Filename that will be merged-then-deleted. */
  drop: string
  /** Which pass detected the duplicate. */
  pass: 'hash' | 'name' | 'jaccard' | 'semantic'
  /** Similarity score for jaccard / semantic; undefined for hash / name (exact). */
  similarity?: number
  /** Quality scores at decision time (for surfacing in UI). */
  keepQuality?: number
  dropQuality?: number
}

export interface PlannedPrune {
  filename: string
  reason: 'stale_disabled'
  ageDays: number
}

export interface PlannedCompress {
  filename: string
  fromLen: number
  toLen: number
}

export interface ConsolidationPlan {
  merges: PlannedMerge[]
  prunes: PlannedPrune[]
  compresses: PlannedCompress[]
  /** Total entries considered (after disk read, before any pass). */
  totalEntries: number
  /** Whether the run would have run an incremental skip pass. */
  incremental: boolean
}

export interface ConsolidateOptions {
  /**
   * When true, use the local bge-m3 model for semantic near-duplicate detection (falls back
   * to Jaccard if false).
   */
  embedAvailable?: boolean
  /**
   * When true, return a {@link ConsolidationPlan} without performing any file mutations. The
   * Settings UI uses this to render a preview before the user confirms.
   */
  dryRun?: boolean
  /**
   * When true, skip the incremental optimisation and re-evaluate every pair regardless of
   * `consolidatedAt`. Used by the periodic full-sweep cadence and from "force full" UI.
   */
  fullSweep?: boolean
}

// ---------------------------------------------------------------------------
// Tokenization helpers (for Jaccard dedup)
// ---------------------------------------------------------------------------

/** Simple whitespace + punctuation tokenizer. Returns lowercase token set. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
  return new Set(tokens)
}

/** Jaccard coefficient: |A ∩ B| / |A ∪ B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ---------------------------------------------------------------------------
// Content hash + integrity helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

/**
 * Heuristic content-quality score for merge-priority decisions. Higher = "more worth keeping".
 *
 * Components:
 *   - Length, capped (longer = more context, but diminishing returns past 1500 chars).
 *   - Markdown structure (each heading / code block / list bullet adds a point).
 *   - User-scoped entries get a +20 boost (hand-curated > auto-extracted).
 *   - Explicit description adds a +5 boost.
 *   - Compressed entries get a -10 penalty (their information is lossy).
 *
 * The scoring is intentionally simple and deterministic — it's a tie-breaker for
 * `mergeInto`, not a ranking system.
 */
export function qualityScore(e: MemoryEntry): number {
  const fm = e.frontmatter
  const len = e.content.length
  // Linear up to 1500 chars, then sqrt for diminishing returns.
  const lenScore = len <= 1500 ? len * 0.05 : 75 + Math.sqrt(len - 1500) * 0.5

  let structure = 0
  // Headings (ATX-style)
  structure += (e.content.match(/^\s{0,3}#{1,6}\s+\S/gm) || []).length * 2
  // Fenced code blocks (count opens; pairs cancel out so dividing by 2)
  const fenceCount = (e.content.match(/^```/gm) || []).length
  structure += Math.floor(fenceCount / 2) * 5
  // Bullet / numbered list lines
  structure += (e.content.match(/^\s{0,3}(?:[-*+]|\d+\.)\s+\S/gm) || []).length

  const userBoost = fm.scope === 'user' ? 20 : 0
  const descriptionBoost = fm.description?.trim().length ? 5 : 0
  const compressedPenalty = typeof fm.originalLength === 'number' ? -10 : 0

  return lenScore + structure + userBoost + descriptionBoost + compressedPenalty
}

/**
 * Choose which entry to keep when merging a pair. Returns the index (`a` or `b`) of the
 * keeper. Quality wins; on a tie, the more-recently-updated entry wins.
 */
function chooseKeeper(
  entries: MemoryEntry[],
  a: number,
  b: number,
): { keep: number; drop: number; keepQ: number; dropQ: number } {
  const qa = qualityScore(entries[a])
  const qb = qualityScore(entries[b])
  if (qa === qb) {
    const ta = new Date(entries[a].frontmatter.updated).getTime()
    const tb = new Date(entries[b].frontmatter.updated).getTime()
    return ta >= tb
      ? { keep: a, drop: b, keepQ: qa, dropQ: qb }
      : { keep: b, drop: a, keepQ: qb, dropQ: qa }
  }
  return qa > qb
    ? { keep: a, drop: b, keepQ: qa, dropQ: qb }
    : { keep: b, drop: a, keepQ: qb, dropQ: qa }
}

// ---------------------------------------------------------------------------
// Main consolidation entry point
// ---------------------------------------------------------------------------

/**
 * Run a full consolidation pass over the workspace memory directory.
 *
 * Safe to call concurrently with agent/extract writes — each file-level mutation is wrapped
 * in `tryAcquireFileLock`. Entries locked by another writer are skipped and reported in the
 * `errors` list rather than blocking.
 *
 * @param absDir - Absolute path to the memory directory (e.g. <workspace>/.claude/memory)
 * @param opts - See {@link ConsolidateOptions}.
 */
export async function consolidateMemories(
  absDir: string,
  opts: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  await loadGateFromDisk(absDir)

  const dryRun = opts.dryRun === true
  const forceFull = opts.fullSweep === true
  // Run in incremental mode unless forced full or the periodic full-sweep cadence kicks in.
  const incremental = !forceFull && incrementalRunsSinceFullSweep < FULL_SWEEP_EVERY_N - 1

  const result: ConsolidationResult = {
    merged: 0,
    pruned: 0,
    compressed: 0,
    unchanged: 0,
    errors: [],
  }
  const plan: ConsolidationPlan = {
    merges: [],
    prunes: [],
    compresses: [],
    totalEntries: 0,
    incremental,
  }

  const entries = listMemoriesAtRoot(absDir)
  plan.totalEntries = entries.length
  if (entries.length === 0) {
    if (dryRun) result.plan = plan
    return result
  }

  const ops = createFileOps(absDir, dryRun)
  const sweepStartedAt = new Date().toISOString()

  // ── Pass 0: exact content-hash dedup ──
  const { kept: postPass0, mergedPairs: hashPairs } = await runHashDedup(entries, ops)
  for (const m of hashPairs) plan.merges.push({ ...m, pass: 'hash' })
  result.merged += hashPairs.length

  // ── Pass 1: name-based dedup ──
  const { kept: postPass1, mergedPairs: namePairs } = await runNameDedup(postPass0, ops)
  for (const m of namePairs) plan.merges.push({ ...m, pass: 'name' })
  result.merged += namePairs.length

  // ── Pass 2: Jaccard near-duplicate detection (also seeds Pass 3 candidates) ──
  const {
    kept: postPass2,
    mergedPairs: jaccardPairs,
    seedPairs,
  } = await runJaccardDedup(postPass1, ops, incremental)
  for (const m of jaccardPairs) plan.merges.push({ ...m, pass: 'jaccard' })
  result.merged += jaccardPairs.length

  // ── Pass 3: embedding-based semantic dedup, scoped by LSH + Pass 2 seeds ──
  let postPass3 = postPass2
  if (opts.embedAvailable && postPass2.length > 1) {
    try {
      const semantic = await semanticDedup(postPass2, ops, seedPairs, incremental)
      result.merged += semantic.merged
      for (const m of semantic.mergedPairs) plan.merges.push({ ...m, pass: 'semantic' })
      result.errors.push(...semantic.errors)
      postPass3 = semantic.kept
    } catch (e) {
      result.errors.push(`embedding dedup failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Pass 4: prune stale / disabled entries ──
  const postPrune: MemoryEntry[] = []
  for (const e of postPass3) {
    const shouldPrune =
      e.ageDays > STALE_AGE_DAYS &&
      e.frontmatter.enabled === false &&
      e.frontmatter.type !== 'user'

    if (shouldPrune) {
      plan.prunes.push({ filename: e.filename, reason: 'stale_disabled', ageDays: e.ageDays })
      await ops.deleteFile(e.filename)
      result.pruned++
    } else {
      postPrune.push(e)
    }
  }

  // ── Pass 5: compress overlong entries (records integrity metadata) ──
  for (const e of postPrune) {
    if (e.content.length > MAX_CONTENT_LENGTH) {
      plan.compresses.push({
        filename: e.filename,
        fromLen: e.content.length,
        toLen: Math.min(e.content.length, MAX_CONTENT_LENGTH),
      })
      if (dryRun) {
        result.compressed++
        continue
      }
      if (!tryAcquireFileLock(e.filename, 'consolidate')) {
        result.errors.push(`skipped compress on locked file: ${e.filename}`)
        continue
      }
      try {
        const c = compressContentWithIntegrity(e.content, MAX_CONTENT_LENGTH)
        await writeMemoryFileAsync(absDir, e.filename, {
          ...e.frontmatter,
          originalLength: c.originalLength,
          originalHash: c.originalHash,
          truncatedHash: c.truncatedHash,
          consolidatedAt: sweepStartedAt,
        }, c.compressed)
        result.compressed++
      } catch (err) {
        result.errors.push(`compress failed for ${e.filename}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        releaseFileLock(e.filename)
      }
    }
  }

  // ── Stamp consolidatedAt on every survivor so the next incremental pass can skip them ──
  if (!dryRun) {
    for (const e of postPrune) {
      // Skip entries that were just rewritten by the compress pass — they already carry the
      // updated consolidatedAt, and re-writing would bump `updated` again unnecessarily.
      if (e.content.length > MAX_CONTENT_LENGTH) continue
      // Skip entries whose existing consolidatedAt is already newer than the start of this
      // sweep (e.g. concurrent extractor updated them mid-run).
      const existing = e.frontmatter.consolidatedAt
      if (existing && existing >= sweepStartedAt) continue
      if (!tryAcquireFileLock(e.filename, 'consolidate')) {
        result.errors.push(`skipped consolidatedAt stamp on locked file: ${e.filename}`)
        continue
      }
      try {
        // `preserveUpdated: true` so the stamp pass keeps `updated`
        // pointed at the entry's actual last edit. Without it, every
        // stamp call would bump `updated` past `consolidatedAt` and
        // `isEntryUnchangedSinceConsolidate` would treat every survivor
        // as "changed since last sweep" — defeating the whole point of
        // the incremental skip.
        await writeMemoryFileAsync(
          absDir,
          e.filename,
          {
            ...e.frontmatter,
            consolidatedAt: sweepStartedAt,
          },
          e.content,
          { preserveUpdated: true },
        )
      } catch (err) {
        result.errors.push(
          `stamp failed for ${e.filename}: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        releaseFileLock(e.filename)
      }
    }
  }

  // ── Rebuild MEMORY.md index ──
  if (!dryRun) {
    try {
      await rebuildIndexInDirAsync(absDir)
    } catch (err) {
      result.errors.push(`index rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.unchanged = postPrune.length - result.compressed
  if (result.unchanged < 0) result.unchanged = 0

  if (!dryRun) {
    if (forceFull || !incremental) {
      incrementalRunsSinceFullSweep = 0
    } else {
      incrementalRunsSinceFullSweep++
    }
    resetConsolidationGate()
    await saveGateToDisk(absDir)
  }
  if (dryRun) result.plan = plan
  return result
}

// ---------------------------------------------------------------------------
// FileOps abstraction (real writes vs dry-run no-ops)
// ---------------------------------------------------------------------------

interface FileOps {
  deleteFile(filename: string): Promise<void>
  writeFile(filename: string, frontmatter: MemoryFrontmatter, content: string): Promise<void>
  /** True when the underlying ops are no-op stubs (used by callers to skip lock dance). */
  readonly dryRun: boolean
}

function createFileOps(absDir: string, dryRun: boolean): FileOps {
  if (dryRun) {
    return {
      dryRun: true,
      async deleteFile() { /* no-op */ },
      async writeFile() { /* no-op */ },
    }
  }
  return {
    dryRun: false,
    async deleteFile(filename) {
      if (!tryAcquireFileLock(filename, 'consolidate')) return
      try { await deleteMemoryFileAsync(absDir, filename) } catch { /* ignore */ }
      finally { releaseFileLock(filename) }
    },
    async writeFile(filename, frontmatter, content) {
      if (!tryAcquireFileLock(filename, 'consolidate')) return
      try { await writeMemoryFileAsync(absDir, filename, frontmatter, content) } catch { /* ignore */ }
      finally { releaseFileLock(filename) }
    },
  }
}

// ---------------------------------------------------------------------------
// Pass 0 — exact content-hash dedup
// ---------------------------------------------------------------------------

interface PassResult {
  kept: MemoryEntry[]
  mergedPairs: Array<Omit<PlannedMerge, 'pass'>>
}

async function runHashDedup(entries: MemoryEntry[], ops: FileOps): Promise<PassResult> {
  const hashSeen = new Map<string, number>() // hash → index in `kept`
  const kept: MemoryEntry[] = []
  const dirty = new Set<string>()
  const merges: Array<Omit<PlannedMerge, 'pass'>> = []

  for (const e of entries) {
    const h = contentHash(e.content)
    const firstIdx = hashSeen.get(h)
    if (firstIdx !== undefined) {
      const keeper = kept[firstIdx]
      // Even on exact content match, choose by quality (covers cases where one entry has a
      // richer description / tag set even though content is byte-identical).
      const decision = chooseKeeper([keeper, e], 0, 1)
      let keepEntry: MemoryEntry
      let dropEntry: MemoryEntry
      if (decision.keep === 0) {
        keepEntry = keeper
        dropEntry = e
      } else {
        keepEntry = e
        dropEntry = keeper
        kept[firstIdx] = e
        hashSeen.set(h, firstIdx)
      }
      mergeInto(keepEntry, dropEntry)
      dirty.add(keepEntry.filename)
      merges.push({
        keep: keepEntry.filename,
        drop: dropEntry.filename,
        keepQuality: decision.keepQ,
        dropQuality: decision.dropQ,
      })
      await ops.deleteFile(dropEntry.filename)
    } else {
      hashSeen.set(h, kept.length)
      kept.push(e)
    }
  }

  for (const e of kept) {
    if (dirty.has(e.filename)) await ops.writeFile(e.filename, e.frontmatter, e.content)
  }
  return { kept, mergedPairs: merges }
}

// ---------------------------------------------------------------------------
// Pass 1 — name-based dedup
// ---------------------------------------------------------------------------

async function runNameDedup(entries: MemoryEntry[], ops: FileOps): Promise<PassResult> {
  const nameIndex = new Map<string, number>()
  const kept: MemoryEntry[] = []
  const dirty = new Set<string>()
  const merges: Array<Omit<PlannedMerge, 'pass'>> = []

  for (const e of entries) {
    const key = e.frontmatter.name.trim().toLowerCase()
    const existingIdx = nameIndex.get(key)
    if (existingIdx !== undefined) {
      const decision = chooseKeeper([kept[existingIdx], e], 0, 1)
      let keepEntry: MemoryEntry
      let dropEntry: MemoryEntry
      if (decision.keep === 0) {
        keepEntry = kept[existingIdx]
        dropEntry = e
      } else {
        keepEntry = e
        dropEntry = kept[existingIdx]
        kept[existingIdx] = e
        nameIndex.set(key, existingIdx)
      }
      mergeInto(keepEntry, dropEntry)
      dirty.add(keepEntry.filename)
      merges.push({
        keep: keepEntry.filename,
        drop: dropEntry.filename,
        keepQuality: decision.keepQ,
        dropQuality: decision.dropQ,
      })
      await ops.deleteFile(dropEntry.filename)
    } else {
      nameIndex.set(key, kept.length)
      kept.push(e)
    }
  }

  for (const e of kept) {
    if (dirty.has(e.filename)) await ops.writeFile(e.filename, e.frontmatter, e.content)
  }
  return { kept, mergedPairs: merges }
}

// ---------------------------------------------------------------------------
// Pass 2 — Jaccard near-duplicate detection (forwards seed pairs to Pass 3)
// ---------------------------------------------------------------------------

interface JaccardPassResult extends PassResult {
  /**
   * Pairs whose Jaccard score landed in [JACCARD_SEED_THRESHOLD, JACCARD_DEDUP_THRESHOLD).
   * They were too close to ignore but not close enough to merge on lexical overlap alone —
   * Pass 3 (semantic) gets these as forced candidates regardless of LSH bucketing.
   */
  seedPairs: Array<{ aIdx: number; bIdx: number; jaccard: number }>
}

async function runJaccardDedup(
  entries: MemoryEntry[],
  ops: FileOps,
  incremental: boolean,
): Promise<JaccardPassResult> {
  const longEntries = entries
    .map((e, i) => ({ e, i, tokens: tokenize(e.content) }))
    .filter((x) => x.e.content.length >= MIN_CONTENT_FOR_JACCARD)

  const merged = new Set<number>()
  const dirty = new Set<string>()
  const mergedPairs: Array<Omit<PlannedMerge, 'pass'>> = []
  const seedPairs: Array<{ aIdx: number; bIdx: number; jaccard: number }> = []

  for (let a = 0; a < longEntries.length; a++) {
    if (merged.has(longEntries[a].i)) continue
    for (let b = a + 1; b < longEntries.length; b++) {
      if (merged.has(longEntries[b].i)) continue
      if (longEntries[a].e.frontmatter.type !== longEntries[b].e.frontmatter.type) continue

      // Incremental skip: both entries have a recorded consolidatedAt newer than their last
      // update, meaning a previous sweep already evaluated them as "not duplicates". A new
      // pass cannot find them duplicate without one of them being modified.
      if (incremental && bothCleanSinceLastSweep(longEntries[a].e, longEntries[b].e)) continue

      const sim = jaccard(longEntries[a].tokens, longEntries[b].tokens)
      if (sim >= JACCARD_DEDUP_THRESHOLD) {
        const decision = chooseKeeper(
          [longEntries[a].e, longEntries[b].e],
          0,
          1,
        )
        const keepLE = decision.keep === 0 ? longEntries[a] : longEntries[b]
        const dropLE = decision.keep === 0 ? longEntries[b] : longEntries[a]
        mergeInto(keepLE.e, dropLE.e)
        merged.add(dropLE.i)
        dirty.add(keepLE.e.filename)
        mergedPairs.push({
          keep: keepLE.e.filename,
          drop: dropLE.e.filename,
          similarity: sim,
          keepQuality: decision.keepQ,
          dropQuality: decision.dropQ,
        })
        await ops.deleteFile(dropLE.e.filename)
      } else if (sim >= JACCARD_SEED_THRESHOLD) {
        seedPairs.push({ aIdx: longEntries[a].i, bIdx: longEntries[b].i, jaccard: sim })
      }
    }
  }

  for (const le of longEntries) {
    if (dirty.has(le.e.filename)) await ops.writeFile(le.e.filename, le.e.frontmatter, le.e.content)
  }

  const kept = entries.filter((_, i) => !merged.has(i))
  return { kept, mergedPairs, seedPairs }
}

/**
 * Both entries have been seen by a previous consolidation sweep AND neither has been
 * modified since. The pair was therefore evaluated and not considered duplicate; skipping
 * it is safe in incremental mode.
 */
function bothCleanSinceLastSweep(a: MemoryEntry, b: MemoryEntry): boolean {
  return isCleanSinceLastSweep(a) && isCleanSinceLastSweep(b)
}

function isCleanSinceLastSweep(e: MemoryEntry): boolean {
  const c = e.frontmatter.consolidatedAt
  if (!c) return false
  return c >= e.frontmatter.updated
}

// ---------------------------------------------------------------------------
// Pass 3 — embedding-based semantic dedup with LSH bucketing
// ---------------------------------------------------------------------------

interface SemanticDedupResult {
  merged: number
  kept: MemoryEntry[]
  errors: string[]
  mergedPairs: Array<Omit<PlannedMerge, 'pass'>>
}

/**
 * Use the local bge-m3 model to find semantically-near-duplicate memories. This catches
 * paraphrased / reworded versions of the same fact that Jaccard alone would miss.
 *
 * The pairwise scan is bucketed via random-projection LSH: each normalised vector becomes a
 * `LSH_HYPERPLANE_BITS`-bit signature, and only entries with the same signature are pairwise
 * compared (plus any pairs forwarded from Pass 2 — they bypass the bucket filter regardless).
 * This drops the comparison count from O(n²) to roughly O(n + s) where s is the number of
 * forwarded seed pairs.
 */
async function semanticDedup(
  entries: MemoryEntry[],
  ops: FileOps,
  seedPairs: Array<{ aIdx: number; bIdx: number; jaccard: number }>,
  incremental: boolean,
): Promise<SemanticDedupResult> {
  const result: SemanticDedupResult = { merged: 0, kept: [...entries], errors: [], mergedPairs: [] }
  if (entries.length <= 1) return result

  const dispatch = await loadEmbeddingDispatch()
  if (!dispatch.ok) {
    result.errors.push(dispatch.error)
    return result
  }
  const cfg = dispatch.cfg
  if (cfg.mode === 'cloud' && !cfg.cloud) {
    return result
  }

  const texts = entries.map((e) => memoryEmbedText(e))
  const r = await dispatch.dispatchEmbed(cfg, texts)
  if (!r.ok) {
    result.errors.push(`embedding failed: ${r.error}`)
    return result
  }

  const vecs = r.vectors.map(normalize)
  if (vecs.length !== entries.length) {
    result.errors.push('vector count mismatch')
    return result
  }

  // Build LSH buckets (random hyperplane signatures). Same signature ≈ likely-similar.
  const dim = vecs[0]?.length ?? 0
  const planes = generateRandomHyperplanes(LSH_HYPERPLANE_BITS, dim)
  const bucketOf = vecs.map((v) => lshSignature(v, planes))
  const bucketIndex = new Map<number, number[]>()
  for (let i = 0; i < bucketOf.length; i++) {
    const arr = bucketIndex.get(bucketOf[i]) ?? []
    arr.push(i)
    bucketIndex.set(bucketOf[i], arr)
  }

  // Build the candidate-pair iterator: bucket-internal pairs UNION seed pairs from Pass 2.
  const seenPair = new Set<string>()
  const candidatePairs: Array<[number, number]> = []
  function addPair(a: number, b: number): void {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (lo === hi) return
    const key = `${lo}-${hi}`
    if (seenPair.has(key)) return
    seenPair.add(key)
    candidatePairs.push([lo, hi])
  }
  for (const arr of bucketIndex.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) addPair(arr[i], arr[j])
    }
  }
  for (const sp of seedPairs) addPair(sp.aIdx, sp.bIdx)

  const merged = new Set<number>()
  const dirty = new Set<string>()
  for (const [a, b] of candidatePairs) {
    if (merged.has(a) || merged.has(b)) continue
    if (entries[a].frontmatter.type !== entries[b].frontmatter.type) continue
    if (incremental && bothCleanSinceLastSweep(entries[a], entries[b])) continue

    const sim = dot(vecs[a], vecs[b])
    if (sim >= EMBEDDING_DEDUP_THRESHOLD) {
      const decision = chooseKeeper(entries, a, b)
      mergeInto(entries[decision.keep], entries[decision.drop])
      dirty.add(entries[decision.keep].filename)
      merged.add(decision.drop)
      result.mergedPairs.push({
        keep: entries[decision.keep].filename,
        drop: entries[decision.drop].filename,
        similarity: sim,
        keepQuality: decision.keepQ,
        dropQuality: decision.dropQ,
      })
      await ops.deleteFile(entries[decision.drop].filename)
      result.merged++
    }
  }

  for (const e of entries) {
    if (dirty.has(e.filename)) await ops.writeFile(e.filename, e.frontmatter, e.content)
  }

  result.kept = entries.filter((_, i) => !merged.has(i))
  return result
}

type DispatchEmbedFn = typeof import('../embedding/dispatch').dispatchEmbed
type DispatchCfg = import('../embedding/dispatch').DispatchEmbeddingConfig

interface LoadedDispatch {
  ok: true
  dispatchEmbed: DispatchEmbedFn
  cfg: DispatchCfg
}
interface LoadedDispatchErr {
  ok: false
  error: string
}

async function loadEmbeddingDispatch(): Promise<LoadedDispatch | LoadedDispatchErr> {
  let dispatchEmbed: DispatchEmbedFn
  try {
    const mod = await import('../embedding/dispatch')
    dispatchEmbed = mod.dispatchEmbed
  } catch {
    return { ok: false, error: 'embedding subsystem not available for semantic dedup' }
  }
  let buildDispatchConfig: () => DispatchCfg
  try {
    const { readDiskSettings } = await import('../settings/settingsAccess')
    buildDispatchConfig = () => {
      const s = readDiskSettings() as Record<string, unknown>
      return {
        mode: (s.embeddingMode as 'local' | 'cloud' | 'auto') || 'auto',
        localModelId: typeof s.embeddingLocalModelId === 'string' ? s.embeddingLocalModelId : undefined,
        cloud: s.embeddingProviderId && s.embeddingModel
          ? {
              providerId: String(s.embeddingProviderId),
              model: String(s.embeddingModel),
              apiKey: typeof s.embeddingApiKey === 'string' ? s.embeddingApiKey : undefined,
              baseUrl: typeof s.embeddingBaseUrl === 'string' ? s.embeddingBaseUrl : undefined,
              dimensions: typeof s.embeddingDimensions === 'number' ? s.embeddingDimensions : undefined,
            }
          : undefined,
      }
    }
  } catch {
    return { ok: false, error: 'settings not available for embedding config' }
  }
  return { ok: true, dispatchEmbed, cfg: buildDispatchConfig() }
}

// ---------------------------------------------------------------------------
// Embedding availability probe (replaces the hardcoded `embedAvailable: true` in callers)
// ---------------------------------------------------------------------------

let cachedProbe: { value: boolean; at: number } | undefined
const PROBE_TTL_MS = 60_000

/**
 * Quick check whether semantic dedup can succeed in this workspace. Caches the result for
 * {@link PROBE_TTL_MS} so repeated extraction-triggered calls don't hammer the model loader.
 *
 * Replaces the previous `embedAvailable: true` literal — that path made `semanticDedup`
 * eagerly attempt a dynamic import + embed call and only learn it was unavailable from a
 * timeout / error after every extraction cycle. The probe lets callers short-circuit when
 * embedding clearly isn't configured.
 */
export async function probeEmbeddingAvailability(): Promise<boolean> {
  if (cachedProbe && Date.now() - cachedProbe.at < PROBE_TTL_MS) {
    return cachedProbe.value
  }
  const value = await runProbeOnce()
  cachedProbe = { value, at: Date.now() }
  return value
}

/** Test helper — clear the probe cache. */
export function resetEmbeddingProbeCacheForTests(): void {
  cachedProbe = undefined
}

async function runProbeOnce(): Promise<boolean> {
  const dispatch = await loadEmbeddingDispatch()
  if (!dispatch.ok) return false
  if (dispatch.cfg.mode === 'cloud' && !dispatch.cfg.cloud) return false
  // Tiny sanity embed — we tolerate any successful response.
  try {
    const r = await dispatch.dispatchEmbed(dispatch.cfg, ['probe'])
    return r.ok && r.vectors.length === 1
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// LSH bucketing helpers
// ---------------------------------------------------------------------------

/** Deterministic random vectors so signatures are stable across consolidation runs. */
function generateRandomHyperplanes(bits: number, dim: number): number[][] {
  if (dim === 0) return Array.from({ length: bits }, () => [])
  // Mulberry32 PRNG seeded with a constant — stable across calls in the same process.
  let state = 0x9e3779b9
  const rng = (): number => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return Array.from({ length: bits }, () => {
    const v = new Array<number>(dim)
    for (let i = 0; i < dim; i++) v[i] = rng() - 0.5
    return v
  })
}

function lshSignature(vec: number[], planes: number[][]): number {
  let sig = 0
  for (let p = 0; p < planes.length; p++) {
    let s = 0
    const plane = planes[p]
    for (let i = 0; i < plane.length; i++) s += plane[i] * vec[i]
    if (s >= 0) sig |= 1 << p
  }
  return sig
}

// ---------------------------------------------------------------------------
// Internal helpers — merging + embedding text
// ---------------------------------------------------------------------------

/**
 * Merge the source entry into the keeper. The keeper has been chosen by `chooseKeeper`
 * already, so this only handles content/tag/description fusion — it does NOT decide which
 * side wins.
 */
function mergeInto(keep: MemoryEntry, src: MemoryEntry): void {
  // Merge tags
  const existingTags = new Set((keep.frontmatter.tags || []).map((t: string) => t.toLowerCase()))
  for (const t of src.frontmatter.tags || []) {
    if (!existingTags.has(t.toLowerCase())) {
      keep.frontmatter.tags = [...(keep.frontmatter.tags || []), t]
    }
  }

  // Merge description if the source adds information not already present.
  const kd = keep.frontmatter.description.toLowerCase()
  const sd = src.frontmatter.description.toLowerCase()
  if (sd && !kd.includes(sd)) {
    keep.frontmatter.description = keep.frontmatter.description
      ? `${keep.frontmatter.description}; ${src.frontmatter.description}`
      : src.frontmatter.description
  }

  // Append the source's non-overlapping content as a merged section. Keeper content stays
  // primary because it was chosen as higher-quality; we don't overwrite it with a (possibly
  // newer but lower-quality) auto-extract snippet.
  if (!keep.content.includes(src.content.trim())) {
    keep.content = `${keep.content}\n\n--- merged from ${src.frontmatter.name} ---\n${src.content}`
  }

  keep.frontmatter.updated = new Date().toISOString()
}

interface CompressedContent {
  compressed: string
  originalLength: number
  originalHash: string
  truncatedHash: string
}

/**
 * Truncate content to `maxLen` chars at a paragraph boundary AND emit integrity metadata.
 * The returned `compressed` body explicitly tells the user the operation is irreversible —
 * the truncated suffix is hashed and recorded in frontmatter for future tooling but the
 * bytes themselves are not retained.
 */
function compressContentWithIntegrity(content: string, maxLen: number): CompressedContent {
  const originalLength = content.length
  const originalHash = contentHash(content)

  if (content.length <= maxLen) {
    return {
      compressed: content,
      originalLength,
      originalHash,
      truncatedHash: contentHash(''),
    }
  }

  const slice = content.slice(0, maxLen)
  const lastPara = slice.lastIndexOf('\n\n')
  const cutAt = lastPara > maxLen * 0.5 ? lastPara : maxLen - 100
  const surviving = content.slice(0, cutAt).trimEnd()
  const dropped = content.slice(cutAt)
  const truncatedHash = contentHash(dropped)

  const note =
    `\n\n> ⚠️ Auto-consolidation compressed this entry from ${originalLength} chars (irreversible — the dropped portion is not recoverable; integrity hash recorded in frontmatter).`

  return {
    compressed: surviving + note,
    originalLength,
    originalHash,
    truncatedHash,
  }
}

function memoryEmbedText(e: MemoryEntry): string {
  const fm = e.frontmatter
  const head = [fm.name, fm.description, fm.type, (fm.tags || []).join(' ')]
    .filter(Boolean)
    .join(' · ')
  return (head ? `${head}\n` : '') + (e.content || '')
}

// ---------------------------------------------------------------------------
// Vector math (inline to avoid a dependency on embeddingRecall)
// ---------------------------------------------------------------------------

function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function normalize(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0
  return v.map((x) => x * inv)
}

// ---------------------------------------------------------------------------
// Manual trigger summary (Settings UI)
// ---------------------------------------------------------------------------

/**
 * Exported for the Settings → 缓存管理 UI and manual "整理记忆" button.
 * Returns a human-readable summary suitable for display.
 */
export function formatConsolidationSummary(r: ConsolidationResult): string {
  const parts: string[] = []
  if (r.merged > 0) parts.push(`${r.merged} 组合并`)
  if (r.pruned > 0) parts.push(`${r.pruned} 条清理`)
  if (r.compressed > 0) parts.push(`${r.compressed} 条压缩`)
  if (r.errors.length > 0) parts.push(`${r.errors.length} 个错误`)
  return parts.length > 0 ? parts.join('，') : '无需整理'
}
