/**
 * Destructive long-run context-injection stress test —
 * 50 user rounds × 120 tool executions per round (6 000 tool calls total).
 *
 * Purpose: verify that the context injected to the model after extreme
 * sustained pressure does NOT cause the failure modes the 2026-06 audits
 * targeted — forgetting what the user asked for, forgetting what was done,
 * attention dilution, intent drift across compact boundaries.
 *
 * Factors deliberately mixed in (per the stress profile):
 *   - `thinking` blocks on every assistant turn (+ periodic
 *     `redacted_thinking`) — exercises orphan-thinking filtering,
 *     trailing-thinking stripping, and thinking-block wire invariants.
 *   - tool results both SUCCESS and ERROR (≈1/9 error rate, with
 *     periodic >8 KB error payloads) — exercises error-body truncation,
 *     fact-ledger success/error tallies, and is_error preservation
 *     through micro-compact / idle-clear.
 *   - skill factors — `skillDiscovery` side-channel injection,
 *     `recordInvokedSkill` + post-compact `<invoked-skills>` reinjection,
 *     periodic `activeSkillReminder` messages.
 *   - host side-channel reminders (staleTodoNudge) injected post_tool,
 *     mirroring the production `runCollectors` push_message path.
 *
 * The pipeline per iteration mirrors production:
 *   assistant(thinking + 10×tool_use + text) → user(10×tool_result)
 *   → optional side-channel reminders → iteration normalize
 *   (stripInternalMeta:false, applyConsecutiveUserMerge:false)
 *   → ContextManager.handleContext (real tier logic: soft_clear /
 *     history_snip / micro_compact / auto_compact / block)
 * with the auto-compact LLM call mocked to a deterministic summary so the
 * run is hermetic — everything else (verbatim user-turn preservation,
 * fact ledger, post-compact attachments, pairing repair) is REAL code.
 *
 * Wire builds (what the model actually receives) are validated with the
 * production wire path: normalizeMessagesForAPI(stripInternalMeta:true,
 * applyAnthropicInvariants:true) + anchorCurrentUserQuery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContextManager } from './manager'
import type { CompactOptions } from './compact'
import {
  extractVerbatimUserMessages,
  formatVerbatimUserTurnsBlock,
  MAX_VERBATIM_BLOCK_CHARS,
  VERBATIM_HEAD_KEEP,
  VERBATIM_TAIL_KEEP,
} from './compact'
import {
  buildCompactToolFactLedger,
  tallyToolExecutions,
  MAX_TARGETS_PER_STATUS,
} from './compactFactLedger'
import { normalizeMessagesForAPI } from './normalizeMessagesForAPI'
import {
  anchorCurrentUserQuery,
  USER_QUERY_OPEN_TAG,
  USER_QUERY_CLOSE_TAG,
} from './anchorUserQuery'
import { findLastCompactBoundaryIndex, hasCompactBoundary } from './compactBoundary'
import { estimateConversationTokens } from './tokenCounter'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../constants/sideChannelKinds'
import {
  recordInvokedSkill,
  resetInvokedSkillsRegistryForTests,
} from '../skills/invokedSkillsRegistry'
import { asAgentId } from '../tools/ids'
import { resetPostCompactCleanupDedupeForTests } from '../agents/postCompactCleanup'
import { silenceExpectedConsoleWarnAndError } from '../testHelpers/silenceExpectedConsole'

// ─── Deterministic auto-compact summarizer (hermetic LLM substitute) ──
//
// Models the load-bearing part of the production compact contract: the
// summarizer must carry the user's original intent forward, "quoted
// verbatim where load-bearing" (BASE_COMPACT_PROMPT items 1 and 12). The
// mock scans its input window for the scenario's intent sentinels（总目标 /
// 纠正）and echoes any it finds — so once an old compact-summary message
// overflows the preserved-chain budget and is re-summarized, its key user
// quotes survive into the new summary exactly as a competent LLM would
// keep them. Everything else about the summary is a fixed string.
vi.mock('../ai/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ai/client')>()
  return {
    ...orig,
    streamText: vi.fn(
      async (
        _config: unknown,
        params: unknown,
        callbacks: {
          onTextDelta?: (t: string) => void
          onMessageEnd?: () => void
          onError?: (e: string) => void
        },
      ) => {
        const body =
          (params as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content
        const text = typeof body === 'string' ? body : ''
        const quoted: string[] = []
        for (const re of [/总目标：[^\n]*/, /纠正：[^\n]*/]) {
          const m = text.match(re)
          if (m) quoted.push(`- 用户原话（逐字保留）: ${m[0]}`)
        }
        callbacks.onTextDelta?.(
          '<analysis>deterministic scratchpad (discarded)</analysis>\n' +
            `<summary>\nSummary:\n- [mock-summarizer] recap of the summarized window\n${quoted.join('\n')}\n</summary>`,
        )
        callbacks.onMessageEnd?.()
      },
    ),
  }
})

silenceExpectedConsoleWarnAndError()

type Msg = Record<string, unknown>

// ─── Stress profile ───────────────────────────────────────────────────
const ROUNDS = 50
const ITERATIONS_PER_ROUND = 12
const TOOLS_PER_ITERATION = 10 // 12 × 10 = 120 tool executions per round
const TOTAL_EXPECTED_CALLS = ROUNDS * ITERATIONS_PER_ROUND * TOOLS_PER_ITERATION

const SYSTEM_PROMPT = 'You are the IDE agent under destructive context stress testing.'
const TOOL_DEFS_TOKENS = 6_000
const MODEL = 'claude-sonnet-4-6'
const AGENT_ID = 'stress-main'

// Anchor facts whose survival defines "did the AI forget".
const CORE_REQUIREMENT =
  '总目标：把 PaymentService 的退款逻辑改成幂等（idempotent refund），保持公开 API 兼容，不许改动数据库 schema 之外随意发挥'
const MID_RUN_CORRECTION =
  '纠正：刚才说错了，重试窗口必须是 48 小时而不是 24 小时，所有相关常量都要用 RETRY_WINDOW_HOURS=48'
const FINAL_QUERY = '最后一轮：给我汇总这 50 轮里所有已验证完成的修改清单'
const SKILL_NAME = 'refund-idempotency-checklist'
const SKILL_PATH = 'g:/fake/.claude/skills/refund-idempotency-checklist/SKILL.md'

// Both naming conventions, mutating + read-only + MCP-style + unknown tools.
const TOOL_CYCLE = [
  'read_file',
  'grep',
  'edit_file',
  'bash',
  'write_file',
  'web_fetch',
  'mcp__tracker__query',
  'Glob',
  'PowerShell',
  'list_files',
] as const

interface GroundTruth {
  calls: number
  success: number
  error: number
  perTool: Map<string, { success: number; error: number }>
}

function newGroundTruth(): GroundTruth {
  return { calls: 0, success: 0, error: 0, perTool: new Map() }
}

function isErrorCall(globalCallIdx: number): boolean {
  return globalCallIdx % 9 === 0
}

function isHugeErrorCall(globalCallIdx: number): boolean {
  return globalCallIdx % 500 === 0
}

function isStructuredResultCall(globalCallIdx: number): boolean {
  return globalCallIdx % 37 === 0
}

const SUCCESS_FILLER = '处理完成，输出校验一致。'.repeat(16) // ~400 chars
const THINKING_FILLER = '推理：核对本批目标文件与重试窗口常量，确认幂等键生成路径。'.repeat(8)

function buildToolUse(round: number, iter: number, k: number, globalCallIdx: number): Msg {
  const name = TOOL_CYCLE[k % TOOL_CYCLE.length]
  const id = `tu_r${round}_i${iter}_k${k}`
  const input: Record<string, unknown> =
    name === 'bash' || name === 'PowerShell'
      ? { command: `run-check --module m${round} --batch ${iter} --slot ${k}` }
      : { file_path: `g:/fake/src/m${round}/f${iter}_${k}.ts` }
  if (name === 'grep' || name === 'mcp__tracker__query') {
    input.query = `RETRY_WINDOW_HOURS round=${round}`
  }
  void globalCallIdx
  return { type: 'tool_use', id, name, input }
}

function buildToolResult(round: number, iter: number, k: number, globalCallIdx: number, truth: GroundTruth): Msg {
  const name = TOOL_CYCLE[k % TOOL_CYCLE.length]
  const id = `tu_r${round}_i${iter}_k${k}`
  const err = isErrorCall(globalCallIdx)

  truth.calls++
  const t = truth.perTool.get(name) ?? { success: 0, error: 0 }
  if (err) {
    truth.error++
    t.error++
  } else {
    truth.success++
    t.success++
  }
  truth.perTool.set(name, t)

  if (err) {
    const body = isHugeErrorCall(globalCallIdx)
      ? `Error: stack overflow in batch r${round}/i${iter}/k${k}\n${'at frame X / heap dump line……'.repeat(500)}`
      : `Error: ENOENT g:/fake/src/m${round}/f${iter}_${k}.ts (call #${globalCallIdx})`
    return { type: 'tool_result', tool_use_id: id, content: body, is_error: true }
  }
  if (isStructuredResultCall(globalCallIdx)) {
    return {
      type: 'tool_result',
      tool_use_id: id,
      content: [
        { type: 'text', text: `structured ok r${round}/i${iter}/k${k} — ${SUCCESS_FILLER}` },
      ],
      is_error: false,
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: `ok r${round}/i${iter}/k${k}: ${SUCCESS_FILLER}`,
    is_error: false,
  }
}

function buildAssistantTurn(round: number, iter: number, baseCallIdx: number): Msg {
  const content: Msg[] = [
    { type: 'thinking', thinking: `r${round}/i${iter} ${THINKING_FILLER}` },
  ]
  if (iter % 10 === 0) {
    content.push({ type: 'redacted_thinking', data: `redacted-r${round}-i${iter}` })
  }
  for (let k = 0; k < TOOLS_PER_ITERATION; k++) {
    content.push(buildToolUse(round, iter, k, baseCallIdx + k))
  }
  content.push({
    type: 'text',
    text: `第 ${round} 轮第 ${iter} 批：执行 ${TOOLS_PER_ITERATION} 个工具，继续核对退款幂等改造。`,
  })
  return { role: 'assistant', content }
}

function buildToolResultTurn(round: number, iter: number, baseCallIdx: number, truth: GroundTruth): Msg {
  const blocks: Msg[] = []
  for (let k = 0; k < TOOLS_PER_ITERATION; k++) {
    blocks.push(buildToolResult(round, iter, k, baseCallIdx + k, truth))
  }
  return { role: 'user', content: blocks }
}

function userTextForRound(round: number): string {
  if (round === 1) return CORE_REQUIREMENT
  if (round === 25) return MID_RUN_CORRECTION
  if (round === ROUNDS) return FINAL_QUERY
  return `第 ${round} 轮：继续按总目标处理模块 m${round}，不要偏离幂等改造主线。`
}

// Mirrors the iteration-end state writeback call site
// (electron/orchestration/phases/iteration.ts, audit-fixed flags).
function iterationNormalize(messages: Msg[]): Msg[] {
  return normalizeMessagesForAPI(messages, {
    stripInternalMeta: false,
    applyConsecutiveUserMerge: false,
    strictThinkingEcho: false,
    preserveThinkingOnlyAssistant: true,
  })
}

// Mirrors the wire-bound call site (electron/ai/streamHandler.ts) + the
// <user-query> anchor pass.
function buildWire(messages: Msg[]): Msg[] {
  const normalized = normalizeMessagesForAPI(
    messages.map((m) => ({ ...m })),
    {
      stripInternalMeta: true,
      applyAnthropicInvariants: true,
      strictThinkingEcho: false,
    },
  )
  return anchorCurrentUserQuery(normalized)
}

function collectAllText(messages: Msg[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const c = m.content
    if (typeof c === 'string') {
      parts.push(c)
      continue
    }
    if (!Array.isArray(c)) continue
    for (const b of c as Msg[]) {
      if (typeof b.text === 'string') parts.push(b.text)
      if (typeof b.thinking === 'string') parts.push(b.thinking)
      if (typeof b.content === 'string') parts.push(b.content)
      if (Array.isArray(b.content)) {
        for (const inner of b.content as Msg[]) {
          if (typeof inner.text === 'string') parts.push(inner.text)
        }
      }
    }
  }
  return parts.join('\n')
}

/** Anthropic wire contract: every tool_use must have its tool_result in the
 *  IMMEDIATELY following user message; no orphans in either direction. */
function assertToolPairingOnWire(wire: Msg[], label: string): void {
  const seenResultIds = new Set<string>()
  for (const m of wire) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as Msg[]) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        seenResultIds.add(b.tool_use_id)
      }
    }
  }
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const ids = (m.content as Msg[])
      .filter((b) => b.type === 'tool_use')
      .map((b) => String(b.id))
    if (ids.length === 0) continue
    const next = wire[i + 1]
    expect(next, `${label}: assistant@${i} has tool_use but no following message`).toBeDefined()
    expect(next!.role, `${label}: message after tool_use assistant@${i} must be user`).toBe('user')
    const nextIds = new Set(
      (Array.isArray(next!.content) ? (next!.content as Msg[]) : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => String(b.tool_use_id)),
    )
    for (const id of ids) {
      expect(nextIds.has(id), `${label}: tool_use ${id} not paired in next user message`).toBe(true)
    }
  }
  // Reverse direction: every tool_result must reference a tool_use that
  // exists somewhere earlier on the wire.
  const useIds = new Set<string>()
  for (const m of wire) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content as Msg[]) {
      if (b.type === 'tool_use') useIds.add(String(b.id))
    }
  }
  for (const id of seenResultIds) {
    expect(useIds.has(id), `${label}: orphan tool_result ${id} (no tool_use)`).toBe(true)
  }
}

function assertWireHygiene(wire: Msg[], label: string): void {
  expect(wire.length, `${label}: wire empty`).toBeGreaterThan(0)
  expect(wire[0].role, `${label}: first wire message must be user`).toBe('user')

  for (const [i, m] of wire.entries()) {
    // No internal metadata may leak to the provider.
    for (const key of Object.keys(m)) {
      expect(key.startsWith('_'), `${label}: internal field ${key} leaked at wire[${i}]`).toBe(false)
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content as Msg[]
      expect(blocks.length, `${label}: empty assistant content at wire[${i}]`).toBeGreaterThan(0)
      const nonThinking = blocks.filter(
        (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
      )
      expect(
        nonThinking.length,
        `${label}: thinking-only assistant survived to wire[${i}] (non-strict mode)`,
      ).toBeGreaterThan(0)
      expect(
        blocks[blocks.length - 1].type,
        `${label}: assistant at wire[${i}] ends with thinking`,
      ).not.toBe('thinking')
    }
    // Error tool_result bodies must stay within the 8 KB sanitization cap.
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content as Msg[]) {
        if (b.type === 'tool_result' && b.is_error === true && typeof b.content === 'string') {
          expect(
            b.content.length,
            `${label}: error tool_result exceeds sanitization cap`,
          ).toBeLessThanOrEqual(8_200)
        }
      }
    }
  }
  assertToolPairingOnWire(wire, label)
}

/** Hard invariant — throws on the first reverse-orphan tool_result
 *  (a result whose originating tool_use no longer exists). This is the
 *  exact shape Anthropic rejects with a 400, so it must NEVER appear in
 *  live state at any point of the run. */
function scanForOrphans(messages: Msg[], stage: string): void {
  const useIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content as Msg[]) {
        if (b.type === 'tool_use') useIds.add(String(b.id))
      }
    }
  }
  for (const [mi, m] of messages.entries()) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as Msg[]) {
      if (b.type === 'tool_result' && !useIds.has(String(b.tool_use_id))) {
        const dump = messages
          .slice(Math.max(0, mi - 3), mi + 2)
          .map((x, xi) => ({
            idx: Math.max(0, mi - 3) + xi,
            role: x.role,
            kind: x._sideChannelKind ?? null,
            content:
              typeof x.content === 'string'
                ? (x.content as string).slice(0, 80)
                : (x.content as Msg[]).map((bb) => `${bb.type}:${bb.id ?? bb.tool_use_id ?? ''}`),
          }))
        throw new Error(
          `ORPHAN ${b.tool_use_id} at msg[${mi}/${messages.length}] stage=${stage}\n${JSON.stringify(dump, null, 1)}`,
        )
      }
    }
  }
}

interface RoundStat {
  round: number
  msgCount: number
  estTokens: number
  compactCount: number
  failures: number
}

interface RunResult {
  messages: Msg[]
  truth: GroundTruth
  mgr: ContextManager
  /** Wire snapshot taken right after the FIRST auto-compact completed. */
  wireAfterFirstAutoCompact: Msg[] | null
  tierCounts: Record<string, number>
  roundStats: RoundStat[]
}

async function runDestructiveSimulation(): Promise<RunResult> {
  // No constructor thresholds — the manager derives tiers dynamically from
  // the model's context window (the production path for known models).
  // POLE_CONTEXT_WINDOW_TOKENS shrinks the window so the full ladder
  // (soft_clear → micro_compact → auto_compact) fires many times across
  // the 50-round run instead of once near the end.
  const mgr = new ContextManager()
  const truth = newGroundTruth()
  const tierCounts: Record<string, number> = {}
  const roundStats: RoundStat[] = []
  let messages: Msg[] = []
  let wireAfterFirstAutoCompact: Msg[] | null = null
  let globalCallIdx = 1

  // Conversation scaffolding: user-meta context + first-iteration skill
  // discovery, exactly like a fresh production session.
  messages.push(
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.userMetaContext,
      `<workspace>g:/fake</workspace>\n<date>2026-06-13</date>`,
    ),
  )
  messages.push(
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.skillDiscovery,
      `<skill-instructions>\nSKILL ${SKILL_NAME}: 改退款逻辑前必须先跑 typecheck，幂等键 = orderId+attemptNo。\n</skill-instructions>`,
    ),
  )
  recordInvokedSkill({
    skillName: SKILL_NAME,
    skillPath: SKILL_PATH,
    content: 'SKILL body: typecheck first; idempotency key = orderId+attemptNo.',
    agentId: asAgentId(AGENT_ID),
  })

  const compactOptions = (msgs: Msg[]): CompactOptions => ({
    config: { id: 'mock', name: 'mock', apiKey: 'x' } as unknown as CompactOptions['config'],
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    messages: msgs,
    signal: new AbortController().signal,
    agentId: AGENT_ID,
    transcriptPath: 'g:/fake/.conversations/stress-50x120.json',
  })

  for (let round = 1; round <= ROUNDS; round++) {
    messages.push({ role: 'user', content: userTextForRound(round) })

    for (let iter = 1; iter <= ITERATIONS_PER_ROUND; iter++) {
      const base = globalCallIdx
      messages.push(buildAssistantTurn(round, iter, base))
      messages.push(buildToolResultTurn(round, iter, base, truth))
      globalCallIdx += TOOLS_PER_ITERATION

      // post_tool host attachments (production runCollectors push_message).
      if (iter % 3 === 0) {
        messages.push(
          makeSideChannelUserMessage(
            SIDE_CHANNEL_KIND.staleTodoNudge,
            `[Stale todo reminder]\n第 ${round} 轮提醒 #${iter}：保持 todo 列表与幂等改造进度同步。`,
          ),
        )
      }
      if (iter % 5 === 0) {
        messages.push(
          makeSideChannelUserMessage(
            SIDE_CHANNEL_KIND.activeSkillReminder,
            `[Active skill reminder]\n技能 ${SKILL_NAME} 的 <skill-instructions> 工作流仍然生效，逐步执行。`,
          ),
        )
      }

      // Iteration-end state writeback normalize (audit-fixed flags).
      messages = iterationNormalize(messages)

      // Pre-model context management — REAL production tier logic.
      const before = mgr.getState().compactCount
      const evalResult = mgr.evaluate(messages, SYSTEM_PROMPT, TOOL_DEFS_TOKENS, MODEL)
      tierCounts[evalResult.action] = (tierCounts[evalResult.action] ?? 0) + 1
      const handled = await mgr.handleContext(
        messages,
        SYSTEM_PROMPT,
        compactOptions(messages),
        TOOL_DEFS_TOKENS,
      )
      messages = handled.messages

      if (wireAfterFirstAutoCompact === null && mgr.getState().compactCount > before) {
        wireAfterFirstAutoCompact = buildWire(messages)
      }

      // Hard invariant on every iteration: live state never carries a
      // reverse-orphan tool_result (the Anthropic-400 shape).
      scanForOrphans(messages, `post-handleContext action=${evalResult.action} round=${round} iter=${iter}`)
    }

    // Periodic wire sanity checks during the run (every 10 rounds).
    if (round % 10 === 0) {
      assertWireHygiene(buildWire(messages), `round ${round}`)
    }
    roundStats.push({
      round,
      msgCount: messages.length,
      estTokens: estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS,
      compactCount: mgr.getState().compactCount,
      failures: mgr.getState().consecutiveCompactFailures,
    })
  }

  return { messages, truth, mgr, wireAfterFirstAutoCompact, tierCounts, roundStats }
}

// ─── The destructive run ──────────────────────────────────────────────

describe('destructive context injection — 50 rounds × 120 tools', () => {
  beforeEach(() => {
    resetInvokedSkillsRegistryForTests()
    resetPostCompactCleanupDedupeForTests()
  })

  it(
    'survives 6000 tool calls without forgetting user intent, breaking wire invariants, or blowing the token budget',
    { timeout: 120_000 },
    async () => {
      // Shrink the model window so the dynamic threshold ladder fires
      // many times across the run (see runDestructiveSimulation).
      process.env.POLE_CONTEXT_WINDOW_TOKENS = '60000'
      let result: RunResult
      try {
        result = await runDestructiveSimulation()
      } finally {
        delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      }
      const { messages, truth, mgr, wireAfterFirstAutoCompact, tierCounts, roundStats } = result

      // Diagnostics FIRST so a failing assertion still leaves the trace.
      const biggest = [...messages]
        .map((m, i) => ({ i, role: m.role, kind: m._sideChannelKind ?? m._type ?? null, len: JSON.stringify(m).length }))
        .sort((a, b) => b.len - a.len)
        .slice(0, 5)
      // eslint-disable-next-line no-console
      console.log('[destructive-50x120]', JSON.stringify({
        totalCalls: truth.calls,
        errors: truth.error,
        compactCount: mgr.getState().compactCount,
        failures: mgr.getState().consecutiveCompactFailures,
        finalMessages: messages.length,
        tierCounts,
        thresholds: mgr.getThresholds(),
        roundStats: roundStats.filter((s) => s.round % 5 === 0 || s.round === 1),
        biggest,
      }))

      // ── Sanity: the stress profile actually ran at full scale ──
      expect(truth.calls).toBe(TOTAL_EXPECTED_CALLS)
      expect(truth.error).toBeGreaterThan(500) // ≈ 6000/9
      expect(truth.success + truth.error).toBe(TOTAL_EXPECTED_CALLS)

      const state = mgr.getState()
      // Pressure must have forced compaction repeatedly — otherwise the
      // test isn't destructive at all.
      expect(state.compactCount, 'auto-compact never fired').toBeGreaterThan(3)
      expect(hasCompactBoundary(messages)).toBe(true)
      expect(findLastCompactBoundaryIndex(messages)).toBeGreaterThanOrEqual(0)

      // ── Context stays bounded: the manager held the line ──
      const finalTokens =
        estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS
      expect(
        finalTokens,
        `final context ${finalTokens} tokens exceeds blocking threshold`,
      ).toBeLessThan(mgr.getThresholds().blockingTokens)
      expect(messages.length, 'live transcript grew without bound').toBeLessThan(600)

      // ── Wire hygiene at the very end of the run ──
      const wire = buildWire(messages)
      assertWireHygiene(wire, 'final')

      // ── Attention anchor: never more than ONE <user-query> wrap, and it
      //    must never drift onto host scaffolding. Zero anchors is the
      //    correct mid-loop outcome when the current turn's user text was
      //    folded into the compact summary (host contract: "no tag → fall
      //    back to the last ordinary user message"). ──
      const wireText = collectAllText(wire)
      const openCount = wireText.split(USER_QUERY_OPEN_TAG).length - 1
      const closeCount = wireText.split(USER_QUERY_CLOSE_TAG).length - 1
      expect(openCount, 'anchor open tag count').toBeLessThanOrEqual(1)
      expect(closeCount, 'anchor close tag count').toBe(openCount)
      if (openCount === 1) {
        const anchored = wireText.slice(
          wireText.indexOf(USER_QUERY_OPEN_TAG) + USER_QUERY_OPEN_TAG.length,
          wireText.indexOf(USER_QUERY_CLOSE_TAG),
        )
        expect(anchored, 'anchor must wrap the round-50 user query').toContain(FINAL_QUERY)
        expect(anchored, 'anchor drifted onto a system reminder').not.toContain('<system-reminder')
        expect(anchored, 'anchor drifted onto a post-compact attachment').not.toContain('[Post-compact')
      }

      // ── Memory: what the user asked must still be visible on the wire ──
      // Round-50 query is live; round-1 core requirement and the round-25
      // correction must be recoverable from the wire payload (live message
      // OR inside a compact-summary verbatim block).
      expect(
        wireText.includes(FINAL_QUERY),
        'FINAL round-50 user query missing from wire',
      ).toBe(true)
      expect(
        wireText.includes(CORE_REQUIREMENT),
        'round-1 CORE REQUIREMENT forgotten — not on the wire in any form',
      ).toBe(true)
      expect(
        wireText.includes(MID_RUN_CORRECTION),
        'round-25 user CORRECTION forgotten — not on the wire in any form',
      ).toBe(true)

      // ── Skill survives the first compaction boundary ──
      expect(wireAfterFirstAutoCompact, 'no post-auto-compact snapshot captured').not.toBeNull()
      const postCompactText = collectAllText(wireAfterFirstAutoCompact!)
      expect(
        postCompactText.includes(SKILL_NAME),
        'invoked skill not re-injected after the first auto-compact',
      ).toBe(true)
      expect(postCompactText).toContain('<invoked-skills>')
      expect(postCompactText).toContain('remain IN FORCE')

      // ── Compact recap framing present (so the model treats history as
      //    a host recap, not user narration) ──
      expect(wireText).toContain('[Previous conversation was compacted')

      // ── Recent evidence intact: the newest read_file result must NOT have
      //    been truncated/cleared (writeIntegrityGuard contract) ──
      let newestReadResult: string | null = null
      outer: for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content as Msg[]) {
          if (b.type === 'tool_use' && b.name === 'read_file') {
            const id = String(b.id)
            const next = messages[i + 1]
            if (next && Array.isArray(next.content)) {
              for (const rb of next.content as Msg[]) {
                if (rb.type === 'tool_result' && rb.tool_use_id === id && typeof rb.content === 'string') {
                  newestReadResult = rb.content
                  break outer
                }
              }
            }
          }
        }
      }
      expect(newestReadResult, 'no read_file result found in final transcript').not.toBeNull()
      expect(newestReadResult!).not.toContain('[Previous tool output truncated')
      expect(newestReadResult!).not.toContain('[Old tool result content cleared]')

    },
  )

  it('fact ledger arithmetic stays exact at 6000-call scale', () => {
    // Pure-arithmetic check, no compaction: tally the FULL raw transcript.
    const truth = newGroundTruth()
    const raw: Msg[] = []
    let g = 1
    for (let round = 1; round <= ROUNDS; round++) {
      raw.push({ role: 'user', content: userTextForRound(round) })
      for (let iter = 1; iter <= ITERATIONS_PER_ROUND; iter++) {
        raw.push(buildAssistantTurn(round, iter, g))
        raw.push(buildToolResultTurn(round, iter, g, truth))
        g += TOOLS_PER_ITERATION
      }
    }

    const tallies = tallyToolExecutions(raw)
    let total = 0
    let success = 0
    let error = 0
    for (const [name, t] of tallies) {
      total += t.success + t.error + t.missing
      success += t.success
      error += t.error
      expect(t.missing, `tool ${name} reported missing results`).toBe(0)
      const expected = truth.perTool.get(name)!
      expect(t.success, `success tally mismatch for ${name}`).toBe(expected.success)
      expect(t.error, `error tally mismatch for ${name}`).toBe(expected.error)
      for (const status of ['success', 'error'] as const) {
        expect(t.targets[status].length).toBeLessThanOrEqual(MAX_TARGETS_PER_STATUS)
      }
    }
    expect(total).toBe(TOTAL_EXPECTED_CALLS)
    expect(success).toBe(truth.success)
    expect(error).toBe(truth.error)

    const ledger = buildCompactToolFactLedger(raw)
    expect(ledger).toContain(`Totals: ${TOTAL_EXPECTED_CALLS} tool call(s)`)
    expect(ledger).toContain(`${truth.success} success`)
    expect(ledger).toContain(`${truth.error} error`)
    // The PTL-retry slicer cuts on this marker — the ledger must never
    // contain it or it would be chopped in half on retry.
    expect(ledger.includes('\n\n---\n')).toBe(false)
  })

  it('verbatim user-turn preservation: short turns are kept in full; long turns degrade to head+tail with an explicit omission marker', () => {
    // Case A — 50 SHORT user turns (the destructive run's profile) fit the
    // MAX_VERBATIM_BLOCK_CHARS budget: nothing may be dropped, the
    // round-25 correction included.
    const truth = newGroundTruth()
    const shortRaw: Msg[] = []
    let g = 1
    for (let round = 1; round <= ROUNDS; round++) {
      shortRaw.push({ role: 'user', content: userTextForRound(round) })
      shortRaw.push(buildAssistantTurn(round, 1, g))
      shortRaw.push(buildToolResultTurn(round, 1, g, truth))
      g += TOOLS_PER_ITERATION
    }
    const shortTurns = extractVerbatimUserMessages(shortRaw)
    expect(shortTurns.length).toBe(ROUNDS) // tool_result carriers correctly skipped
    const shortBlock = formatVerbatimUserTurnsBlock(shortTurns)
    expect(shortBlock).toContain(CORE_REQUIREMENT)
    expect(shortBlock).toContain(MID_RUN_CORRECTION)
    expect(shortBlock).toContain(FINAL_QUERY)
    // 2026-07 loss-manifest fix: the honesty preamble legitimately contains
    // the WORD "omitted"; assert on the actual omission markers instead.
    expect(shortBlock).toContain(`${ROUNDS} re-injected in full (verbatim)`)
    expect(shortBlock).not.toContain('omitted entirely')
    expect(shortBlock).not.toContain('…omitted')

    // Case B — worst case: 50 LONG user turns (~320 chars each) in ONE
    // compact window blow the budget. Loss must be bounded to the middle,
    // with head intent + tail direction preserved and an EXPLICIT
    // omission marker so the model knows there is a hole instead of
    // hallucinating continuity.
    const pad = '，并确保所有相关测试通过、日志补全、回滚预案就绪。'.repeat(10)
    const longTurns = Array.from({ length: ROUNDS }, (_, i) => {
      const round = i + 1
      if (round === 1) return CORE_REQUIREMENT + pad
      if (round === 25) return MID_RUN_CORRECTION + pad
      if (round === ROUNDS) return FINAL_QUERY + pad
      return `第 ${round} 轮：继续处理模块 m${round}${pad}`
    })
    const block = formatVerbatimUserTurnsBlock(longTurns)
    expect(block.length).toBeLessThanOrEqual(MAX_VERBATIM_BLOCK_CHARS + 4_000)
    // Head keeps round 1 (the original intent)…
    expect(block).toContain(CORE_REQUIREMENT)
    // …tail keeps round 50.
    expect(block).toContain(FINAL_QUERY)
    const omitted = ROUNDS - VERBATIM_HEAD_KEEP - VERBATIM_TAIL_KEEP
    expect(block).toContain(`omitted ${omitted} middle user turn`)
    // Known bounded loss (documented): a long mid-run correction at round
    // 25 does NOT survive a single-window worst case — it relies on the
    // multi-compact cadence keeping it inside a later window's tail.
    expect(block.includes(MID_RUN_CORRECTION)).toBe(false)
  })

  it('anchor never lands on a bare-bodied post-compact attachment (regression: <user-query> drift)', () => {
    // Post-compact attachments are deliberately NOT wrapped in
    // <system-reminder> (their <restored-file> bodies must read as
    // authoritative). After a compact folds the user's turn into the
    // summary, such an attachment can be the LAST user message with bare
    // text — the anchor used to wrap it, telling the model the live
    // instruction was host scaffolding.
    const wire: Msg[] = [
      {
        role: 'user',
        content: '<system-reminder>\n[Previous conversation was compacted to save context…]\nSummary…\n</system-reminder>',
      },
      {
        role: 'user',
        content: '[Post-compact context — paths recently seen in tool output]\n- g:/fake/src/a.ts',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
    ]
    const anchored = anchorCurrentUserQuery(wire)
    const text = collectAllText(anchored)
    expect(text.includes(USER_QUERY_OPEN_TAG)).toBe(false)

    // …but a REAL trailing user turn still gets the anchor.
    const wire2 = [...wire, { role: 'user', content: '继续：检查退款重试逻辑' } as Msg]
    const anchored2 = anchorCurrentUserQuery(wire2)
    const text2 = collectAllText(anchored2)
    expect(text2.includes(`${USER_QUERY_OPEN_TAG}\n继续：检查退款重试逻辑\n${USER_QUERY_CLOSE_TAG}`)).toBe(true)
  })

  it('history_snip head repair reaches a fixpoint on adjacent tool batches (regression: reverse-orphan tool_result)', async () => {
    // Regression for the bug this stress test originally exposed: with
    // adjacent tool batches at the snip head (assistant A1 → results A1 →
    // assistant A2 → results A2, no ordinary user turn between), the old
    // three-phase head repair dropped A2 to satisfy "first message must
    // be user" and stopped — leaving `user(results A2)` at the head with
    // orphan tool_result blocks (provider 400). Sweep EVERY possible cut
    // position and assert the head is always clean.
    const { snipOldestMessagesForBudget } = await import('./historySnip')
    const filler = 'z'.repeat(1500)
    const msgs: Msg[] = [{ role: 'user', content: `start ${filler}` }]
    for (let i = 1; i <= 12; i++) {
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: filler },
          { type: 'tool_use', id: `tu_${i}`, name: 'grep', input: { q: i } },
          { type: 'text', text: `batch ${i}` },
        ],
      })
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: filler }],
      })
      // Side-channel reminder only every 3rd batch — leaves stretches of
      // directly adjacent assistant/results pairs (the failure shape).
      if (i % 3 === 0) {
        msgs.push({
          role: 'user',
          content: `<system-reminder>\nnudge ${i}\n</system-reminder>`,
          _convertedFromSystem: true,
        })
      }
    }
    const total = estimateConversationTokens(msgs, '')
    for (let target = total - 200; target > 500; target -= 173) {
      const { messages: out, snippedCount } = snipOldestMessagesForBudget(msgs, {
        systemPrompt: '',
        toolDefsTokens: 0,
        targetTotalTokens: target,
        minMessagesToKeep: 4,
      })
      if (snippedCount === 0) continue
      expect(out[0].role, `target=${target}: head must be user`).toBe('user')
      scanForOrphans(out, `snip sweep target=${target}`)
    }
  })
})
