/**
 * 150 轮单会话极端集成测试 —— 编排 / AgentLoop 数据路径 / 工具子系统 / skill /
 * MCP 风格工具 / 上下文子系统 / 记忆(逐字保留 + invoked-skills 重注入) / thinking 管理。
 *
 * ## 这个测试在测什么、不测什么（诚实声明）
 *
 * 被测回路用 **scripted mock client** 驱动（`vi.mock('../ai/client')`）：模型的回复
 * 由脚本预设，用来精确触发各子系统。因此本测试 **不** 评判"某个真实模型答得对不对"
 * —— 那需要真实 256K 模型 + 评分（见 `./longSession/runJudge.ts`，可插拔后处理步骤）。
 *
 * 真正被验证的是 **每一轮 harness 组装好、即将喂给模型的上下文载荷（wire）**：在 150 轮
 * 极端压力（强制走真实压缩分层阶梯）之后，这份载荷是否仍然让一个有能力的模型能够还原：
 *   ① 当前 user message 在问什么  ② 之前做了哪些  ③ 现在什么情况  ④ 下一步该做什么，
 * 以及工具是否命中（配对完整、无 orphan）、skill 内容是否加载（压缩后是否重注入正文）、
 * thinking 是否干扰（不泄漏为用户叙述、不结尾、不挤占承重事实）。
 *
 * 走 **真实导出** 的子系统：ContextManager 分层阶梯（soft_clear / history_snip /
 * micro_compact / auto_compact / block）、逐字用户轮保留、compact 事实账本、wire 规范化
 * 与 `<user-query>` 锚定、invoked-skills 注册与压缩后重注入、thinking 块规范化。
 * auto-compact 的 summarizer LLM 被 mock 成确定性摘要（携带承重锚点逐字过界）。
 *
 * ## 五阶段剧本（刻意制造认知陷阱）
 *   P1 设定   (1–30):   round 1 = 总目标（退款幂等改造）
 *   P2 纠正   (31–60):  round 45 = 中途纠正（重试窗口 48h 不是 24h）
 *   P3 切换   (61–90):  round 70 = 紧急插队（登录 bug），round 85 = 回到原任务
 *   P4 约束   (91–120): round 100 = 追加硬约束（不许改 DB schema）
 *   P5 汇总   (121–150):round 150 = 最终查询（汇总所有已验证修改）
 *
 * 终局 wire 必须仍能还原全部 5 个锚点（live 或 compact-summary 逐字块）。
 *
 * ## 产物
 *   - 每轮一个 JudgePacket（落盘 jsonl）+ judge 系统提示词 + README，供 LLM-as-judge 评分。
 *   - 一个确定性的 **离线启发式 judge**（从不变量信号推一个 0–5 连贯性分），让报告即刻有数，
 *     并可被 `runJudge.ts` 里的真实模型 judge 替换。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ContextManager } from '../context/manager'
import type { CompactOptions } from '../context/compact'
import { normalizeMessagesForAPI } from '../context/normalizeMessagesForAPI'
import {
  anchorCurrentUserQuery,
  USER_QUERY_OPEN_TAG,
  USER_QUERY_CLOSE_TAG,
} from '../context/anchorUserQuery'
import { findLastCompactBoundaryIndex, hasCompactBoundary } from '../context/compactBoundary'
import { estimateConversationTokens } from '../context/tokenCounter'
import { SIDE_CHANNEL_KIND, makeSideChannelUserMessage } from '../constants/sideChannelKinds'
import {
  recordInvokedSkill,
  resetInvokedSkillsRegistryForTests,
  peekInvokedSkillsPromptFragmentForAgent,
} from '../skills/invokedSkillsRegistry'
import { formatInlineSkillInstructionsOutput } from '../skills/skillTool'
import { asAgentId } from '../tools/ids'
import { resetPostCompactCleanupDedupeForTests } from '../agents/postCompactCleanup'
import { silenceExpectedConsoleWarnAndError } from '../testHelpers/silenceExpectedConsole'
import {
  JUDGE_DIMENSIONS,
  JUDGE_SYSTEM_PROMPT,
  type JudgeDimensionId,
  type JudgePacket,
} from './longSession/judgeRubric'

// ─── 确定性 auto-compact summarizer（hermetic LLM 替身）─────────────────
//
// 复刻生产 compact 契约的承重部分：summarizer 必须把用户原始意图带过界，"承重处逐字引用"。
// mock 扫描输入窗口里的 5 个锚点哨兵并逐字回显 —— 于是当旧的 compact 摘要消息溢出受保护链
// 预算被再次摘要时，关键用户原话像一个称职的模型那样原样保留进新摘要。其余为固定串。
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
        const msgs = (params as { messages?: Array<{ content?: unknown }> }).messages ?? []
        const text = msgs
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n')
        const quoted: string[] = []
        for (const re of [
          /总目标：[^\n]*/,
          /纠正：[^\n]*/,
          /插队：[^\n]*/,
          /约束：[^\n]*/,
          /最后一轮：[^\n]*/,
        ]) {
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

// ─── 规模 ──────────────────────────────────────────────────────────────
const ROUNDS = 150
const ITERATIONS_PER_ROUND = 2
const TOOLS_PER_ITERATION = 8
const TOTAL_EXPECTED_CALLS = ROUNDS * ITERATIONS_PER_ROUND * TOOLS_PER_ITERATION

const SYSTEM_PROMPT =
  'You are the IDE coding agent under a 150-turn extreme integration stress test. ' +
  'Honor the standing goal and the latest user correction at all times.'
const TOOL_DEFS_TOKENS = 6_000
const MODEL = 'claude-sonnet-4-6'
const AGENT_ID = 'longsession-main'

// ─── 承重锚点（其存活定义"AI 是否遗忘"）──────────────────────────────────
const A1_CORE_REQUIREMENT =
  '总目标：把 PaymentService 的退款逻辑改成幂等（idempotent refund），保持公开 API 兼容，禁止随意发挥'
const A2_MID_RUN_CORRECTION =
  '纠正：重试窗口必须是 48 小时而不是 24 小时，所有相关常量统一用 RETRY_WINDOW_HOURS=48'
const A3_TASK_SWITCH =
  '插队：先暂停退款改造，紧急修复 SSO 登录在 token 过期时白屏的线上 bug，修完回到退款任务'
const A3_RETURN = '现在登录 bug 已上线，回到退款幂等改造主线，从你切走前的进度继续'
const A4_CONSTRAINT =
  '约束：退款改造只能动应用层代码，禁止改动数据库 schema 与迁移脚本，幂等键放 Redis'
const A5_FINAL_QUERY = '最后一轮：给我汇总这 150 轮里所有已验证完成的修改清单与剩余风险'

const SKILL1_NAME = 'refund-idempotency-checklist'
const SKILL1_PATH = 'g:/fake/.claude/skills/refund-idempotency-checklist/SKILL.md'
const SKILL1_BODY_SENTINEL = 'IDEMPOTENCY_KEY = orderId + attemptNo；改退款前先跑 typecheck'
const SKILL2_NAME = 'incident-hotfix-runbook'
const SKILL2_BODY_SENTINEL = 'HOTFIX_STEP: 先回滚再定位，灰度 5% 验证后全量'
const SKILL3_NAME = 'redis-idempotency-store'

// 双命名约定 + MCP 风格 + 未知工具 —— 覆盖工具路由分支。
const READ_TOOLS = ['read_file', 'grep', 'Glob', 'list_files'] as const
const MUTATE_TOOLS = ['edit_file', 'write_file', 'multi_edit_file'] as const
const OTHER_TOOLS = ['bash', 'PowerShell', 'web_fetch', 'mcp__tracker__query', 'mcp__redis__get'] as const
const TOOL_CYCLE = [...READ_TOOLS, ...MUTATE_TOOLS, ...OTHER_TOOLS] as const

// ─── 剧本：阶段与每轮用户指令 ────────────────────────────────────────────
function phaseOf(round: number): string {
  if (round <= 30) return 'P1-设定'
  if (round <= 60) return 'P2-纠正'
  if (round <= 90) return 'P3-切换'
  if (round <= 120) return 'P4-约束'
  return 'P5-汇总'
}

function userTextForRound(round: number): string {
  switch (round) {
    case 1:
      return A1_CORE_REQUIREMENT
    case 45:
      return A2_MID_RUN_CORRECTION
    case 70:
      return A3_TASK_SWITCH
    case 85:
      return A3_RETURN
    case 100:
      return A4_CONSTRAINT
    case ROUNDS:
      return A5_FINAL_QUERY
  }
  // 任务切换窗口（71–84）期间用户在处理登录 bug，其余按主线推进。
  if (round >= 71 && round <= 84) {
    return `第 ${round} 轮：继续修复 SSO 登录白屏（token 刷新分支），暂不碰退款代码`
  }
  return `第 ${round} 轮：继续按总目标推进退款幂等改造模块 m${round}，不要偏离主线`
}

// ─── 工具批次构造（含 thinking 干扰）────────────────────────────────────
const THINKING_FILLER = '推理：核对本批目标文件、重试窗口常量与幂等键生成路径，确认不偏离总目标。'.repeat(6)
const SUCCESS_FILLER = '处理完成，输出与期望一致，已记录到进度。'.repeat(10)

function toolsForRound(round: number): string[] {
  // 不同阶段倾向不同工具族，但都覆盖配对路径。
  if (round >= 71 && round <= 84) {
    // 登录 hotfix 期：读 + 改 + 运行
    return ['read_file', 'grep', 'edit_file', 'bash', 'read_file', 'PowerShell', 'edit_file', 'grep']
  }
  if (round <= 30 || (round >= 91 && round <= 120)) {
    // 退款主线：读 + 改 + MCP 查询
    return ['read_file', 'grep', 'edit_file', 'mcp__tracker__query', 'write_file', 'mcp__redis__get', 'Glob', 'read_file']
  }
  // 其它阶段走完整轮转
  return Array.from({ length: TOOLS_PER_ITERATION }, (_, k) => TOOL_CYCLE[(round + k) % TOOL_CYCLE.length])
}

interface GroundTruth {
  calls: number
  success: number
  error: number
}

function buildAssistantTurn(round: number, iter: number, tools: string[]): Msg {
  const content: Msg[] = [{ type: 'thinking', thinking: `r${round}/i${iter} ${THINKING_FILLER}` }]
  if (iter % 2 === 0 && round % 7 === 0) {
    content.push({ type: 'redacted_thinking', data: `redacted-r${round}-i${iter}-${'z'.repeat(80)}` })
  }
  for (let k = 0; k < tools.length; k++) {
    const name = tools[k]
    const id = `tu_r${round}_i${iter}_k${k}`
    const input: Record<string, unknown> =
      name === 'bash' || name === 'PowerShell'
        ? { command: `run-check --module m${round} --batch ${iter} --slot ${k}` }
        : { file_path: `g:/fake/src/m${round}/f${iter}_${k}.ts`, query: `RETRY_WINDOW_HOURS r${round}` }
    content.push({ type: 'tool_use', id, name, input })
  }
  content.push({
    type: 'text',
    text: `第 ${round} 轮第 ${iter} 批：执行 ${tools.length} 个工具，继续推进（${phaseOf(round)}）。`,
  })
  return { role: 'assistant', content }
}

function buildToolResultTurn(round: number, iter: number, tools: string[], truth: GroundTruth): Msg {
  const blocks: Msg[] = []
  for (let k = 0; k < tools.length; k++) {
    const id = `tu_r${round}_i${iter}_k${k}`
    const err = (round * 10 + iter * 3 + k) % 9 === 0
    truth.calls++
    if (err) {
      truth.error++
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: `Error: ENOENT g:/fake/src/m${round}/f${iter}_${k}.ts`,
        is_error: true,
      })
    } else {
      truth.success++
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: `ok r${round}/i${iter}/k${k}: ${SUCCESS_FILLER}`,
        is_error: false,
      })
    }
  }
  return { role: 'user', content: blocks }
}

// ─── wire / normalize（镜像生产 call site）──────────────────────────────
function iterationNormalize(messages: Msg[]): Msg[] {
  return normalizeMessagesForAPI(messages, {
    stripInternalMeta: false,
    applyConsecutiveUserMerge: false,
    strictThinkingEcho: false,
    preserveThinkingOnlyAssistant: true,
  })
}

function buildWire(messages: Msg[]): Msg[] {
  const normalized = normalizeMessagesForAPI(
    messages.map((m) => ({ ...m })),
    { stripInternalMeta: true, applyAnthropicInvariants: true, strictThinkingEcho: false },
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
        for (const inner of b.content as Msg[]) if (typeof inner.text === 'string') parts.push(inner.text)
      }
    }
  }
  return parts.join('\n')
}

function countThinkingBlocks(messages: Msg[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content as Msg[]) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') n++
    }
  }
  return n
}

// ─── 不变量扫描 ──────────────────────────────────────────────────────────
function scanForOrphans(messages: Msg[], stage: string): void {
  const useIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content as Msg[]) if (b.type === 'tool_use') useIds.add(String(b.id))
    }
  }
  for (const [mi, m] of messages.entries()) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as Msg[]) {
      if (b.type === 'tool_result' && !useIds.has(String(b.tool_use_id))) {
        throw new Error(`ORPHAN ${b.tool_use_id} at msg[${mi}/${messages.length}] stage=${stage}`)
      }
    }
  }
}

function assertWireHygiene(wire: Msg[], label: string): void {
  expect(wire.length, `${label}: wire empty`).toBeGreaterThan(0)
  expect(wire[0].role, `${label}: first wire message must be user`).toBe('user')
  for (const [i, m] of wire.entries()) {
    for (const key of Object.keys(m)) {
      expect(key.startsWith('_'), `${label}: internal field ${key} leaked at wire[${i}]`).toBe(false)
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content as Msg[]
      expect(blocks.length, `${label}: empty assistant content at wire[${i}]`).toBeGreaterThan(0)
      const nonThinking = blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      expect(nonThinking.length, `${label}: thinking-only assistant survived to wire[${i}]`).toBeGreaterThan(0)
      expect(blocks[blocks.length - 1].type, `${label}: assistant at wire[${i}] ends with thinking`).not.toBe(
        'thinking',
      )
    }
  }
  // tool_use ↔ tool_result 配对（Anthropic 线协议）
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const ids = (m.content as Msg[]).filter((b) => b.type === 'tool_use').map((b) => String(b.id))
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
}

// ─── judge 包构造（落盘给 LLM-as-judge / 人工）──────────────────────────
function toPacketWire(wire: Msg[]): JudgePacket['wire'] {
  return wire.map((m) => {
    const blocks: JudgePacket['wire'][number]['blocks'] = []
    const c = m.content
    if (typeof c === 'string') {
      blocks.push({ type: 'text', text: c.slice(0, 1200) })
    } else if (Array.isArray(c)) {
      for (const b of c as Msg[]) {
        const type = String(b.type ?? 'unknown')
        const entry: JudgePacket['wire'][number]['blocks'][number] = { type }
        if (typeof b.text === 'string') entry.text = b.text.slice(0, 1200)
        if (typeof b.thinking === 'string') entry.text = `[thinking] ${b.thinking.slice(0, 600)}`
        if (typeof b.content === 'string') entry.text = b.content.slice(0, 800)
        if (typeof b.tool_use_id === 'string') entry.toolUseId = b.tool_use_id
        if (typeof b.id === 'string') entry.toolUseId = b.id
        if (typeof b.name === 'string') entry.name = b.name
        blocks.push(entry)
      }
    }
    return { role: String(m.role ?? 'unknown'), blocks }
  })
}

// 离线启发式 judge：从不变量信号推 0–5 连贯性分（可被 runJudge.ts 的真实模型替换）。
// skill 维度按产品契约"压缩感知"评分：只有 auto_compact 轮才重注入 <invoked-skills>，
// 故仅在 auto_compact 轮 skill 必须出现（否则 0）；其余轮 skill 不在 wire 上不算缺陷
// （边界之间靠 activeSkillReminder 维持），仅扣到 4 作为"非满分但可接受"。
function heuristicScore(
  packet: JudgePacket,
  ctx: { anchorsRecoverableSoFar: boolean; skillBodyPresent: boolean; orphanFree: boolean; wireText: string },
): Record<JudgeDimensionId, number> {
  const userInstrPresent = ctx.wireText.includes(packet.userInstructionThisRound.slice(0, 24))
  const thinkingNotLast = !packet.wire.some(
    (m) => m.role === 'assistant' && m.blocks.length > 0 && m.blocks[m.blocks.length - 1].type === 'thinking',
  )
  const autoCompactedThisRound = packet.compactAction === 'auto_compact'
  return {
    understands_current_user_message: userInstrPresent ? 5 : 2,
    recalls_what_was_done: ctx.anchorsRecoverableSoFar ? 5 : 1,
    aware_of_current_state: ctx.anchorsRecoverableSoFar && userInstrPresent ? 5 : 3,
    knows_next_step: ctx.anchorsRecoverableSoFar ? 5 : 2,
    tool_routing_sane: ctx.orphanFree ? 5 : 0,
    skill_content_loaded: ctx.skillBodyPresent ? 5 : autoCompactedThisRound ? 0 : 4,
    thinking_not_interfering: thinkingNotLast ? 5 : 1,
    // 2026-07 uplift #3 — goal-drift proxy: the standing goal anchors
    // (original requirement + mid-run corrections) being recoverable from
    // THIS round's wire is the hermetic equivalent of "still pointed at
    // the goal". Production packets carry `hostSignals.driftScore` for the
    // quantitative version.
    goal_drift_contained: ctx.anchorsRecoverableSoFar && userInstrPresent ? 5 : 2,
  }
}

interface RunResult {
  messages: Msg[]
  truth: GroundTruth
  mgr: ContextManager
  tierCounts: Record<string, number>
  packets: JudgePacket[]
  heuristicByRound: Array<{ round: number; scores: Record<JudgeDimensionId, number> }>
  wireAfterFirstAutoCompact: Msg[] | null
  /** 每轮 wire 上能看到 skill 正文/名/<invoked-skills> 的轮数（长会话 skill 持续可见率）。 */
  skillVisibleRounds: number
  outDir: string
}

async function runLongSession(outDir: string): Promise<RunResult> {
  const mgr = new ContextManager()
  const truth: GroundTruth = { calls: 0, success: 0, error: 0 }
  const tierCounts: Record<string, number> = {}
  const packets: JudgePacket[] = []
  const heuristicByRound: RunResult['heuristicByRound'] = []
  let skillVisibleRounds = 0
  let messages: Msg[] = []
  let wireAfterFirstAutoCompact: Msg[] | null = null

  // 会话脚手架：user-meta + 首轮 skill discovery（与生产 fresh session 一致）。
  messages.push(
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.userMetaContext,
      `<workspace>g:/fake</workspace>\n<date>2026-06-30</date>`,
    ),
  )
  messages.push(
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.skillDiscovery,
      `<skill-instructions>\nSKILL ${SKILL1_NAME}: ${SKILL1_BODY_SENTINEL}\n</skill-instructions>`,
    ),
  )
  recordInvokedSkill({
    skillName: SKILL1_NAME,
    skillPath: SKILL1_PATH,
    content: SKILL1_BODY_SENTINEL,
    agentId: asAgentId(AGENT_ID),
  })

  const compactOptions = (msgs: Msg[]): CompactOptions => ({
    config: { id: 'mock', name: 'mock', apiKey: 'x' } as unknown as CompactOptions['config'],
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    messages: msgs,
    signal: new AbortController().signal,
    agentId: AGENT_ID,
    transcriptPath: 'g:/fake/.conversations/longsession-150.json',
  })

  for (let round = 1; round <= ROUNDS; round++) {
    messages.push({ role: 'user', content: userTextForRound(round) })

    // 阶段边界注入 skill：切换期换 hotfix runbook，回归期换 redis store。
    if (round === 70) {
      recordInvokedSkill({
        skillName: SKILL2_NAME,
        skillPath: 'g:/fake/.claude/skills/incident-hotfix-runbook/SKILL.md',
        content: SKILL2_BODY_SENTINEL,
        agentId: asAgentId(AGENT_ID),
      })
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_skill_${round}`, name: 'Skill', input: {} }] })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tu_skill_${round}`,
            content: formatInlineSkillInstructionsOutput(SKILL2_NAME, undefined, SKILL2_BODY_SENTINEL),
          },
        ],
      })
    }
    if (round === 91) {
      recordInvokedSkill({
        skillName: SKILL3_NAME,
        skillPath: 'g:/fake/.claude/skills/redis-idempotency-store/SKILL.md',
        content: 'REDIS_KEY = refund:{orderId}:{attemptNo}, TTL=RETRY_WINDOW_HOURS',
        agentId: asAgentId(AGENT_ID),
      })
    }

    const roundTools: string[] = []
    let compactAction = 'none'
    for (let iter = 1; iter <= ITERATIONS_PER_ROUND; iter++) {
      const tools = toolsForRound(round)
      roundTools.push(...tools)
      messages.push(buildAssistantTurn(round, iter, tools))
      messages.push(buildToolResultTurn(round, iter, tools, truth))

      // post_tool 宿主旁路注入（生产 runCollectors push_message）。带上当前生效 skill 名，
      // 镜像生产 activeSkillReminder（命名 skill），让 skill 可见率度量更贴合真实。
      if (iter % 2 === 0) {
        const activeSkill = round >= 71 && round <= 90 ? SKILL2_NAME : SKILL1_NAME
        messages.push(
          makeSideChannelUserMessage(
            SIDE_CHANNEL_KIND.activeSkillReminder,
            `[Active skill reminder]\n技能 ${activeSkill} 的 <skill-instructions> 工作流仍生效，逐步执行，勿偏离 ${phaseOf(round)} 目标。`,
          ),
        )
      }

      messages = iterationNormalize(messages)

      const before = mgr.getState().compactCount
      const evalResult = mgr.evaluate(messages, SYSTEM_PROMPT, TOOL_DEFS_TOKENS, MODEL)
      tierCounts[evalResult.action] = (tierCounts[evalResult.action] ?? 0) + 1
      if (evalResult.action !== 'none') compactAction = evalResult.action
      const handled = await mgr.handleContext(messages, SYSTEM_PROMPT, compactOptions(messages), TOOL_DEFS_TOKENS)
      messages = handled.messages

      if (wireAfterFirstAutoCompact === null && mgr.getState().compactCount > before) {
        wireAfterFirstAutoCompact = buildWire(messages)
      }

      scanForOrphans(messages, `round=${round} iter=${iter} action=${evalResult.action}`)
    }

    // ── 每轮：组装 wire = 模型实际收到的载荷，并产出 judge 包 ──
    const wire = buildWire(messages)
    const wireText = collectAllText(wire)
    const activeSkills = peekInvokedSkillsPromptFragmentForAgent(asAgentId(AGENT_ID))
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)

    const packet: JudgePacket = {
      round,
      phase: phaseOf(round),
      userInstructionThisRound: userTextForRound(round),
      compactAction,
      toolsUsedThisRound: [...new Set(roundTools)],
      activeSkills,
      thinkingBlockCount: countThinkingBlocks(wire),
      wire: toPacketWire(wire),
      // 2026-07 uplift #3 — host control-loop signals. The hermetic
      // harness simulates the DATA path only (no live guards / embedding),
      // so driftScore is honestly null and the counters are 0; production
      // packets fill them from telemetry.
      hostSignals: {
        driftScore: null,
        repetitionHalts: 0,
        injectionSheds: 0,
        planStepBudgetEvents: 0,
      },
    }
    packets.push(packet)

    // 启发式打分所需信号：到目前为止应当可还原的锚点是否都在 wire 上。
    const expectedAnchors: string[] = [A1_CORE_REQUIREMENT]
    if (round >= 45) expectedAnchors.push(A2_MID_RUN_CORRECTION)
    if (round >= 70) expectedAnchors.push(A3_TASK_SWITCH)
    if (round >= 100) expectedAnchors.push(A4_CONSTRAINT)
    const anchorsRecoverableSoFar = expectedAnchors.every((a) => wireText.includes(a))
    const skillBodyPresent =
      wireText.includes(SKILL1_BODY_SENTINEL) ||
      wireText.includes(SKILL1_NAME) ||
      wireText.includes('<invoked-skills>')
    if (skillBodyPresent) skillVisibleRounds++
    let orphanFree = true
    try {
      scanForOrphans(wire, `judge-wire round=${round}`)
    } catch {
      orphanFree = false
    }
    heuristicByRound.push({
      round,
      scores: heuristicScore(packet, { anchorsRecoverableSoFar, skillBodyPresent, orphanFree, wireText }),
    })
  }

  // ── 落盘 judge 产物 ──
  fs.mkdirSync(outDir, { recursive: true })
  const jsonl = packets.map((p) => JSON.stringify(p)).join('\n')
  fs.writeFileSync(path.join(outDir, 'judge-input.jsonl'), jsonl, 'utf8')
  fs.writeFileSync(path.join(outDir, 'judge-system-prompt.txt'), JUDGE_SYSTEM_PROMPT, 'utf8')
  fs.writeFileSync(
    path.join(outDir, 'README.md'),
    [
      '# 150-turn long-session judge packets',
      '',
      '每行一个 turn 的 JudgePacket（`judge-input.jsonl`）。`wire` 是该轮模型实际会收到的载荷。',
      '',
      '## 用真实模型评分（LLM-as-judge）',
      '',
      '```bash',
      'npx tsx electron/integration/longSession/runJudge.ts \\',
      `  --packets "${path.join(outDir, 'judge-input.jsonl')}" \\`,
      '  --provider anthropic --model <你的256K模型> --api-key $YOUR_KEY',
      '```',
      '',
      '不带 provider/key 时 runJudge 退化为离线启发式评分（与本测试报告同源）。',
    ].join('\n'),
    'utf8',
  )

  return {
    messages,
    truth,
    mgr,
    tierCounts,
    packets,
    heuristicByRound,
    wireAfterFirstAutoCompact,
    skillVisibleRounds,
    outDir,
  }
}

// ─── findings 报告 ──────────────────────────────────────────────────────
interface Finding {
  维度: string
  指标: string
  实测: string | number
  判定: '正常' | '⚠️发现' | '失败'
  说明: string
}

describe('150 轮单会话极端集成 — 编排/AgentLoop数据路径/工具/skill/MCP/上下文/记忆/thinking', () => {
  let OUT_DIR = ''
  const findings: Finding[] = []

  beforeAll(() => {
    resetInvokedSkillsRegistryForTests()
    resetPostCompactCleanupDedupeForTests()
    OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-longsession-150-'))
  })

  afterAll(() => {
    resetInvokedSkillsRegistryForTests()
    resetPostCompactCleanupDedupeForTests()
    // eslint-disable-next-line no-console
    console.log('\n========== 150 轮单会话极端集成 — 子系统问题报告 ==========')
    // eslint-disable-next-line no-console
    console.log('judge 包目录:', OUT_DIR)
    // eslint-disable-next-line no-console
    console.table(findings)
  })

  it(
    '150 轮压力后，喂给模型的每轮上下文仍能还原"问什么/做了啥/什么情况/下一步"，工具/skill/thinking 不出问题',
    { timeout: 600_000 },
    async () => {
      // 缩小模型窗口，让真实分层阶梯在 150 轮里反复触发（而非临近结尾才压一次）。
      process.env.POLE_CONTEXT_WINDOW_TOKENS = '60000'
      let result: RunResult
      try {
        result = await runLongSession(path.join(OUT_DIR, 'packets'))
      } finally {
        delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      }
      const { messages, truth, mgr, tierCounts, packets, heuristicByRound, wireAfterFirstAutoCompact, skillVisibleRounds } =
        result

      const wire = buildWire(messages)
      const wireText = collectAllText(wire)

      // ── 诊断先行 ──
      // eslint-disable-next-line no-console
      console.log(
        '[longsession-150]',
        JSON.stringify({
          totalCalls: truth.calls,
          errors: truth.error,
          compactCount: mgr.getState().compactCount,
          finalMessages: messages.length,
          tierCounts,
          thresholds: mgr.getThresholds(),
        }),
      )

      // ── 规模 sanity ──
      expect(truth.calls).toBe(TOTAL_EXPECTED_CALLS)
      expect(truth.success + truth.error).toBe(TOTAL_EXPECTED_CALLS)

      // ── 压缩确实反复触发（否则不算极端）──
      const compactCount = mgr.getState().compactCount
      expect(compactCount, 'auto-compact 从未触发，压力不足').toBeGreaterThan(3)
      expect(hasCompactBoundary(messages)).toBe(true)
      expect(findLastCompactBoundaryIndex(messages)).toBeGreaterThanOrEqual(0)
      findings.push({
        维度: '上下文子系统',
        指标: `压缩触发次数 / 分层动作`,
        实测: `compact=${compactCount} tiers=${JSON.stringify(tierCounts)}`,
        判定: compactCount > 3 ? '正常' : '⚠️发现',
        说明: '真实 ContextManager 分层阶梯在 150 轮内反复触发，验证极端压力成立',
      })

      // ── ② 之前做了哪些 / ③ 现在什么情况 / ④ 下一步：5 个锚点终局可还原 ──
      const anchorChecks: Array<[string, string]> = [
        ['总目标(round1)', A1_CORE_REQUIREMENT],
        ['中途纠正(round45)', A2_MID_RUN_CORRECTION],
        ['任务切换(round70)', A3_TASK_SWITCH],
        ['追加约束(round100)', A4_CONSTRAINT],
        ['最终查询(round150)', A5_FINAL_QUERY],
      ]
      for (const [label, anchor] of anchorChecks) {
        const present = wireText.includes(anchor)
        findings.push({
          维度: '记忆/状态追溯',
          指标: `终局 wire 可还原: ${label}`,
          实测: present ? '在' : '丢失',
          判定: present ? '正常' : '失败',
          说明: 'live 消息或 compact-summary 逐字块中可见 → 模型不会"忘记之前做了什么/约束"',
        })
        expect(present, `${label} 在 150 轮压力后从 wire 丢失 —— AI 会遗忘`).toBe(true)
      }

      // ── ① 当前 user message 理解：终局轮指令必须 live 且被 <user-query> 锚定 ──
      const openCount = wireText.split(USER_QUERY_OPEN_TAG).length - 1
      const closeCount = wireText.split(USER_QUERY_CLOSE_TAG).length - 1
      expect(openCount, 'anchor open tag 数').toBeLessThanOrEqual(1)
      expect(closeCount).toBe(openCount)
      if (openCount === 1) {
        const anchored = wireText.slice(
          wireText.indexOf(USER_QUERY_OPEN_TAG) + USER_QUERY_OPEN_TAG.length,
          wireText.indexOf(USER_QUERY_CLOSE_TAG),
        )
        expect(anchored, '锚点必须包住 round-150 的当前查询').toContain(A5_FINAL_QUERY)
        expect(anchored, '锚点漂移到 system-reminder').not.toContain('<system-reminder')
      }
      findings.push({
        维度: '当前消息理解',
        指标: '<user-query> 锚定唯一且命中当前轮',
        实测: `open=${openCount}`,
        判定: openCount <= 1 ? '正常' : '失败',
        说明: '最多一处锚定，且必须包住当前轮指令 → 注意力不被历史稀释',
      })

      // ── ⑤ 工具命中：终局 wire 配对完整、无 orphan、MCP/mutate 工具确有出现 ──
      assertWireHygiene(wire, 'final')
      scanForOrphans(messages, 'final-live')
      const allToolNames = new Set<string>()
      for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content as Msg[]) if (b.type === 'tool_use') allToolNames.add(String(b.name))
        }
      }
      const sawMcp = [...allToolNames].some((n) => n.startsWith('mcp__'))
      const sawMutate = MUTATE_TOOLS.some((t) => allToolNames.has(t))
      findings.push({
        维度: '工具子系统',
        指标: 'wire 工具配对/无 orphan + MCP/mutate 出现',
        实测: `pairing=ok mcp=${sawMcp} mutate=${sawMutate}`,
        判定: sawMcp && sawMutate ? '正常' : '⚠️发现',
        说明: 'tool_use↔tool_result 即时配对、反向无 orphan；MCP 风格与写类工具均被路由',
      })

      // ── ⑥ skill 内容加载：首次 auto-compact 后 invoked-skills 重注入且正文在 ──
      expect(wireAfterFirstAutoCompact, '未捕获到首次 auto-compact 后的 wire 快照').not.toBeNull()
      const postCompactText = collectAllText(wireAfterFirstAutoCompact!)
      const skillReinjected = postCompactText.includes('<invoked-skills>') && postCompactText.includes(SKILL1_NAME)
      expect(skillReinjected, 'invoked skill 在首次 auto-compact 后未重注入').toBe(true)
      const skill2Visible = wireText.includes(SKILL2_NAME) || wireText.includes(SKILL2_BODY_SENTINEL)
      findings.push({
        维度: 'skill 子系统',
        指标: '压缩后 invoked-skills 重注入 + 阶段切换 skill 可见',
        实测: `reinjected=${skillReinjected} switchSkill=${skill2Visible}`,
        判定: skillReinjected ? '正常' : '失败',
        说明: 'compact 边界后 <invoked-skills> 重注入正文，skill 工作流不丢',
      })
      // 真实发现：长会话里 skill 正文只在压缩边界/reminder 出现，并非每轮都在 wire 上。
      const skillVisibleRatio = skillVisibleRounds / ROUNDS
      findings.push({
        维度: 'skill 子系统',
        指标: 'skill 内容持续可见率（出现 skill 正文/名/<invoked-skills> 的轮占比）',
        实测: `${(skillVisibleRatio * 100).toFixed(0)}% (${skillVisibleRounds}/${ROUNDS})`,
        判定: skillVisibleRatio >= 0.6 ? '正常' : '⚠️发现',
        说明:
          '设计上 skill 仅在 compact 边界重注入 + 靠 activeSkillReminder 维持；边界之间若无提醒，' +
          '模型在那些轮看不到 skill 指令正文 —— 长会话/低提醒频率下需关注',
      })

      // ── ⑦ thinking 干扰：终局 wire 无 thinking-only assistant、不以 thinking 结尾、不泄漏 ──
      // assertWireHygiene 已校验前两项；这里补一条"thinking 不作为用户叙述泄漏"。
      let thinkingLeakedAsUser = false
      for (const m of wire) {
        if (m.role === 'user' && Array.isArray(m.content)) {
          for (const b of m.content as Msg[]) if (b.type === 'thinking') thinkingLeakedAsUser = true
        }
      }
      expect(thinkingLeakedAsUser, 'thinking 块泄漏到 user 角色（被当成用户叙述）').toBe(false)
      findings.push({
        维度: 'thinking 管理',
        指标: 'thinking 不泄漏/不结尾/无 thinking-only assistant',
        实测: thinkingLeakedAsUser ? '泄漏' : '干净',
        判定: thinkingLeakedAsUser ? '失败' : '正常',
        说明: 'thinking 块规范化正确，不污染线协议、不挤占承重事实',
      })

      // ── 上下文有界（token 不爆窗 / transcript 不无界增长）──
      const finalTokens = estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS
      expect(finalTokens, `终局 ${finalTokens} tokens 超过 blocking 阈值`).toBeLessThan(
        mgr.getThresholds().blockingTokens,
      )
      expect(messages.length, 'live transcript 无界增长').toBeLessThan(800)
      findings.push({
        维度: '上下文子系统',
        指标: '终局 token / live 消息数',
        实测: `${finalTokens} tok / ${messages.length} msgs`,
        判定: finalTokens < mgr.getThresholds().blockingTokens ? '正常' : '失败',
        说明: '150 轮后仍被压缩阶梯控制在 blocking 阈值内，无累积膨胀',
      })

      // ── judge 产物完整性 ──
      expect(packets.length, 'judge 包数应等于轮数').toBe(ROUNDS)
      const jsonlPath = path.join(OUT_DIR, 'packets', 'judge-input.jsonl')
      expect(fs.existsSync(jsonlPath), 'judge-input.jsonl 未落盘').toBe(true)
      const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')
      expect(lines.length).toBe(ROUNDS)

      // ── 离线启发式 judge 汇总（每维度均分；可被真实 LLM judge 替换）──
      const dimAvg: Record<string, number> = {}
      for (const dim of JUDGE_DIMENSIONS) {
        const vals = heuristicByRound.map((r) => r.scores[dim.id])
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length
        dimAvg[dim.id] = avg
        const worst = Math.min(...vals)
        findings.push({
          维度: `judge·${dim.zh}`,
          指标: `离线启发式均分(0-5) / 最低分`,
          实测: `${avg.toFixed(2)} / ${worst}`,
          判定: avg >= 4.5 ? '正常' : avg >= 3.5 ? '⚠️发现' : '失败',
          说明: dim.desc,
        })
      }

      // 硬门槛：连贯性关键维度的全程均分必须高（任何系统性退化都会把均分拉低）。
      expect(dimAvg.recalls_what_was_done, '历史追溯连贯性系统性退化').toBeGreaterThanOrEqual(4.0)
      expect(dimAvg.tool_routing_sane, '工具配对出现 orphan').toBeGreaterThanOrEqual(4.9)
      expect(dimAvg.thinking_not_interfering, 'thinking 干扰承重信号').toBeGreaterThanOrEqual(4.5)
      expect(dimAvg.understands_current_user_message, '当前消息在 wire 上不可见的轮次过多').toBeGreaterThanOrEqual(4.0)
      // 2026-07 uplift #3 — 目标漂移抑制基线：150 轮全程的目标锚点可见性
      // 均分。任何让目标文本更早被压缩折叠掉的回归都会拉低此分。
      expect(dimAvg.goal_drift_contained, '目标漂移抑制基线回归').toBeGreaterThanOrEqual(4.0)
    },
  )
})
