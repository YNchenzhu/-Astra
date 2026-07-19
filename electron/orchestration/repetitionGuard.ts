/**
 * Repetition Guard — process-wide, cross-agent tracker for degenerate
 * tool-call repetition. The "did the model just issue this exact call N
 * times in a row?" sanity check that the original upstream (and our
 * existing failure-based trackers) miss.
 *
 * ──────────────────────────── Why a NEW guard ────────────────────────────
 *
 * We already have:
 *
 *   - `toolCallHistory` (loop-scoped, in `electron/ai/toolCallHistory.ts`):
 *     counts CONSECUTIVE FAILURES of the same fingerprint and prepends
 *     advisories / blocks the 3rd attempt.
 *   - `globalToolCallHistory` (process-wide, in `globalToolCallHistory.ts`):
 *     same idea, cross-agent.
 *
 * Both are FAILURE-driven. A model that runs `echo "ok"` five times in a
 * row to placate a phantom-work watchdog has nothing to "fix" because each
 * call SUCCEEDED — but the loop is still degenerate, and the user sees an
 * AI faking work.
 *
 * Inspired by:
 *
 *   - Gemini CLI `loopDetectionService.ts` (cited in
 *     anthropics/upstream#4277): consecutive identical (tool, args)
 *     above threshold → halt the turn.
 *   - upstream#30150 root-cause analysis: the agent loop "has no
 *     convergence detection" — it never asks "did the last N calls move us
 *     forward?" — and that's the dominant cost-burn category in production.
 *
 * ─────────────────────────── Detection layers ────────────────────────────
 *
 * 2026-07 deep-loop drift uplift: the guard now runs THREE detectors, in
 * strictly decreasing precision. Each keeps its own thresholds; `check()`
 * reports the most severe hit (halts before warns, precise before fuzzy).
 *
 *   1. **Exact layer** (original): consecutive identical `(tool, args)`
 *      fingerprints. Warn at 3, halt at 5 (defaults).
 *
 *   2. **Cycle layer** (NEW): the exact layer only remembers the LAST
 *      fingerprint, so an A→B→A→B alternation (read file ↔ run command,
 *      each with identical args) reset the count to 1 on every step and
 *      NEVER fired. Gemini CLI's loop detection handles cycles of length
 *      > 1 for exactly this reason. We keep a small window of recent
 *      fingerprints (16) and detect trailing repetitions of a length-2..4
 *      cycle: 2 full repetitions warn, 3 halt (defaults). Uniform blocks
 *      (all-same fingerprint) are excluded — that's the exact layer's job.
 *
 *   3. **Normalized layer** (NEW): "re-read the same file with a slightly
 *      different offset/limit, eight times" produces a DIFFERENT exact
 *      fingerprint each time, so neither layer above sees it — yet it is
 *      the most common read-only spin in production. We derive a fuzzy
 *      key from `(toolName, primary target)` where the target is the
 *      file-path / url / pattern-style input field, ignoring every other
 *      argument. Consecutive same-key calls warn at 5 and halt at 9
 *      (defaults — deliberately loose, because chunked reads of a big
 *      file are legitimate). Calls with no recognisable target (e.g.
 *      TodoWrite) never count and BREAK the streak, keeping the
 *      "consecutive" semantics aligned with the exact layer.
 *
 * ────────────────────────────── Algorithm ────────────────────────────────
 *
 * Exact layer: track only the most recent fingerprint + a consecutive
 * count. Any different fingerprint resets the count to 1. On
 * `record(...)`, the new count becomes the source of truth. `check(...)`
 * is non-mutating and evaluates the PROJECTED state (as if the candidate
 * call were recorded next).
 *
 *   - At `warnThreshold` (default 3): emit a `warn` advisory the caller
 *     can prepend to the eventual `tool_result`. Tool still executes.
 *   - At `haltThreshold` (default 5): emit a `halt` directive. The caller
 *     should treat this exactly like the existing `toolCallHistory` block
 *     path — short-circuit the call with a synthetic error result, no
 *     spawn, no side effect.
 *
 * Fingerprinting reuses {@link fingerprintToolCall} from `toolCallHistory`
 * so the two trackers see "the same call" identically (transient fields
 * stripped, keys sorted, sha256 → 16-char hex).
 *
 * ──────────────────────────── Sharing model ──────────────────────────────
 *
 * The guard is a process-wide singleton (parallel to
 * `globalToolCallHistory`). All agents — main chat, fork sub-agents, typed
 * sub-agents (Explore / Plan / Debug / Verification / Coordinator),
 * imported custom agents — share one tracker. Rationale: a fork that
 * inherits its parent's degenerate call should inherit the count too. If
 * agent A has issued `echo "ok"` four times, agent B's first identical
 * call already counts as "the 5th in a row" and gets halted.
 *
 * Tests use `resetRepetitionGuardForTests()` in their `beforeEach` for
 * isolation; production paths NEVER call it.
 *
 * ──────────────────────────── Operator tuning ────────────────────────────
 *
 * The new layers read env once at construction (matches
 * `iterationStallGuard` convention):
 *
 *   - `POLE_REPETITION_CYCLE_WARN`       full cycle repeats → warn (default 2)
 *   - `POLE_REPETITION_CYCLE_HALT`       full cycle repeats → halt (default 3)
 *   - `POLE_REPETITION_NORMALIZED_WARN`  same-target streak → warn (default 5)
 *   - `POLE_REPETITION_NORMALIZED_HALT`  same-target streak → halt (default 9)
 */

import { fingerprintToolCall } from '../ai/toolCallHistory'
import { getAgentContext } from '../agents/agentContext'

export type RepetitionAdvice =
  | { level: 'allow' }
  | { level: 'warn'; consecutiveCount: number; message: string }
  | { level: 'halt'; consecutiveCount: number; message: string }

export interface RepetitionGuardOptions {
  /** Consecutive-call count that triggers a `warn` advisory. Default 3. */
  warnThreshold?: number
  /**
   * Consecutive-call count that triggers a hard `halt` (synthetic error
   * short-circuit). Default 5. Must be ≥ `warnThreshold + 1` and ≥ 2;
   * the constructor clamps both invariants.
   */
  haltThreshold?: number
  /**
   * Cycle layer — full trailing repetitions of a length-2..4 fingerprint
   * cycle that trigger a `warn`. Default 2 (i.e. the model has completed
   * the same 2-4-call loop twice in a row). Floor 2 — a single occurrence
   * of a block is not a cycle.
   */
  cycleWarnRepeats?: number
  /**
   * Cycle layer — full trailing repetitions that trigger a `halt`.
   * Default 3. Clamped to ≥ `cycleWarnRepeats + 1`.
   */
  cycleHaltRepeats?: number
  /**
   * Normalized layer — consecutive same-tool same-target calls (arguments
   * allowed to vary) that trigger a `warn`. Default 5. Floor 2.
   */
  normalizedWarnThreshold?: number
  /**
   * Normalized layer — consecutive same-tool same-target calls that
   * trigger a `halt`. Default 9 (deliberately loose: legitimate chunked
   * reads of a large file can reach 5-8). Clamped to
   * ≥ `normalizedWarnThreshold + 1`.
   */
  normalizedHaltThreshold?: number
}

export interface RepetitionGuard {
  /**
   * Pure: reports what would happen if `(toolName, input)` were recorded
   * next. Does NOT mutate the tracker — call {@link RepetitionGuard.record}
   * separately after you've decided whether to execute.
   */
  check(toolName: string, input: unknown): RepetitionAdvice
  /**
   * Record an executed (or short-circuited) call so the next `check` sees
   * it. Idempotent on identical fingerprint within one turn boundary —
   * but the caller controls "one turn" semantics, the guard just counts.
   */
  record(toolName: string, input: unknown): void
  /** Wipe state. Test-only — production paths must not call this. */
  reset(): void
  /** Snapshot for telemetry / tests. Exact-layer fields keep their legacy
   *  names (`postModel.readDegradationSignal` reads `count` / `toolName`). */
  snapshot(): {
    fingerprint: string | null
    toolName: string | null
    count: number
    /** Cycle-layer window occupancy (recent recorded calls). */
    windowLength: number
    /** Normalized-layer streak, or null when no streak is active. */
    normalized: { key: string; count: number } | null
  }
}

const DEFAULTS: Required<RepetitionGuardOptions> = {
  warnThreshold: 3,
  haltThreshold: 5,
  cycleWarnRepeats: 2,
  cycleHaltRepeats: 3,
  normalizedWarnThreshold: 5,
  normalizedHaltThreshold: 9,
}

/**
 * Recent-call window size for the cycle layer. Must hold at least
 * `maxPeriod × cycleHaltRepeats` entries (4 × 3 = 12) plus headroom so a
 * halt-level cycle is always fully visible.
 */
const CYCLE_WINDOW_SIZE = 16

/** Cycle periods the detector scans, smallest first. Period 1 is the
 *  exact layer's territory and is deliberately excluded. */
const CYCLE_PERIODS = [2, 3, 4] as const

/**
 * Input fields that identify a call's primary target for the normalized
 * layer, checked in order. Mirrors the `compactFactLedger` convention.
 * `command` is deliberately absent: normalizing a shell command to "the
 * whole string" degenerates to the exact layer, and normalizing to the
 * first token over-collapses (`git status` vs `git diff`).
 */
const NORMALIZED_TARGET_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'notebook_path',
  'url',
  'pattern',
  'glob_pattern',
] as const

const MAX_TARGET_CHARS = 160

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Collect EVERY identity field present (not just the first match) so tools
 * whose identity spans two fields stay distinct: `grep {pattern, path}`
 * calls with the same `path` but different `pattern`s must NOT collapse
 * into one key. Only argument fields OUTSIDE this list (offset, limit,
 * head_limit, context lines, …) are treated as "minor variations".
 */
function extractNormalizedTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const parts: string[] = []
  for (const key of NORMALIZED_TARGET_KEYS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) {
      const flat = v.replace(/\s+/g, ' ').trim()
      parts.push(
        flat.length > MAX_TARGET_CHARS ? flat.slice(0, MAX_TARGET_CHARS) : flat,
      )
    }
  }
  if (parts.length === 0) return null
  return parts.join(' | ')
}

function ordinalEn(n: number): string {
  if (n === 2) return '2nd'
  if (n === 3) return '3rd'
  return `${n}th`
}

function buildWarnMessage(
  toolName: string,
  consecutiveCount: number,
  haltAt: number,
): string {
  return (
    `[Repetition guard] This is the ${ordinalEn(consecutiveCount)} consecutive ` +
    `\`${toolName}\` call with identical arguments. If the next call is also ` +
    `identical it will be blocked at ${haltAt}/${haltAt}. If you're stuck, ` +
    `change tactics — different tool, materially different arguments, or stop ` +
    `with a concrete answer.`
  )
}

function buildHaltMessage(toolName: string, consecutiveCount: number): string {
  return (
    `[Repetition guard] Refusing to execute \`${toolName}\` — you have issued ` +
    `the same call with identical arguments ${consecutiveCount} times in a row. ` +
    `The orchestration layer has short-circuited this attempt to prevent a ` +
    `degenerate loop. Stop, reconsider the goal, then either pick a different ` +
    `tool, change the arguments materially, or end the turn with a concrete ` +
    `answer to the user. Re-issuing the same call will not work.`
  )
}

function describeCycle(cycleTools: ReadonlyArray<string>): string {
  return cycleTools.map((t) => `\`${t}\``).join(' → ')
}

function buildCycleWarnMessage(
  cycleTools: ReadonlyArray<string>,
  period: number,
  repeats: number,
  haltAt: number,
): string {
  return (
    `[Repetition guard] You are repeating the same ${period}-call cycle ` +
    `(${describeCycle(cycleTools)}) with identical arguments — ${repeats} full ` +
    `repetitions so far. At ${haltAt} repetitions the next call in the cycle ` +
    `will be blocked. Alternating between the same calls is not progress; ` +
    `change approach or end the turn with a concrete answer.`
  )
}

function buildCycleHaltMessage(
  cycleTools: ReadonlyArray<string>,
  period: number,
  repeats: number,
): string {
  return (
    `[Repetition guard] Refusing to execute this call — it would complete the ` +
    `${ordinalEn(repeats)} consecutive repetition of the same ${period}-call ` +
    `cycle (${describeCycle(cycleTools)}) with identical arguments. The ` +
    `orchestration layer has short-circuited this attempt to prevent a ` +
    `degenerate loop. Break the cycle: pick a materially different action, or ` +
    `end the turn with a concrete answer to the user.`
  )
}

function buildNormalizedWarnMessage(
  toolName: string,
  target: string,
  consecutiveCount: number,
  haltAt: number,
): string {
  return (
    `[Repetition guard] This is the ${ordinalEn(consecutiveCount)} consecutive ` +
    `\`${toolName}\` call against the same target (${target}) with only minor ` +
    `argument variations. At ${haltAt} consecutive calls it will be blocked. ` +
    `If earlier results did not contain what you need, re-issuing near-identical ` +
    `calls will not either — change target, change tool, or act on what you have.`
  )
}

function buildNormalizedHaltMessage(
  toolName: string,
  target: string,
  consecutiveCount: number,
): string {
  return (
    `[Repetition guard] Refusing to execute \`${toolName}\` — this is the ` +
    `${ordinalEn(consecutiveCount)} consecutive call against the same target ` +
    `(${target}) with only minor argument variations. The orchestration layer ` +
    `has short-circuited this attempt to prevent a read-spin loop. You already ` +
    `have this target's content in context (possibly truncated with a spill-file ` +
    `path you can read instead). Act on what you have, or pick a materially ` +
    `different target / tool.`
  )
}

interface WindowEntry {
  fp: string
  toolName: string
}

/**
 * Count how many times the trailing `period`-length block repeats
 * consecutively at the END of `seq` (including the trailing block itself).
 * Returns 0 when `seq` is shorter than one block.
 */
function countTrailingCycleRepeats(
  seq: ReadonlyArray<string>,
  period: number,
): number {
  if (seq.length < period) return 0
  const blockStart = seq.length - period
  let repeats = 1
  for (
    let start = blockStart - period;
    start >= 0;
    start -= period
  ) {
    let match = true
    for (let i = 0; i < period; i++) {
      if (seq[start + i] !== seq[blockStart + i]) {
        match = false
        break
      }
    }
    if (!match) break
    repeats++
  }
  return repeats
}

interface CycleHit {
  period: number
  repeats: number
  /** Tool names of the repeating block, in cycle order. */
  cycleTools: string[]
}

/**
 * Scan the projected window for a trailing length-2..4 cycle. Returns the
 * hit with the MOST repeats (ties → smallest period). Uniform blocks
 * (all entries share one fingerprint) are skipped — pure period-1
 * repetition belongs to the exact layer.
 */
function detectTrailingCycle(entries: ReadonlyArray<WindowEntry>): CycleHit | null {
  const fps = entries.map((e) => e.fp)
  let best: CycleHit | null = null
  for (const period of CYCLE_PERIODS) {
    if (fps.length < period * 2) continue
    const block = fps.slice(-period)
    if (block.every((fp) => fp === block[0])) continue
    const repeats = countTrailingCycleRepeats(fps, period)
    if (repeats < 2) continue
    if (!best || repeats > best.repeats) {
      best = {
        period,
        repeats,
        cycleTools: entries.slice(-period).map((e) => e.toolName),
      }
    }
  }
  return best
}

export function createRepetitionGuard(
  options?: RepetitionGuardOptions,
): RepetitionGuard {
  const warnRaw = options?.warnThreshold ?? DEFAULTS.warnThreshold
  const haltRaw = options?.haltThreshold ?? DEFAULTS.haltThreshold
  const haltThreshold = Math.max(2, haltRaw)
  const warnThreshold = Math.min(haltThreshold - 1, Math.max(1, warnRaw))

  const cycleWarnRaw =
    options?.cycleWarnRepeats ??
    parseIntEnv(process.env.POLE_REPETITION_CYCLE_WARN, DEFAULTS.cycleWarnRepeats)
  const cycleHaltRaw =
    options?.cycleHaltRepeats ??
    parseIntEnv(process.env.POLE_REPETITION_CYCLE_HALT, DEFAULTS.cycleHaltRepeats)
  const cycleWarnRepeats = Math.max(2, cycleWarnRaw)
  const cycleHaltRepeats = Math.max(cycleWarnRepeats + 1, cycleHaltRaw)

  const normWarnRaw =
    options?.normalizedWarnThreshold ??
    parseIntEnv(
      process.env.POLE_REPETITION_NORMALIZED_WARN,
      DEFAULTS.normalizedWarnThreshold,
    )
  const normHaltRaw =
    options?.normalizedHaltThreshold ??
    parseIntEnv(
      process.env.POLE_REPETITION_NORMALIZED_HALT,
      DEFAULTS.normalizedHaltThreshold,
    )
  const normalizedWarnThreshold = Math.max(2, normWarnRaw)
  const normalizedHaltThreshold = Math.max(
    normalizedWarnThreshold + 1,
    normHaltRaw,
  )

  // Exact layer.
  let lastFingerprint: string | null = null
  let lastToolName: string | null = null
  let count = 0

  // Cycle layer — windows are PER AGENT (audit fix, 2026-07). The exact
  // and normalized layers stay process-wide on purpose (interleaved calls
  // from parallel agents only ever BREAK their streaks — reduced
  // sensitivity, never a false positive — and the fork-inherits-count
  // rationale in the header applies). The cycle layer is different:
  // agent A repeating call X interleaved with agent B repeating call Y
  // composes a global X,Y,X,Y sequence that LOOKS like one agent's
  // 2-cycle and would halt an innocent per-agent pattern. Scoping the
  // window by ALS agent id keeps cycle detection meaningful.
  const windowsByAgent = new Map<string, WindowEntry[]>()
  const MAX_AGENT_WINDOWS = 32

  const agentKey = (): string => {
    try {
      return getAgentContext()?.agentId ?? 'main'
    } catch {
      return 'main'
    }
  }

  const windowFor = (key: string): WindowEntry[] => {
    let w = windowsByAgent.get(key)
    if (!w) {
      w = []
      if (windowsByAgent.size >= MAX_AGENT_WINDOWS) {
        const oldest = windowsByAgent.keys().next().value
        if (oldest !== undefined) windowsByAgent.delete(oldest)
      }
      windowsByAgent.set(key, w)
    }
    return w
  }

  // Normalized layer. `key` is `${toolName.toLowerCase()}::${target}`;
  // `target` is retained verbatim for advisory messages.
  let normalized: { key: string; target: string; count: number } | null = null

  const projectExactCount = (fp: string): number =>
    fp === lastFingerprint ? count + 1 : 1

  const normalizedKeyOf = (
    toolName: string,
    input: unknown,
  ): { key: string; target: string } | null => {
    const target = extractNormalizedTarget(input)
    if (!target) return null
    return { key: `${toolName.toLowerCase()}::${target}`, target }
  }

  const projectNormalizedCount = (key: string): number =>
    normalized && normalized.key === key ? normalized.count + 1 : 1

  return {
    check(toolName, input) {
      const fp = fingerprintToolCall(toolName, input)
      const projectedExact = projectExactCount(fp)
      const cycle = detectTrailingCycle([...windowFor(agentKey()), { fp, toolName }])
      const nk = normalizedKeyOf(toolName, input)
      const projectedNorm = nk ? projectNormalizedCount(nk.key) : 0

      // Halts first (precise before fuzzy), then warns (same order).
      if (projectedExact >= haltThreshold) {
        return {
          level: 'halt',
          consecutiveCount: projectedExact,
          message: buildHaltMessage(toolName, projectedExact),
        }
      }
      if (cycle && cycle.repeats >= cycleHaltRepeats) {
        return {
          level: 'halt',
          consecutiveCount: cycle.repeats,
          message: buildCycleHaltMessage(cycle.cycleTools, cycle.period, cycle.repeats),
        }
      }
      if (nk && projectedNorm >= normalizedHaltThreshold) {
        return {
          level: 'halt',
          consecutiveCount: projectedNorm,
          message: buildNormalizedHaltMessage(toolName, nk.target, projectedNorm),
        }
      }
      if (projectedExact >= warnThreshold) {
        return {
          level: 'warn',
          consecutiveCount: projectedExact,
          message: buildWarnMessage(toolName, projectedExact, haltThreshold),
        }
      }
      if (cycle && cycle.repeats >= cycleWarnRepeats) {
        return {
          level: 'warn',
          consecutiveCount: cycle.repeats,
          message: buildCycleWarnMessage(
            cycle.cycleTools,
            cycle.period,
            cycle.repeats,
            cycleHaltRepeats,
          ),
        }
      }
      if (nk && projectedNorm >= normalizedWarnThreshold) {
        return {
          level: 'warn',
          consecutiveCount: projectedNorm,
          message: buildNormalizedWarnMessage(
            toolName,
            nk.target,
            projectedNorm,
            normalizedHaltThreshold,
          ),
        }
      }
      return { level: 'allow' }
    },

    record(toolName, input) {
      const fp = fingerprintToolCall(toolName, input)
      // Exact layer.
      if (fp === lastFingerprint) {
        count += 1
      } else {
        lastFingerprint = fp
        lastToolName = toolName
        count = 1
      }
      // Cycle layer (per-agent window — see audit note above).
      const key = agentKey()
      const w = windowFor(key)
      w.push({ fp, toolName })
      if (w.length > CYCLE_WINDOW_SIZE) {
        windowsByAgent.set(key, w.slice(-CYCLE_WINDOW_SIZE))
      }
      // Normalized layer. A targetless call breaks the streak on purpose
      // (keeps "consecutive" semantics aligned with the exact layer).
      const nk = normalizedKeyOf(toolName, input)
      if (!nk) {
        normalized = null
      } else if (normalized && normalized.key === nk.key) {
        normalized.count += 1
      } else {
        normalized = { key: nk.key, target: nk.target, count: 1 }
      }
    },

    reset() {
      lastFingerprint = null
      lastToolName = null
      count = 0
      windowsByAgent.clear()
      normalized = null
    },

    snapshot() {
      return {
        fingerprint: lastFingerprint,
        toolName: lastToolName,
        count,
        windowLength: windowFor(agentKey()).length,
        normalized: normalized
          ? { key: normalized.key, count: normalized.count }
          : null,
      }
    },
  }
}

let instance: RepetitionGuard | undefined

/**
 * Process-wide singleton accessor. `options` is honoured only on the FIRST
 * call (subsequent calls return the existing instance unchanged) so callers
 * deeper in the stack don't accidentally re-tune thresholds set at startup.
 */
export function getRepetitionGuard(
  options?: RepetitionGuardOptions,
): RepetitionGuard {
  if (!instance) {
    instance = createRepetitionGuard(options)
  }
  return instance
}

/** Test-only — wipe the singleton between cases for isolation. */
export function resetRepetitionGuardForTests(): void {
  instance = undefined
}
