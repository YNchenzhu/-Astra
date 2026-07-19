/**
 * upstream §8 / §9 — memory-related flags (env + disk settings).
 * GrowthBook 等价：以环境变量为主，settings JSON 可覆盖。
 *
 * Note: Memory extraction uses the inline LLM pipeline in `autoExtract.ts`.
 * A forked durable extract agent (`tengu_passport_quail`) was considered but
 * not adopted — the inline pipeline provides equivalent quality with lower
 * overhead and fewer failure modes.
 */

import { readDiskSettings } from '../settings/settingsAccess'

function envOn(v: string | undefined): boolean {
  if (!v) return false
  const x = v.trim().toLowerCase()
  return x === '1' || x === 'true' || x === 'yes' || x === 'on'
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v?.trim()) return fallback
  const n = Number.parseInt(v.trim(), 10)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

export type MemoryFeatureFlags = {
  /** CLAUDE_CODE_DISABLE_AUTO_MEMORY / POLE_DISABLE_AUTO_MEMORY */
  disableAutoMemory: boolean
  /** CLAUDE_CODE_SIMPLE / POLE_SIMPLE_MODE */
  simpleMode: boolean
  /** Remote memory layout (hint only; host may still use workspace paths) */
  remoteMode: boolean
  remoteMemoryDir: string | undefined
  memoryPathOverride: string | undefined
  extraGuidelines: string | undefined
  /** tengu_session_memory — background session-memory extract */
  sessionMemoryEnabled: boolean
  /** tengu_sm_compact */
  sessionMemoryCompactEnabled: boolean
  /** tengu_herring_clock — include team-memory index in prompt */
  teamMemoryInPrompt: boolean
  /**
   * tengu_moth_copse — skip MEMORY.md index sections in memory system prompt.
   *
   * @deprecated 2026-05 cleanup — the "## Current memory index" section
   * that this flag gated was removed from `buildMemorySystemPrompt`
   * (industry alignment with upstream's `settingSources: ['project']`
   * opt-in model). Setting this flag is now a no-op; left in place so
   * existing settings.json files don't fail validation. Safe to remove
   * along with the corresponding Settings UI once the rollout window
   * closes.
   */
  skipMemoryIndexInPrompt: boolean
  /** tengu_kairos — daily log mode notes in prompt */
  kairosDailyLogEnabled: boolean
  /** tengu_bramble_lintel — run auto extract every N-th completion (1 = each time) */
  memoryExtractThrottleN: number
  /** tengu_slate_thimble */
  extractInNonInteractive: boolean
  /** tengu_coral_fern — inject “search past context / memory” guidance into memory system prompt */
  pastContextSearchPromptEnabled: boolean
}

export function getMemoryFeatureFlags(): MemoryFeatureFlags {
  const s = readDiskSettings() as Record<string, unknown>

  const disableAutoMemory =
    envOn(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) ||
    envOn(process.env.POLE_DISABLE_AUTO_MEMORY) ||
    s.disableAutoMemoryGlobally === true

  const simpleMode =
    envOn(process.env.CLAUDE_CODE_SIMPLE) || envOn(process.env.POLE_SIMPLE_MODE)

  const remoteMode = envOn(process.env.CLAUDE_CODE_REMOTE) || envOn(process.env.POLE_MEMORY_REMOTE)

  const remoteMemoryDir =
    typeof process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR === 'string' && process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR.trim()
      ? process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR.trim()
      : typeof process.env.POLE_REMOTE_MEMORY_DIR === 'string' && process.env.POLE_REMOTE_MEMORY_DIR.trim()
        ? process.env.POLE_REMOTE_MEMORY_DIR.trim()
        : typeof s.remoteMemoryDir === 'string' && String(s.remoteMemoryDir).trim()
          ? String(s.remoteMemoryDir).trim()
          : undefined

  const memoryPathOverride =
    typeof process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE === 'string' &&
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE.trim()
      ? process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE.trim()
      : typeof process.env.POLE_MEMORY_PATH_OVERRIDE === 'string' && process.env.POLE_MEMORY_PATH_OVERRIDE.trim()
        ? process.env.POLE_MEMORY_PATH_OVERRIDE.trim()
        : undefined

  const extraGuidelines =
    typeof process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES === 'string' &&
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES.trim()
      ? process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES.trim()
      : typeof process.env.POLE_MEMORY_EXTRA_GUIDELINES === 'string' &&
          process.env.POLE_MEMORY_EXTRA_GUIDELINES.trim()
        ? process.env.POLE_MEMORY_EXTRA_GUIDELINES.trim()
        : typeof s.memoryExtraGuidelines === 'string' && String(s.memoryExtraGuidelines).trim()
          ? String(s.memoryExtraGuidelines).trim()
          : undefined

  const poleSm = process.env.POLE_SESSION_MEMORY
  const sessionMemoryFromEnv =
    poleSm === undefined ? undefined : !(poleSm === '0' || poleSm.toLowerCase() === 'false')
  const sessionMemoryEnabled =
    sessionMemoryFromEnv !== undefined
      ? sessionMemoryFromEnv
      : s.sessionMemoryEnabled === undefined
        ? true
        : s.sessionMemoryEnabled !== false

  let sessionMemoryCompactEnabled = false
  if (envOn(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT) || envOn(process.env.POLE_SM_COMPACT)) {
    sessionMemoryCompactEnabled = true
  }
  if (envOn(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT) || envOn(process.env.DISABLE_POLE_SM_COMPACT)) {
    sessionMemoryCompactEnabled = false
  }
  if (s.sessionMemoryCompactEnabled === true) sessionMemoryCompactEnabled = true
  if (s.sessionMemoryCompactEnabled === false) sessionMemoryCompactEnabled = false

  const teamMemoryInPrompt =
    envOn(process.env.POLE_TEAM_MEMORY_PROMPT) || s.teamMemoryInPrompt === true

  const skipMemoryIndexInPrompt =
    envOn(process.env.POLE_MEMORY_SKIP_INDEX) || s.memorySkipIndexInPrompt === true

  const kairosDailyLogEnabled =
    envOn(process.env.POLE_KAIROS_LOG) || s.kairosDailyLogEnabled === true

  const throttleN = parsePositiveInt(process.env.POLE_MEMORY_EXTRACT_EVERY_N, 1)
  const diskN =
    typeof s.memoryExtractThrottleN === 'number' && s.memoryExtractThrottleN >= 1
      ? Math.floor(s.memoryExtractThrottleN)
      : 1
  const memoryExtractThrottleN = Math.max(1, throttleN, diskN)

  const extractInNonInteractive =
    envOn(process.env.POLE_MEMORY_EXTRACT_NON_INTERACTIVE) || s.memoryExtractNonInteractive === true

  const pastContextSearchPromptEnabled =
    envOn(process.env.POLE_CORAL_FERN) ||
    envOn(process.env.POLE_MEMORY_PAST_CONTEXT_HINT) ||
    s.memoryPastContextSearchHint === true

  return {
    disableAutoMemory,
    simpleMode,
    remoteMode,
    remoteMemoryDir,
    memoryPathOverride,
    extraGuidelines,
    sessionMemoryEnabled,
    sessionMemoryCompactEnabled,
    teamMemoryInPrompt,
    skipMemoryIndexInPrompt,
    kairosDailyLogEnabled,
    memoryExtractThrottleN,
    extractInNonInteractive,
    pastContextSearchPromptEnabled,
  }
}

export function isAutoMemoryGloballyDisabled(): boolean {
  const f = getMemoryFeatureFlags()
  return f.disableAutoMemory || f.simpleMode
}

/**
 * upstream §8 `tengu_slate_thimble` — host sessions that are not user-interactive
 * (CI, headless, or explicit POLE_NON_INTERACTIVE) skip auto memory extract unless the flag allows it.
 */
export function isLikelyNonInteractiveHostSession(): boolean {
  return (
    envOn(process.env.POLE_NON_INTERACTIVE) ||
    envOn(process.env.CI) ||
    process.env.ELECTRON_RUN_AS_NODE === '1'
  )
}
