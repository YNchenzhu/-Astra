/**
 * Goal-drift score monitor — continuous, quantitative drift signal
 * (2026-07 deep-loop uplift, item #3).
 *
 * ## Why
 *
 * Every drift defence so far is RULE-triggered (repetition cycles, stall
 * streaks, scope checks, recitation). None of them MEASURES drift as a
 * continuous quantity, so there is no way to (a) see drift building up
 * before a rule fires, (b) tune thresholds against real sessions, or
 * (c) regression-test "did this prompt change make deep loops drift
 * more?". This collector produces that measurement: every K iterations
 * it embeds the session's OBJECTIVE (todo objective, falling back to the
 * anchored user query) and a deterministic summary of RECENT TOOL
 * ACTIVITY, and records their cosine similarity as the drift score
 * (1 ≈ on-goal, → 0 ≈ working on something unrelated).
 *
 * Scores land in three places:
 *   1. an in-memory per-conversation ring ({@link getDriftScores}) for
 *      dashboards / the judge pipeline,
 *   2. `appendixReport` telemetry (`kind: 'drift_score'`),
 *   3. when the score drops below the alert threshold, ONE informational
 *      side-channel notice per drift episode (reset on recovery) asking
 *      the model to sanity-check direction — deliberately soft; the
 *      hard interventions remain the rule-based guards.
 *
 * ## Cost / gating
 *
 * - **Opt-in** (`POLE_DRIFT_MONITOR=1`). Embedding may require loading
 *   the bundled ONNX model (~570 MB weights); silently costing that on
 *   every user's machine for telemetry is not acceptable as a default.
 * - Main chat only; every {@link DEFAULT_INTERVAL_ITERATIONS} post-tool
 *   iterations; one embed call with two texts per sample.
 * - First embedding failure LATCHES the monitor off for the process
 *   (no repeated model-load attempts / error spam).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getTodoObjective } from '../../../tools/TodoWriteTool'
import { extractCurrentUserQueryText } from '../../../context/anchorUserQuery'
import { embedTextsViaSettings } from '../../../embedding/highLevelApi'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

/** Marker for tests / telemetry greps. */
export const DRIFT_SCORE_MARKER = '[Goal drift check — host measurement]'

export const DEFAULT_INTERVAL_ITERATIONS = 10
/** Cosine below this → the soft "sanity-check direction" notice. */
export const DEFAULT_ALERT_THRESHOLD = 0.25
/** Ring size per conversation. */
export const MAX_SCORES_PER_CONVERSATION = 50

const MAX_ACTIVITY_TOOL_CALLS = 12
const MAX_ACTIVITY_CHARS = 1_500
const MAX_OBJECTIVE_CHARS = 800

export function isDriftMonitorEnabled(): boolean {
  const raw = process.env.POLE_DRIFT_MONITOR?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function intervalIterations(): number {
  return parsePositiveIntEnv(
    process.env.POLE_DRIFT_MONITOR_INTERVAL,
    DEFAULT_INTERVAL_ITERATIONS,
  )
}

function alertThreshold(): number {
  const raw = process.env.POLE_DRIFT_MONITOR_THRESHOLD
  if (!raw) return DEFAULT_ALERT_THRESHOLD
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_ALERT_THRESHOLD
}

// ─── Pure math / extraction ─────────────────────────────────────────────

/** Cosine similarity; 0 for degenerate vectors. Exported for tests. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const ACTIVITY_TARGET_KEYS = [
  'file_path', 'filePath', 'path', 'target_file', 'notebook_path',
  'url', 'pattern', 'command', 'query', 'prompt', 'subject', 'content',
] as const

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  for (const key of ACTIVITY_TARGET_KEYS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) {
      const flat = v.replace(/\s+/g, ' ').trim()
      return flat.length > 120 ? flat.slice(0, 120) : flat
    }
  }
  return ''
}

/**
 * Deterministic summary of recent activity: the last N tool_use calls
 * ("name: primary arg") plus the tail of the last assistant visible text.
 * Exported for tests.
 */
export function buildRecentActivityText(
  apiMessages: ReadonlyArray<Record<string, unknown>>,
): string {
  const calls: string[] = []
  let lastAssistantText = ''
  for (let i = apiMessages.length - 1; i >= 0 && calls.length < MAX_ACTIVITY_TOOL_CALLS; i--) {
    const msg = apiMessages[i]!
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && calls.length < MAX_ACTIVITY_TOOL_CALLS) {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const arg = describeToolInput(block.input)
        calls.push(arg ? `${name}: ${arg}` : name)
      } else if (block.type === 'text' && !lastAssistantText && typeof block.text === 'string') {
        lastAssistantText = block.text.replace(/\s+/g, ' ').trim().slice(0, 400)
      }
    }
  }
  const body = [...calls.reverse(), lastAssistantText].filter(Boolean).join('\n')
  return body.length > MAX_ACTIVITY_CHARS ? body.slice(-MAX_ACTIVITY_CHARS) : body
}

// ─── Per-conversation state ─────────────────────────────────────────────

export interface DriftSample {
  iteration: number
  score: number
  at: number
}

interface ConversationDriftState {
  samples: DriftSample[]
  /**
   * Post-tool passes observed since the last sample attempt. Audit fix
   * (2026-07): cadence MUST NOT be derived from `state.iteration` deltas —
   * the loop iteration counter RESETS every user turn while this state
   * persists per conversation, so an iteration-based "last sampled at"
   * comparison goes negative on the next turn and the monitor silently
   * never samples again. A plain tick counter is turn-agnostic.
   */
  ticksSinceSample: number
  /** True while the score sits below threshold (one notice per episode). */
  inLowEpisode: boolean
}

const stateByConversation = new Map<string, ConversationDriftState>()
const MAX_CONVERSATIONS = 32

/** Process-wide failure latch — embedding backend unusable, stop trying. */
let embedFailureLatched = false

/** Telemetry / judge accessor: recent drift samples for a conversation. */
export function getDriftScores(conversationId: string): ReadonlyArray<DriftSample> {
  return stateByConversation.get(conversationId.trim())?.samples ?? []
}

/** @internal Test-only seam. */
export function __resetDriftMonitorForTests(): void {
  stateByConversation.clear()
  embedFailureLatched = false
}

function getState(cid: string): ConversationDriftState {
  let s = stateByConversation.get(cid)
  if (s) {
    // LRU touch.
    stateByConversation.delete(cid)
    stateByConversation.set(cid, s)
    return s
  }
  s = { samples: [], ticksSinceSample: 0, inLowEpisode: false }
  stateByConversation.set(cid, s)
  while (stateByConversation.size > MAX_CONVERSATIONS) {
    const oldest = stateByConversation.keys().next().value
    if (oldest === undefined || oldest === cid) break
    stateByConversation.delete(oldest)
  }
  return s
}

function buildLowScoreNotice(score: number, objective: string): string {
  const obj = objective.replace(/\s+/g, ' ').trim().slice(0, 200)
  return (
    `${DRIFT_SCORE_MARKER}\n\n` +
    `The host's periodic goal-alignment measurement scored the similarity between ` +
    `the session objective and your recent tool activity at ${score.toFixed(2)} ` +
    `(1 = on-goal, 0 = unrelated) — unusually low.\n\n` +
    `Session objective: ${obj}\n\n` +
    `This is a measurement, not an accusation — a legitimate deep sub-task can ` +
    `score low. Take one moment to check: is your current work still in service ` +
    `of the objective? If yes, continue. If you have drifted into side work, ` +
    `return to the objective (and prune anything the user did not ask for).`
  )
}

export const driftScoreMonitorCollector: Collector = {
  name: 'drift_score_monitor',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isDriftMonitorEnabled() || embedFailureLatched) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    if ((agentCtx?.agentId ?? 'main') !== 'main') return null
    const cid = agentCtx?.streamConversationId?.trim() || 'main'

    const drift = getState(cid)
    drift.ticksSinceSample += 1
    if (drift.ticksSinceSample < intervalIterations()) {
      return null
    }

    const objective = (
      getTodoObjective(agentCtx?.agentId ?? 'main')?.trim() ||
      extractCurrentUserQueryText(state.apiMessages)?.trim() ||
      ''
    ).slice(0, MAX_OBJECTIVE_CHARS)
    if (!objective) return null

    const activity = buildRecentActivityText(state.apiMessages)
    if (!activity) return null

    // Reset the tick counter BEFORE the async embed so a slow/failed call
    // is not retried on the very next iteration.
    drift.ticksSinceSample = 0

    let score: number
    try {
      const r = await embedTextsViaSettings([objective, activity])
      if (!r.ok || r.vectors.length < 2) {
        embedFailureLatched = true
        console.warn(
          `[driftScoreMonitor] embedding unavailable (${r.error ?? 'no vectors'}); ` +
            'latching the monitor off for this process.',
        )
        return null
      }
      score = cosineSimilarity(r.vectors[0]!, r.vectors[1]!)
    } catch (e) {
      embedFailureLatched = true
      console.warn('[driftScoreMonitor] embed threw; latching off:', e)
      return null
    }

    drift.samples.push({ iteration: state.iteration, score, at: Date.now() })
    if (drift.samples.length > MAX_SCORES_PER_CONVERSATION) {
      drift.samples = drift.samples.slice(-MAX_SCORES_PER_CONVERSATION)
    }

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'drift_score',
      score: Number(score.toFixed(4)),
      objectiveChars: objective.length,
      activityChars: activity.length,
    })

    const threshold = alertThreshold()
    if (score >= threshold) {
      drift.inLowEpisode = false
      return null
    }
    if (drift.inLowEpisode) return null
    drift.inLowEpisode = true

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          buildLowScoreNotice(score, objective),
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
