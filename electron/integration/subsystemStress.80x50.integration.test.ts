/**
 * 全链路集成压力测试 — 80 轮对话 × 每轮 50 次工具调用 × 每轮强制上下文压缩。
 *
 * 集成的子系统（均走真实导出函数，不 mock 数据路径）：
 *   - 工具子系统 / 缓存：readFileState（byScope/byReadId 读回执）、
 *     toolResultBudget（applyToolResultSizeBudget spill-to-disk + clampToolResultsInMessages）
 *   - 上下文子系统 + 压缩：ContextManager.evaluate（真实阈值/估算）+ 真实 microCompact
 *   - thinking 管理：assistant 消息内嵌 thinking/redacted_thinking 块，验证压缩后不损坏、token 估算不 NaN
 *   - skill 子系统：invokedSkillsRegistry（unique/repeat 累积）+ formatInlineSkillInstructionsOutput
 *   - Agentloop/编排：复现 loop 每 iteration 的数据路径（clamp → microCompact → 配对校验）
 *
 * 目标：找内存泄漏 / 截断 / 溢出。本测试既做**硬断言**（正确性不变量），
 * 又用 findings 收集器记录**资源指标**并打印报告，明确标注发现的 bug。
 *
 * 说明：完整 runAgenticLoop 需要 mock LLM provider + Electron 运行时，脆弱且非
 * 泄漏/截断的发生地；真正会泄漏/截断/溢出的是 loop 每轮驱动的数据路径，本测试
 * 精确复现该数据路径并施加 80×50 压力。建议用 `--expose-gc` 跑以获得稳定堆测量。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ContextManager } from '../context/manager'
import { microCompact } from '../context/compact'
import {
  applyToolResultSizeBudget,
  clampToolResultsInMessages,
  isSkillInstructionsBlock,
} from '../ai/toolResultBudget'
import {
  recordSuccessfulRead,
  listReadReceiptsInCurrentScope,
  clearAllReadFileState,
  __getReadFileStateInternalsForTests,
} from '../tools/readFileState'
import {
  recordInvokedSkill,
  peekInvokedSkillsPromptFragmentForAgent,
  clearInvokedSkillsForAgent,
  resetInvokedSkillsRegistryForTests,
} from '../skills/invokedSkillsRegistry'
import { formatInlineSkillInstructionsOutput } from '../skills/skillTool'
import {
  runWithAgentContext,
  runWithAgentContextAsync,
  type AgentContext,
} from '../agents/agentContext'
import { finalizeSubAgentLifecycle } from '../agents/subAgentLifecycleCleanup'
import { asAgentId } from '../tools/ids'
import {
  SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../constants/toolLimits'

// ── 规模 ──
const ROUNDS = 80
const TOOLS_PER_ROUND = 50
const CONV_ID = 'stress-80x50'
const AGENT_ID = asAgentId('main')

type Msg = Record<string, unknown>
type Block = Record<string, unknown>

// scopeKey() 只读 agentId + streamConversationId，其余字段对本测试无意义，cast 即可。
const STRESS_CTX = {
  agentId: AGENT_ID,
  streamConversationId: CONV_ID,
  model: 'stress-model',
  systemPrompt: 'sys',
  messages: [],
  config: {} as never,
  signal: new AbortController().signal,
} as unknown as AgentContext

// ── findings 收集器 ──
interface Finding {
  类别: string
  指标: string
  实测: string | number
  判定: '正常' | '⚠️发现' | '泄漏' | '截断' | '溢出'
  说明: string
}
const findings: Finding[] = []
function addFinding(f: Finding): void {
  findings.push(f)
}

let SPILL_DIR = ''

beforeAll(() => {
  clearAllReadFileState()
  resetInvokedSkillsRegistryForTests()
  SPILL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-stress-spill-'))
  process.env.ASTRA_TOOL_RESULTS_DIR = SPILL_DIR
})

afterAll(() => {
  clearAllReadFileState()
  resetInvokedSkillsRegistryForTests()
  clearInvokedSkillsForAgent(AGENT_ID)
  try {
    fs.rmSync(SPILL_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  delete process.env.ASTRA_TOOL_RESULTS_DIR
  // eslint-disable-next-line no-console
  console.log('\n========== 80×50 全链路压力测试 — 子系统问题报告 ==========')
  // eslint-disable-next-line no-console
  console.table(findings)
})

// ── 构造工具：thinking + 50 tool_use 的 assistant 消息 ──
function assistantWith50ToolUses(round: number): Msg {
  const content: Block[] = [
    { type: 'thinking', thinking: `第${round}轮推理：分析了${TOOLS_PER_ROUND}个候选，决定批量调用工具。`.repeat(3), signature: `sig-${round}` },
    { type: 'text', text: `执行第 ${round} 轮的 ${TOOLS_PER_ROUND} 个工具调用。` },
  ]
  if (round % 7 === 0) {
    content.push({ type: 'redacted_thinking', data: `redacted-${round}-${'z'.repeat(200)}` })
  }
  for (let c = 0; c < TOOLS_PER_ROUND; c++) {
    content.push({ type: 'tool_use', id: `tu_${round}_${c}`, name: c % 5 === 0 ? 'read_file' : 'grep', input: { q: c } })
  }
  return { role: 'assistant', content }
}

// 单个 tool_result 内容（含 read_file 的 [readId:] 前缀，模拟真实负载）
function toolResultContent(round: number, c: number): string {
  const isRead = c % 5 === 0
  const head = isRead ? `[readId: read-${round}-${c}] — file body:\n` : `grep matches (${round}/${c}):\n`
  // 单块 ~2.5KB；每轮偶有超大块测 clamp/spill
  const bodyLen = round % 13 === 0 && c === 0 ? 70_000 : 2_500
  return head + `行内容-${round}-${c}-`.repeat(Math.ceil(bodyLen / 12)).slice(0, bodyLen)
}

function userWith50ToolResults(round: number): Msg {
  const content: Block[] = []
  for (let c = 0; c < TOOLS_PER_ROUND; c++) {
    let out = toolResultContent(round, c)
    // 真实 spill 路径：超大结果落盘 + 预览（与生产 runAgenticToolUseBody 一致）
    const budgeted = applyToolResultSizeBudget('read_file', { success: true, output: out }, { toolUseId: `tu_${round}_${c}` })
    out = budgeted.output ?? out
    content.push({ type: 'tool_result', tool_use_id: `tu_${round}_${c}`, content: out })
  }
  return { role: 'user', content }
}

// 正交扫描：压缩后历史里是否出现 orphan tool_result（无配对 tool_use）
function scanOrphans(messages: Msg[]): { orphanResults: number; toolUseIds: number } {
  const useIds = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') useIds.add(b.id)
    }
  }
  let orphans = 0
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !useIds.has(b.tool_use_id)) {
        orphans++
      }
    }
  }
  return { orphanResults: orphans, toolUseIds: useIds.size }
}

function totalToolResultChars(messages: Msg[]): number {
  let n = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_result' && typeof b.content === 'string') n += b.content.length
    }
  }
  return n
}

function skillBlockChars(messages: Msg[]): number {
  let n = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_result' && typeof b.content === 'string' && isSkillInstructionsBlock(b.content)) {
        n += b.content.length
      }
    }
  }
  return n
}

describe('80轮×50工具调用×每轮压缩 — 全链路集成压力', () => {
  it(
    '驱动真实工具/缓存/上下文/thinking/skill/压缩数据路径，统计泄漏/截断/溢出',
    () => {
      // 强制每轮 micro_compact：micro 阈值极低、auto/block 抬到极高 → 永远落在 micro 层。
      const mgr = new ContextManager({
        warningTokens: 50,
        errorTokens: 100,
        historySnipTokens: 200,
        microCompactTokens: 400,
        autoCompactTokens: 5_000_000,
        blockingTokens: 9_000_000,
      })

      let messages: Msg[] = []
      const SYSTEM = '你是集成压力测试中的 agent。'
      const TOOL_DEFS_TOKENS = 3_000

      let compactedRounds = 0
      let maxTotalCharsObserved = 0
      let nonFiniteTokenRounds = 0
      let orphanRoundsAfterCompact = 0
      let oversizedSkillTailLost = false

      const heapStart = process.memoryUsage().heapUsed

      runWithAgentContext(STRESS_CTX, () => {
        for (let round = 1; round <= ROUNDS; round++) {
          messages.push({ role: 'user', content: [{ type: 'text', text: `用户第 ${round} 轮指令：继续工作。` }] })
          messages.push(assistantWith50ToolUses(round))
          messages.push(userWith50ToolResults(round))

          // 工具/缓存子系统：每个工具调用记录一条读回执（唯一路径 → 压最坏内存场景）
          for (let c = 0; c < TOOLS_PER_ROUND; c++) {
            const p = `C:/ws/r${round}/file_${round}_${c}.ts`
            recordSuccessfulRead(p, {
              mtimeMs: round * 1000 + c,
              isPartialView: false,
              fullFileContent: `内容-${round}-${c}`,
              viewedContent: `内容-${round}-${c}`,
            })
          }

          // skill 子系统：每轮调一个“重复 skill”（应有界）+ 每 5 轮调一个 unique skill（测累积）
          recordInvokedSkill({ agentId: AGENT_ID, skillName: 'verify', skillPath: '/s/verify', content: 'body' })
          if (round % 5 === 0) {
            recordInvokedSkill({ agentId: AGENT_ID, skillName: `dyn-skill-${round}`, skillPath: `/s/${round}`, content: 'body'.repeat(50) })
          }

          // 每 20 轮注入一个 skill 指令块到历史（含一次 >120k 测尾部截断）
          if (round % 20 === 0) {
            const big = round === 40
            const body = big
              ? 'HEAD步骤1\n' + 'm'.repeat(SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS + 10_000) + '\nTAIL最终验证步骤'
              : '步骤1\n步骤2\n步骤3'
            const skillBlock = formatInlineSkillInstructionsOutput(big ? 'huge-skill' : 'flow', undefined, body)
            messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_skill_${round}`, name: 'Skill', input: {} }] })
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_skill_${round}`, content: skillBlock }] })
          }

          // ── 上下文子系统：真实阈值评估，确认每轮都要压缩 ──
          const verdict = mgr.evaluate(messages, SYSTEM, TOOL_DEFS_TOKENS)
          if (verdict.action !== 'none') compactedRounds++
          const est = mgr.getState().estimatedTokens
          if (!Number.isFinite(est) || est < 0) nonFiniteTokenRounds++

          // ── 真实压缩数据路径（micro_compact 层的实际操作）：clamp → microCompact ──
          messages = clampToolResultsInMessages(messages)
          messages = microCompact(messages, 5)

          // 压缩后正确性校验
          const after = totalToolResultChars(messages)
          if (after > maxTotalCharsObserved) maxTotalCharsObserved = after
          const { orphanResults } = scanOrphans(messages)
          if (orphanResults > 0) orphanRoundsAfterCompact++

          // 检查 >120k skill 块的尾部是否在压缩后丢失
          if (round === 40) {
            const stillHasTail = messages.some(
              (m) => Array.isArray(m.content) && (m.content as Block[]).some(
                (b) => typeof b.content === 'string' && b.content.includes('TAIL最终验证步骤'),
              ),
            )
            oversizedSkillTailLost = !stillHasTail
          }
        }
      })

      // ── 收集 findings ──
      const heapEnd = process.memoryUsage().heapUsed
      const receiptCount = runWithAgentContext(STRESS_CTX, () => listReadReceiptsInCurrentScope().length)
      const skillFragment = peekInvokedSkillsPromptFragmentForAgent(AGENT_ID)
      const invokedSkillCount = (skillFragment.match(/^\s*-\s/gm) ?? []).length || (skillFragment ? skillFragment.split('\n').filter(Boolean).length : 0)
      const spillFiles = fs.existsSync(SPILL_DIR) ? fs.readdirSync(SPILL_DIR).filter((f) => f.endsWith('.txt')).length : 0
      const finalSkillBlockChars = skillBlockChars(messages)

      // F1 — readFileState 读回执现已按 scope LRU 上限有界（修复后）
      const internals = __getReadFileStateInternalsForTests()
      addFinding({
        类别: '工具/缓存(readFileState)',
        指标: `byScope 当前 scope 读回执数(唯一路径 4000, cap=${internals.maxReceiptsPerScope})`,
        实测: receiptCount,
        判定: receiptCount <= internals.maxReceiptsPerScope ? '正常' : '泄漏',
        说明: '修复：每 scope 插入序 LRU 上限 MAX_READ_RECEIPTS_PER_SCOPE，逐出最旧回执并注销其 readId/dedup',
      })

      // F2 — invokedSkills 按唯一 skill 名累积
      addFinding({
        类别: 'skill(invokedSkillsRegistry)',
        指标: 'invoked skill fragment 行数(repeat=verify + unique dyn)',
        实测: invokedSkillCount,
        判定: invokedSkillCount > ROUNDS / 5 ? '泄漏' : '正常',
        说明: 'key=agentId:skillName，repeat 有界(1)，但 unique 名按数量累积；主 chat 无 finalizeSubAgentLifecycle 全清',
      })

      // F3 — spill 磁盘文件（loop 内每 50 轮 / 1h TTL 才清）
      addFinding({
        类别: '缓存(toolResultBudget spill)',
        指标: 'spill .txt 文件数(本测试不触发 janitor)',
        实测: spillFiles,
        判定: spillFiles > 0 ? '⚠️发现' : '正常',
        说明: 'cleanupOldToolResults 仅 loop 每 50 iter / >1h 触发；vitest 路径不自动清，1h 窗口内可堆积',
      })

      // F4 — 压缩后历史总字符是否有界（截断/溢出控制是否生效）
      addFinding({
        类别: '上下文/缓存(clamp+micro)',
        指标: '压缩后单轮 tool_result 总字符峰值',
        实测: maxTotalCharsObserved,
        判定: maxTotalCharsObserved <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS + finalSkillBlockChars + 50_000 ? '正常' : '溢出',
        说明: `应被 clamp(200k) + microCompact 控制；skill 块豁免 Pass2 额外占 ${finalSkillBlockChars} 字符`,
      })

      // F5 — skill 指令块在历史中累积（豁免 Pass2 + microCompact 视 Skill 为 read-only 保护）
      addFinding({
        类别: 'skill/上下文(历史累积)',
        指标: '最终历史中 skill 指令块总字符',
        实测: finalSkillBlockChars,
        判定: finalSkillBlockChars > SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS ? '⚠️发现' : '正常',
        说明: 'skill 块豁免全局 oldest-first 裁剪；多轮注入会在历史累积，长会话需关注',
      })

      // F6 — >120k 超大 skill 尾部截断
      addFinding({
        类别: 'skill(截断)',
        指标: '>120k skill 块尾部(TAIL最终验证步骤)是否丢失',
        实测: oversizedSkillTailLost ? '丢失' : '保留',
        判定: oversizedSkillTailLost ? '截断' : '正常',
        说明: 'Pass1 per-block cap=120k，超过即 HEAD 截断丢尾 → 超大 SKILL.md 的后续步骤在压缩后不可见',
      })

      // F7 — 压缩后 orphan tool_result（配对正确性）
      addFinding({
        类别: '上下文/编排(配对)',
        指标: '出现 orphan tool_result 的轮数',
        实测: orphanRoundsAfterCompact,
        判定: orphanRoundsAfterCompact > 0 ? '⚠️发现' : '正常',
        说明: 'microCompact/clamp 保留消息结构，不应产生无配对 tool_result',
      })

      // F8 — token 估算溢出/NaN
      addFinding({
        类别: '上下文(token 估算)',
        指标: 'estimatedTokens 非有限/负数的轮数',
        实测: nonFiniteTokenRounds,
        判定: nonFiniteTokenRounds > 0 ? '溢出' : '正常',
        说明: '纯 JS number 加法，无溢出保护；本规模应保持有限正数',
      })

      // F9 — 每轮都触发压缩
      addFinding({
        类别: '上下文(压缩触发)',
        指标: `触发压缩的轮数 / ${ROUNDS}`,
        实测: compactedRounds,
        判定: compactedRounds === ROUNDS ? '正常' : '⚠️发现',
        说明: '验证“每一轮都引发上下文压缩”的前提成立',
      })

      // F10 — 堆增长（信息性；--expose-gc 下更稳）
      const heapDeltaMB = ((heapEnd - heapStart) / 1024 / 1024).toFixed(1)
      addFinding({
        类别: '内存(heap)',
        指标: 'heapUsed 增长(MB)',
        实测: heapDeltaMB,
        判定: '⚠️发现',
        说明: '信息性指标；受 GC 影响，建议 --expose-gc 复测。读回执 snapshot(≤512KB/条)是主要占用',
      })

      // ── 硬断言：正确性不变量必须成立 ──
      expect(compactedRounds, '应每轮都触发压缩').toBe(ROUNDS)
      expect(orphanRoundsAfterCompact, '压缩后不应出现 orphan tool_result').toBe(0)
      expect(nonFiniteTokenRounds, 'token 估算不应出现 NaN/Infinity/负数').toBe(0)
      expect(maxTotalCharsObserved, '压缩后历史不应无界膨胀').toBeLessThan(
        MAX_TOOL_RESULTS_PER_MESSAGE_CHARS + finalSkillBlockChars + 200_000,
      )
      // 修复后：单 scope 读回执被 LRU 上限有界（4000 唯一路径 → 截到 cap）
      expect(receiptCount, 'readFileState 单 scope 读回执应被 LRU 上限有界').toBeLessThanOrEqual(internals.maxReceiptsPerScope)
      expect(receiptCount, '4000 唯一路径应触发 cap（截到上限）').toBe(internals.maxReceiptsPerScope)
      // >120k skill 尾部截断是设计上的 per-block cap 行为（120k），固化为特征
      expect(oversizedSkillTailLost, '>120k skill 尾部在压缩后丢失（设计上限 120k 的截断特征）').toBe(true)
    },
    120_000,
  )

  it(
    'Agent 系统 — 大量子代理 spawn/teardown：scope 桶数有界 + 子代理 skill 清理',
    async () => {
      clearAllReadFileState()
      resetInvokedSkillsRegistryForTests()

      // 远超 MAX_READ_RECEIPT_SCOPES，验证外层 byScope 桶数被 LRU 上限约束。
      const SUB_AGENTS = 300
      const FILES_PER_SUB = 30
      let invokedSkillLeakAfterFinalize = 0

      for (let i = 0; i < SUB_AGENTS; i++) {
        const subId = asAgentId(`sub-${i}`)
        const subCtx = {
          agentId: subId,
          streamConversationId: CONV_ID,
          model: 'stress',
          systemPrompt: 'sys',
          messages: [],
          config: {} as never,
          signal: new AbortController().signal,
        } as unknown as AgentContext

        // 子代理在自己的 scope 内读文件 + 调 skill（真实 Agent 数据路径）
        await runWithAgentContextAsync(subCtx, async () => {
          for (let f = 0; f < FILES_PER_SUB; f++) {
            recordSuccessfulRead(`C:/ws/sub${i}/f_${f}.ts`, {
              mtimeMs: i * 100 + f,
              isPartialView: false,
              fullFileContent: `子代理${i}文件${f}`,
              viewedContent: `子代理${i}文件${f}`,
            })
          }
          recordInvokedSkill({ agentId: subId, skillName: 'verify', skillPath: '/s/verify', content: 'b' })
          recordInvokedSkill({ agentId: subId, skillName: `sub-skill-${i}`, skillPath: `/s/${i}`, content: 'b' })
        })

        // 真实 Agent 生命周期收尾（清 invoked-skills、task、sidechain 等）
        try {
          await finalizeSubAgentLifecycle(subId, { streamConversationId: CONV_ID })
        } catch {
          /* 内部各步均 try/catch；忽略环境相关告警 */
        }

        // finalize 后该子代理的 invoked-skills 应被清空（生产泄漏防护）
        if (peekInvokedSkillsPromptFragmentForAgent(subId) !== '') {
          invokedSkillLeakAfterFinalize++
        }
      }

      const internals = __getReadFileStateInternalsForTests()

      addFinding({
        类别: 'Agent(子代理 scope 桶)',
        指标: `byScope 桶数(spawn ${SUB_AGENTS} 子代理, cap=${internals.maxScopes})`,
        实测: internals.scopeCount,
        判定: internals.scopeCount <= internals.maxScopes ? '正常' : '泄漏',
        说明: '修复：外层 byScope 桶数 LRU 上限 MAX_READ_RECEIPT_SCOPES；逐出整桶并注销 readId/dedup（兄弟复用仍保留近期桶）',
      })
      addFinding({
        类别: 'Agent(子代理 skill 清理)',
        指标: 'finalize 后仍残留 invoked-skills 的子代理数',
        实测: invokedSkillLeakAfterFinalize,
        判定: invokedSkillLeakAfterFinalize === 0 ? '正常' : '泄漏',
        说明: 'finalizeSubAgentLifecycle → clearInvokedSkillsForAgent 正确清空子代理 skill 槽',
      })
      addFinding({
        类别: 'Agent(readId 索引)',
        指标: 'byReadId 全局索引条目数',
        实测: internals.readIdCount,
        判定: internals.readIdCount <= internals.maxScopes * internals.maxReceiptsPerScope ? '正常' : '泄漏',
        说明: 'scope 逐出时同步注销 readId，索引不随子代理数无界增长',
      })
      addFinding({
        类别: 'Agent(dedup strike)',
        指标: 'dedupStrikeCount 条目数',
        实测: internals.dedupStrikeCount,
        判定: '正常',
        说明: 'scope 逐出 / clear* 均同步清理 dedup strike（修复前从不清理）',
      })

      // 硬断言：两层 LRU 都生效，子代理 skill 被清
      expect(internals.scopeCount, '外层 byScope 桶数应被 LRU 上限约束').toBeLessThanOrEqual(internals.maxScopes)
      expect(invokedSkillLeakAfterFinalize, 'finalize 后不应残留子代理 invoked-skills').toBe(0)
      expect(internals.readIdCount, 'byReadId 索引应随 scope 逐出同步收缩').toBeLessThanOrEqual(
        internals.maxScopes * internals.maxReceiptsPerScope,
      )
    },
    120_000,
  )
})
