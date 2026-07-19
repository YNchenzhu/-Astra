/**
 * Auto-memory write loop — Phase E of upstream alignment.
 *
 * upstream automatically captures durable signals from the
 * conversation (corrections the user gives, explicit preferences,
 * positive confirmations) into per-user memory files so future
 * sessions don't repeat the same mistakes. The existing
 * `autoExtract.ts` LLM-based extractor is the heavy version that runs
 * at session end; this module is the lightweight per-turn capture
 * that fires immediately based on plain-text pattern detection.
 *
 * Detection is intentionally conservative — false-positives bloat the
 * memory store and hurt retrieval quality, so the patterns require an
 * explicit imperative marker. Detection runs on the previous
 * assistant text + current user text only; we never replay history.
 *
 * Production effects are gated by `POLE_AUTO_MEMORY_CAPTURE` (default
 * off) until the team confirms write quality from log review. The
 * module returns a captured-signal record either way so callers can
 * surface a renderer notification.
 */

import { createMemory } from './service'

export type AutoMemorySignalKind = 'correction' | 'preference' | 'success'

export interface AutoMemorySignal {
  kind: AutoMemorySignalKind
  /** Short verbatim quote from the user message that triggered detection. */
  excerpt: string
  /** Human-friendly summary line — also used as the memory description. */
  description: string
}

export interface AutoMemoryWriteAttempt {
  conversationId: string
  signal: AutoMemorySignal
  /** True when the write actually hit disk (capture flag on + service succeeded). */
  written: boolean
  /** Filename created when `written === true`. */
  memoryFilename?: string
  /** Reason a write was skipped (flag off, duplicate, error message). */
  skipReason?: string
}

interface ConversationCaptureState {
  /** Set of `kind|excerpt` keys captured this conversation to dedupe. */
  capturedKeys: Set<string>
}

/**
 * Audit fix (P2) — bounded per-conversation capture state. Same
 * rationale as `systemReminderInjector`: long-running Electron mains
 * shouldn't accumulate one bucket per conversation forever.
 */
const MAX_BUCKETS_AUTOMEM = 32

const states = new Map<string, ConversationCaptureState>()

function isCaptureEnabled(): boolean {
  return process.env.POLE_AUTO_MEMORY_CAPTURE === '1'
}

function getState(conversationId: string): ConversationCaptureState {
  const existing = states.get(conversationId)
  if (existing) {
    states.delete(conversationId)
    states.set(conversationId, existing)
    return existing
  }
  const fresh: ConversationCaptureState = { capturedKeys: new Set() }
  states.set(conversationId, fresh)
  while (states.size > MAX_BUCKETS_AUTOMEM) {
    const oldest = states.keys().next().value
    if (oldest === undefined || oldest === conversationId) break
    states.delete(oldest)
  }
  return fresh
}

// ─── Detection ──────────────────────────────────────────────────────

/**
 * Audit fix (P3) — tightened Chinese correction patterns. The previous
 * heuristics matched `不是`/`不要` anywhere in the turn (so "我不是想问 X"
 * was misclassified as a correction). The new set requires either a
 * leading position or a stronger imperative wrapper, cutting false
 * positives without losing real corrections.
 */
const CORRECTION_PATTERNS: RegExp[] = [
  /\b(no|nope|not)\s+(quite|exactly|right|that|like|the)\b/iu,
  /\b(stop|don't|do not)\s+(do|use|run|create|write|make)\b/iu,
  /\b(that's|this is)\s+(wrong|incorrect|the wrong)\b/iu,
  /\b(wrong|incorrect|mistake)\b/iu,
  // Leading "不对" / "不是这样" — strong correction signal at the head of the turn.
  /^[\s\p{P}]*(不对|不是这样|不该|不应该|这不对|这不行|搞错了|理解错了|你弄错了)/u,
  // Imperative correction wrappers anywhere in the turn.
  /(应该(?!没|不))[\s\S]{0,16}(改|换|用|做|是)/u,
  /(改成|改用|换成|换个|换一个|不要再)/u,
  /(别(这样|这么|那样))/u,
]

const PREFERENCE_PATTERNS: RegExp[] = [
  /\b(remember|always|never|prefer|please use)\b/iu,
  /\b(from now on|going forward)\b/iu,
  /(记住|记下|偏好|总是|从此以后|以后都|永远)/u,
  /(我喜欢|我希望|我要求|我倾向于)/u,
]

const SUCCESS_PATTERNS: RegExp[] = [
  /\b(perfect|great|exactly|nice|works?|that's it)\b/iu,
  /\b(keep doing|keep that|that pattern)\b/iu,
  /(完美|不错|对了|就是这样|继续这样|这样很好)/u,
]

function matchAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text))
}

function shortenExcerpt(text: string, max = 140): string {
  const trimmed = text.trim().replace(/\s+/gu, ' ')
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

/**
 * Detect at most one signal per turn (highest-priority kind wins). The
 * order — correction > preference > success — mirrors which signal we
 * most want recorded: a correction is the strongest "do not repeat this
 * mistake" signal.
 */
export function detectAutoMemorySignal(input: {
  previousAssistantText?: string
  currentUserText: string
}): AutoMemorySignal | null {
  const user = input.currentUserText.trim()
  if (!user || user.length < 4) return null
  const excerpt = shortenExcerpt(user)

  if (matchAny(CORRECTION_PATTERNS, user)) {
    const tail = (input.previousAssistantText ?? '').trim().slice(-160)
    return {
      kind: 'correction',
      excerpt,
      description: tail
        ? `User corrected the assistant. Their reply: "${excerpt}".`
        : `User correction: "${excerpt}".`,
    }
  }
  if (matchAny(PREFERENCE_PATTERNS, user)) {
    return {
      kind: 'preference',
      excerpt,
      description: `Explicit user preference: "${excerpt}".`,
    }
  }
  if (matchAny(SUCCESS_PATTERNS, user)) {
    return {
      kind: 'success',
      excerpt,
      description: `User confirmed approach worked: "${excerpt}".`,
    }
  }
  return null
}

// ─── Write loop ─────────────────────────────────────────────────────

function buildMemoryNameForSignal(signal: AutoMemorySignal, ts: number): string {
  const slug = signal.excerpt
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const stamp = new Date(ts).toISOString().slice(0, 10)
  return `auto-${signal.kind}-${stamp}-${slug || 'memo'}`
}

/**
 * Inspect the latest user turn and, when a signal is detected, capture
 * it as a per-user memory entry. Returns a `null` when no signal fires
 * and a record otherwise (regardless of whether the write actually
 * happened).
 */
export function captureAutoMemorySignal(input: {
  conversationId: string
  previousAssistantText?: string
  currentUserText: string
  /** Override for `POLE_AUTO_MEMORY_CAPTURE` — used by tests. */
  forceEnabled?: boolean
  /** Override for `Date.now()` — used by tests. */
  now?: number
}): AutoMemoryWriteAttempt | null {
  const conv = input.conversationId.trim()
  if (!conv) return null
  const signal = detectAutoMemorySignal({
    previousAssistantText: input.previousAssistantText,
    currentUserText: input.currentUserText,
  })
  if (!signal) return null

  const state = getState(conv)
  const key = `${signal.kind}|${signal.excerpt}`
  if (state.capturedKeys.has(key)) {
    return {
      conversationId: conv,
      signal,
      written: false,
      skipReason: 'duplicate-signal-in-conversation',
    }
  }
  state.capturedKeys.add(key)

  const enabled = input.forceEnabled ?? isCaptureEnabled()
  if (!enabled) {
    return {
      conversationId: conv,
      signal,
      written: false,
      skipReason: 'capture-flag-disabled',
    }
  }

  const ts = input.now ?? Date.now()
  const name = buildMemoryNameForSignal(signal, ts)
  try {
    const entry = createMemory({
      name,
      description: signal.description,
      type: signal.kind === 'correction' || signal.kind === 'success' ? 'feedback' : 'user',
      scope: 'user',
      tags: ['auto-memory', `auto:${signal.kind}`],
      content: [
        `# ${signal.kind.toUpperCase()} — captured ${new Date(ts).toISOString()}`,
        '',
        `Conversation: ${conv}`,
        '',
        '## Signal',
        '',
        '```',
        signal.excerpt,
        '```',
        '',
        '## Context',
        '',
        (input.previousAssistantText ?? '').trim() ||
          '(no preceding assistant turn captured)',
      ].join('\n'),
    })
    return {
      conversationId: conv,
      signal,
      written: true,
      memoryFilename: entry.filename,
    }
  } catch (err) {
    return {
      conversationId: conv,
      signal,
      written: false,
      skipReason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** @internal Test-only seam. */
export function __resetAutoMemoryWriteLoopForTests(): void {
  states.clear()
}
