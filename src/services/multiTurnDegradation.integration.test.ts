/**
 * 18 轮多轮对话退化 — 根因回归测试。
 *
 * 背景：多轮对话（约 13~18 轮后）曾出现三类问题：
 *   P1 — 思考完成后先输出"结果"，然后才调用工具执行任务；
 *   P2 — 明明声明了要做什么，结果直接停了（end_turn，无工具调用）；
 *   P3 — 没有执行任务，却声称任务已完成。
 *
 * 根因与修复（2026-06 multi-turn degradation fix）：
 *   1. 渲染层跨回合重建把多迭代回合坍缩成"1 assistant + 1 user(results)"，
 *      且让回合内已剥离的 pre-tool 文本回流
 *      → `chatMessageToAgentApiRows` 按迭代分段重建 + 跨回合同步剥离。
 *   2. soft_clear/micro-compact 清证据时完成宣告原样保留（声明/证据不对称）
 *      → `clearedEvidenceAnnotation.ts` 对应轮次叙述追加 host note 降级。
 *   3. 模型"声明要做却不调工具"时宿主直接判 completed
 *      → declared-intent 守卫（决策表 row 12b，一次性 nudge）。
 *   4. R1 思考链距离截断破坏性写回 state.apiMessages
 *      → 改为请求时 ephemeral（stream.ts），持久化记录保持完整；后缀缩短。
 *   5. Grep 证据被清成空占位符
 *      → 清理时保留一行检索摘要。
 *
 * 本文件用 18 轮全管线模拟（渲染层重建 → 12-pass 归一化 → thinking 清洗 →
 * soft_clear）断言修复后的健康形态。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  chatMessageToAgentApiRows,
  buildMessagesWithContext,
} from './contextBuilder'
import type { ChatMessage } from '../types'
import type { ContentBlock } from '../types/tool'
import { buildToolUseAssistantContent } from '../../electron/ai/agenticLoopBuilders'
import { normalizeMessagesForAPI } from '../../electron/context/normalizeMessagesForAPI'
import {
  applyAnthropicThinkingTranscriptCore,
  applyEphemeralDistanceThinkingTruncation,
} from '../../electron/context/anthropicThinkingTranscript'
import { clearCompletedToolResultsExceptRecent } from '../../electron/context/idleToolResultClear'
import { CLEARED_EVIDENCE_NOTE_SENTINEL } from '../../electron/context/clearedEvidenceAnnotation'
import { decideIterationOutcome } from '../../electron/ai/agenticLoop/iterationDecision'
import {
  detectDeclaredIntentTail,
  buildDeclaredIntentDirective,
  DECLARED_INTENT_MARKER,
} from '../../electron/ai/agenticLoop/declaredIntentGuard'
import { createRepetitionGuard } from '../../electron/orchestration/repetitionGuard'
import { formatDeterministicToolLedgerForInjection } from '../../electron/ai/toolUseSummary'

declare const process: { env: Record<string, string | undefined> }

type Msg = Record<string, unknown>
type Blocks = Array<Record<string, unknown>>

const ROUNDS = 18
const PLACEHOLDER = '[Old tool result content cleared]'

/** 填充思考文本到指定长度（模拟真实的长思考链）。 */
function thinkingText(round: number, iter: number, len = 1200): string {
  const base =
    `第${round}轮第${iter}次思考：我需要先读取 file${round}.ts，再修改其中的 bug，` +
    `然后运行 typecheck 验证。修改完成后任务${round}即告完成。`
  return base.padEnd(len, '步骤推演…')
}

/**
 * 渲染层在第 round 轮结束后实际持有的 assistant ChatMessage —
 * mainStreamRouter 的真实积累形态：一个 assistant 消息容纳整个 agentic
 * 回合（3 次迭代）的所有 blocks，按流式顺序排列。
 */
function buildAssistantChatMessage(round: number): ChatMessage {
  const blocks: ContentBlock[] = [
    { type: 'thinking', text: thinkingText(round, 1), signature: `sig-r${round}-1` },
    { type: 'text', text: `我先读取 file${round}.ts，然后进行修改。` },
    {
      type: 'tool_use',
      id: `tu_r${round}_read`,
      name: 'Grep',
      input: { pattern: `bug${round}`, path: `file${round}.ts` },
      status: 'completed',
      result: `file${round}.ts:42: const bug${round} = …（共 ${round * 3} 处匹配）`.padEnd(600, '上下文行…'),
    },
    { type: 'thinking', text: thinkingText(round, 2), signature: `sig-r${round}-2` },
    {
      type: 'tool_use',
      id: `tu_r${round}_edit`,
      name: 'edit_file',
      input: { path: `file${round}.ts`, old: `bug${round}`, new: `fix${round}` },
      status: 'completed',
      result: `OK: file${round}.ts 已修改`,
    },
    {
      type: 'tool_use',
      id: `tu_r${round}_check`,
      name: 'Bash',
      input: { command: 'npm run typecheck' },
      status: 'completed',
      result: 'typecheck passed (0 errors)',
    },
    { type: 'text', text: `✅ 任务${round}已完成：file${round}.ts 已修改并通过 typecheck。` },
  ]
  return {
    id: `a${round}`,
    role: 'assistant',
    content: '',
    timestamp: round * 1000 + 1,
    blocks,
  }
}

function buildUserChatMessage(round: number): ChatMessage {
  return {
    id: `u${round}`,
    role: 'user',
    content: `请完成任务${round}：修复 file${round}.ts 中的 bug${round}`,
    timestamp: round * 1000,
  }
}

function build18RoundChatHistory(): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let r = 1; r <= ROUNDS; r++) {
    messages.push(buildUserChatMessage(r))
    messages.push(buildAssistantChatMessage(r))
  }
  messages.push({
    id: 'u19',
    role: 'user',
    content: '请继续完成任务19：修复 file19.ts 中的 bug19',
    timestamp: 99999,
  })
  return messages
}

/**
 * "发送前"管线（与生产路径一致）：
 *   渲染层重建 → 12-pass 归一化 → iteration 级 thinking 清洗
 *   （applyDistanceTruncation: false — 持久化路径，对应 iteration.ts:660）。
 * 返回 PERSISTED 形态；wire 形态由调用方再叠加 ephemeral R1。
 */
function runPersistedPipeline(chatMessages: ChatMessage[]): Msg[] {
  const rebuilt = buildMessagesWithContext(chatMessages, {})
  const normalized = normalizeMessagesForAPI(
    rebuilt.map((m) => ({ ...m })) as Msg[],
    { stripInternalMeta: true, applyAnthropicInvariants: true },
  )
  return applyAnthropicThinkingTranscriptCore(normalized, {
    currentProvider: 'anthropic',
    currentModel: 'claude-sonnet-4',
    previousStreamSnapshot: { provider: 'anthropic', model: 'claude-sonnet-4' },
    thinkingRequestActive: true,
    stripSignaturesOnModelChange: true,
    applyDistanceTruncation: false,
  })
}

function blocksOf(msg: Msg): Blocks {
  return Array.isArray(msg.content) ? (msg.content as Blocks) : []
}

function isAssistant(msg: Msg): boolean {
  return msg.role === 'assistant'
}

describe('18 轮多轮对话退化 — 根因回归测试', () => {
  beforeEach(() => {
    delete process.env.POLE_STRIP_PRE_TOOL_TEXT
    delete process.env.POLE_DISABLE_DISTANCE_THINKING_TRUNCATION
    delete process.env.POLE_DECLARED_INTENT_GUARD
  })

  // ────────────────────────────────────────────────────────────────────
  // 修复 1：跨回合重建按迭代分段 + pre-tool 文本同步剥离
  // ────────────────────────────────────────────────────────────────────

  it('修复1a（基线不变）：回合内 buildToolUseAssistantContent 剥离 pre-tool 文本', () => {
    const content = buildToolUseAssistantContent({
      thinkingBlocks: [{ thinking: '思考…', signature: 's' }],
      accumulatedText: '我先读取文件，然后修改。',
      serverToolUseBlocks: [],
      codeExecutionResultBlocks: [],
      toolUseBlocks: [{ id: 'tu1', name: 'Grep', input: { pattern: 'x' } }],
    })
    expect(content.some((b) => b.type === 'text')).toBe(false)
    expect(content.some((b) => b.type === 'tool_use')).toBe(true)
  })

  it('修复1b：跨回合重建不再让 pre-tool 文本回流（与回合内规则一致）', () => {
    const rows = chatMessageToAgentApiRows(buildAssistantChatMessage(1))
    for (const row of rows) {
      if (row.role !== 'assistant') continue
      const blocks = row.content as Blocks
      if (!blocks.some?.((b) => b.type === 'tool_use')) continue
      // tool_use 段不得携带任何 text 块
      expect(blocks.some((b) => b.type === 'text')).toBe(false)
    }
    // opt-out 兼容：POLE_STRIP_PRE_TOOL_TEXT=0 时保留旧形态
    process.env.POLE_STRIP_PRE_TOOL_TEXT = '0'
    const legacyRows = chatMessageToAgentApiRows(buildAssistantChatMessage(1))
    const legacyToolRow = legacyRows.find(
      (r) => r.role === 'assistant' && (r.content as Blocks).some?.((b) => b.type === 'tool_use'),
    )!
    expect((legacyToolRow.content as Blocks).some((b) => b.type === 'text')).toBe(true)
  })

  it('修复1c：多迭代回合按迭代分段重建，think→act→observe 因果序恢复', () => {
    const rows = chatMessageToAgentApiRows(buildAssistantChatMessage(1))

    // [th1,(tx1),tu_read][r_read] [th2,tu_edit,tu_check][r_edit,r_check] [txF]
    expect(rows.map((r) => r.role)).toEqual([
      'assistant', 'user', 'assistant', 'user', 'assistant',
    ])

    const seg1 = rows[0].content as Blocks
    expect(seg1.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    const res1 = rows[1].content as Blocks
    expect(res1.filter((b) => b.type === 'tool_result')).toHaveLength(1)
    expect(res1[0].tool_use_id).toBe('tu_r1_read')

    const seg2 = rows[2].content as Blocks
    expect(seg2.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_use'])
    const res2 = rows[3].content as Blocks
    expect(res2.filter((b) => b.type === 'tool_result')).toHaveLength(2)

    // 完成声明在全部工具证据【之后】的独立 assistant 行 —— 时序正确
    const finalSeg = rows[4].content as Blocks
    expect(finalSeg).toHaveLength(1)
    expect(String(finalSeg[0].text)).toContain('已完成')
  })

  it('修复1d：分段形态通过 12-pass 归一化后保持有效（pairing / 簇连续）', () => {
    const rows = chatMessageToAgentApiRows(buildAssistantChatMessage(1)) as Msg[]
    const normalized = normalizeMessagesForAPI(
      rows.map((m) => ({ ...m })),
      { stripInternalMeta: true, applyAnthropicInvariants: true },
    )
    // 每个 assistant tool_use 行后必须紧跟包含其全部 tool_result 的 user 行
    for (let i = 0; i < normalized.length; i++) {
      const msg = normalized[i]
      if (!isAssistant(msg)) continue
      const ids = blocksOf(msg)
        .filter((b) => b.type === 'tool_use')
        .map((b) => String(b.id))
      if (ids.length === 0) continue
      const next = normalized[i + 1]
      expect(next?.role).toBe('user')
      const resultIds = new Set(
        blocksOf(next).filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)),
      )
      for (const id of ids) expect(resultIds.has(id)).toBe(true)
    }
  })

  // ────────────────────────────────────────────────────────────────────
  // 修复 2 + 5：soft_clear 对称降级 + Grep 摘要保留
  // ────────────────────────────────────────────────────────────────────

  it('修复2：证据被清空的轮次，其完成宣告被追加 host note 降级', () => {
    const persisted = runPersistedPipeline(build18RoundChatHistory())
    const cleared = clearCompletedToolResultsExceptRecent(persisted, 8)

    let annotatedClaims = 0
    let pristineClaims = 0
    let placeholderResults = 0
    for (const msg of cleared) {
      for (const b of blocksOf(msg)) {
        if (isAssistant(msg) && b.type === 'text' && String(b.text).includes('已完成')) {
          if (String(b.text).includes(CLEARED_EVIDENCE_NOTE_SENTINEL)) annotatedClaims++
          else pristineClaims++
        }
        if (msg.role === 'user' && b.type === 'tool_result' && String(b.content).startsWith(PLACEHOLDER)) {
          placeholderResults++
        }
      }
    }

    // 新分段形态下每轮 2 个 result 组 → 36 组，保留最近 8 组（第 15~18 轮），
    // 第 1~14 轮共 28 组 / 42 个 tool_result 被清空。
    expect(placeholderResults).toBe(42)
    // 对称性恢复：被清证据的 14 轮，其完成宣告全部带上 host note；
    // 证据完好的 4 轮宣告保持原样。
    expect(annotatedClaims).toBe(14)
    expect(pristineClaims).toBe(ROUNDS - 14)

    // 幂等：重复清理不产生第二条 note
    const twice = clearCompletedToolResultsExceptRecent(cleared, 8)
    const noteCount = JSON.stringify(twice).match(
      new RegExp(CLEARED_EVIDENCE_NOTE_SENTINEL.replace(/\s/g, '\\s'), 'g'),
    )?.length
    expect(noteCount).toBe(14)
  })

  it('修复5：Grep 证据清理后保留一行检索摘要而非空占位符', () => {
    const persisted = runPersistedPipeline(build18RoundChatHistory())
    const cleared = clearCompletedToolResultsExceptRecent(persisted, 8)

    const grepResults: string[] = []
    for (const msg of cleared) {
      if (msg.role !== 'user') continue
      for (const b of blocksOf(msg)) {
        if (b.type !== 'tool_result') continue
        const id = String(b.tool_use_id)
        if (!id.endsWith('_read')) continue
        if (String(b.content).startsWith(PLACEHOLDER)) grepResults.push(String(b.content))
      }
    }
    expect(grepResults.length).toBe(14)
    for (const content of grepResults) {
      expect(content).toContain('search summary:')
      expect(content).toContain('chars total')
    }
  })

  // ────────────────────────────────────────────────────────────────────
  // 修复 4：R1 截断 ephemeral 化 — 持久化记录完整，wire 截断 + 短后缀
  // ────────────────────────────────────────────────────────────────────

  it('修复4：持久化历史保留完整思考链与签名；wire 副本才做距离截断', () => {
    const persisted = runPersistedPipeline(build18RoundChatHistory())

    // 持久化形态：所有 thinking 块完整且签名在位
    let persistedIntact = 0
    for (const msg of persisted.filter(isAssistant)) {
      for (const b of blocksOf(msg)) {
        if (b.type !== 'thinking') continue
        expect(String(b.thinking)).not.toContain('reasoning elided')
        expect(typeof b.signature).toBe('string')
        persistedIntact++
      }
    }
    expect(persistedIntact).toBe(ROUNDS * 2)

    // wire 形态（stream.ts 路径）：距离截断生效
    const wire = applyEphemeralDistanceThinkingTruncation(persisted)
    let wireTruncated = 0
    let wireIntact = 0
    for (const msg of wire.filter(isAssistant)) {
      for (const b of blocksOf(msg)) {
        if (b.type !== 'thinking') continue
        if (String(b.thinking).includes('chars of historical reasoning elided')) {
          // 截断块：签名已删 + 新版短后缀（不再携带 200 字符长解释）
          expect('signature' in b).toBe(false)
          expect(String(b.thinking)).toContain('re-verify from current evidence')
          expect(String(b.thinking)).not.toContain('do not assume the elided content was correct')
          wireTruncated++
        } else {
          wireIntact++
        }
      }
    }
    // 分段后每轮 3 条 assistant 行（th1 段 / th2 段 / 完成文本段），距离按
    // assistant 消息倒数：距离 0(txF,无 thinking)、1(th2 完整)、2(th1 截 800)、
    // ≥3 全部截 200 → 完整 1 块，截断 35 块。
    expect(wireIntact).toBe(1)
    expect(wireTruncated).toBe(ROUNDS * 2 - 1)

    // 输入未被修改（ephemeral 不可变）
    expect(
      persisted
        .filter(isAssistant)
        .every((m) => blocksOf(m).every((b) => b.type !== 'thinking' || 'signature' in b)),
    ).toBe(true)
  })

  it('修复4b（行为保持）：thinking 关闭时历史思考链仍被整体删除（§10.2）', () => {
    const rows = chatMessageToAgentApiRows(buildAssistantChatMessage(1)) as Msg[]
    const out = applyAnthropicThinkingTranscriptCore(rows, {
      currentProvider: 'anthropic',
      currentModel: 'claude-sonnet-4',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: true,
    })
    for (const msg of out.filter(isAssistant)) {
      expect(blocksOf(msg).some((b) => b.type === 'thinking')).toBe(false)
    }
  })

  // ────────────────────────────────────────────────────────────────────
  // 修复 3：declared-intent 守卫（row 12b）
  // ────────────────────────────────────────────────────────────────────

  it('修复3a：意图尾部检测 — 中英文声明命中，疑问/完成句豁免', () => {
    // 命中：声明将要执行
    expect(detectDeclaredIntentTail('分析完毕。我现在开始修改 file19.ts。')).toBe(true)
    expect(detectDeclaredIntentTail('好的。接下来我将运行测试验证。')).toBe(true)
    expect(detectDeclaredIntentTail("The plan is clear. Let me now run the tests.")).toBe(true)
    expect(detectDeclaredIntentTail("I'll start by editing the config file")).toBe(true)
    // 豁免：向用户提问 / 请求确认
    expect(detectDeclaredIntentTail('我可以开始修改 file19.ts，是否继续？')).toBe(false)
    expect(detectDeclaredIntentTail('需要我先运行测试吗?')).toBe(false)
    // 豁免：完成陈述
    expect(detectDeclaredIntentTail('我将修改的文件已全部完成。')).toBe(false)
    // 空文本
    expect(detectDeclaredIntentTail('')).toBe(false)
  })

  it('修复3b：决策表 row 12b — 声明意图未行动 → continue 注入指令而非 completed', () => {
    const directive = buildDeclaredIntentDirective()
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: { kind: 'neutral' },
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        declaredIntentGuard: { directiveBody: directive },
      },
    })
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toContain(DECLARED_INTENT_MARKER)
      expect(outcome.injectSideChannelKind).toBeTruthy()
    }
  })

  it('修复3c：守卫信号缺席（一次性预算耗尽/未检出意图）时仍正常 completed', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: { kind: 'neutral' },
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
      },
    })
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') expect(outcome.reason).toBe('completed')
  })

  it('修复3d：优先级 — 安全网（stall/电路熔断）仍压过 declared-intent 守卫', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: { kind: 'neutral' },
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        stallTripped: { message: 'stalled', consecutiveCount: 3 },
        declaredIntentGuard: { directiveBody: buildDeclaredIntentDirective() },
      },
    })
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') expect(outcome.reason).toBe('iteration_stalled')
  })

  // ────────────────────────────────────────────────────────────────────
  // 工具 / skill 系统侧（行为留档）
  // ────────────────────────────────────────────────────────────────────

  it('留档：repetitionGuard 第 5 次相同调用硬拦截（证据保留摘要后重查动机下降）', () => {
    const guard = createRepetitionGuard()
    const input = { command: 'npm run typecheck' }
    for (let i = 0; i < 4; i++) guard.record('Bash', input)
    const advice = guard.check('Bash', input)
    expect(advice.level).toBe('halt')
  })

  it('留档：回合内 ledger 注入是 side-channel，渲染层重建不携带（按设计）', () => {
    const ledger = formatDeterministicToolLedgerForInjection({
      toolUseBlocks: [{ id: 'tu_1', name: 'edit_file', input: { path: 'a.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'OK' }],
    })
    expect(ledger).toContain('-> success')
    const rows = chatMessageToAgentApiRows(buildAssistantChatMessage(1))
    const allText = JSON.stringify(rows)
    expect(allText.includes('tool batch ledger')).toBe(false)
  })

  // ────────────────────────────────────────────────────────────────────
  // 综合回归：18 轮 + soft_clear 后的最终 wire 形态健康
  // ────────────────────────────────────────────────────────────────────

  it('综合：18 轮全管线后 P1/P2/P3 的诱因形态全部消除', () => {
    const persisted = clearCompletedToolResultsExceptRecent(
      runPersistedPipeline(build18RoundChatHistory()),
      8,
    )
    const wire = applyEphemeralDistanceThinkingTruncation(persisted)

    let textBeforeToolUse = 0
    let unannotatedClaimsWithClearedEvidence = 0
    let buriedInstructions = 0

    const annotatedRounds = new Set<string>()
    for (const msg of wire) {
      const blocks = blocksOf(msg)
      if (isAssistant(msg)) {
        const ti = blocks.findIndex((b) => b.type === 'text')
        const tui = blocks.findIndex((b) => b.type === 'tool_use')
        if (ti >= 0 && tui > ti) textBeforeToolUse++
        for (const b of blocks) {
          if (b.type === 'text' && String(b.text).includes(CLEARED_EVIDENCE_NOTE_SENTINEL)) {
            const m = String(b.text).match(/任务(\d+)已完成/)
            if (m) annotatedRounds.add(m[1])
          }
        }
      } else {
        // 用户指令不再埋在 tool_result 占位符之后（分段后指令独立成行/在行首）
        const firstToolResult = blocks.findIndex((b) => b.type === 'tool_result')
        const instruction = blocks.findIndex(
          (b) => b.type === 'text' && String(b.text).includes('请完成任务'),
        )
        if (firstToolResult === 0 && instruction > firstToolResult) buriedInstructions++
      }
    }

    // 被清证据的轮次（1~14）完成宣告全部已降级
    for (let r = 1; r <= 14; r++) {
      if (!annotatedRounds.has(String(r))) unannotatedClaimsWithClearedEvidence++
    }

    expect(textBeforeToolUse).toBe(0)                       // P1 诱因消除
    expect(unannotatedClaimsWithClearedEvidence).toBe(0)    // P3 诱因消除
    expect(buriedInstructions).toBe(0)                      // 注意力稀释消除
  })
})
