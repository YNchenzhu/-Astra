/**
 * agentExperienceMemory —— Sprint 6+8: 跨会话知识沉淀。
 *
 * 当一个 agent 顺利完成任务后,把"本次做了什么、用了什么工具、花了
 * 多少资源"写成一个 markdown 经验文件,存到该 agent 的 memory 目录。
 * 下一次同类型 agent 启动时,`buildAgentMemoryPromptAppend` 会自动
 * 把这些文件拼到 system prompt 里,相当于一个"技能沉淀 + 回忆"循环。
 *
 * 默认关闭 —— 需要用户在 Settings · 记忆 里主动开启(见
 * `agentExperienceMemoryEnabled` 设置项)。关闭时本模块是 no-op,
 * 不会往磁盘写一个字节。
 *
 * 两种总结路径(Sprint 8):
 *   - **LLM 总结**(tokenCount >= LLM_TOKEN_THRESHOLD 时):借用会话笔记的
 *     7 段模板,调用 streamText 让模型从 agent.messages 中提炼经验。
 *   - **模板 fallback**(token 不够 / LLM 失败 / 未配 API Key):拼字段 md,
 *     信息量低但总有一条记录。
 *
 * 写入策略(防垃圾):
 *   ✓ 仅当 status === 'completed'(失败/终止不写)
 *   ✓ 至少 3 次 tool use(一次性简单 Q&A 没必要沉淀)
 *   ✓ 至少 500 tokens(极低消耗的任务没啥好记的)
 *   ✓ 同一 agentType 同一 24 小时内最多写 20 条(模板/LLM 合计,防刷)
 *   ✓ LLM 路径额外上限: 同 agent 24h 最多 5 条 LLM 调用
 *
 * scope 选择:
 *   - 优先使用 `agentDef.memory` 字段('user' / 'project' / 'local')
 *   - 没设 → 默认 'project'(绑定当前工作区,不污染全局)
 *   - 'project' / 'local' 需要 workspacePath,没有则回退 'user'
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ActiveAgent } from './types'
import {
  getAgentMemoryDir,
  type AgentMemoryScope,
} from '../memory/agentMemory'
import type { MemoryFrontmatter } from '../memory/types'
import { streamText, type StreamTextParams, type StreamCallbacks, type ProviderConfig, type ProviderId } from '../ai/client'
import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
import { resolveAiCredentialsFromDisk } from '../ai/diskCredentials'
import { readDiskSettings } from '../settings/settingsAccess'

/** 24h 内同 agentType 的"所有经验"上限,防止无聊任务刷爆 memory。 */
const DAILY_PER_AGENT_MAX = 20

/** 24h 内同 agentType 调 LLM 上限,控制成本。 */
const DAILY_LLM_PER_AGENT_MAX = 5

/** Token 下限 —— 小于这个的任务不记。 */
const MIN_TOKEN_THRESHOLD = 500

/** LLM 总结的触发下限 —— 高于模板下限。 */
const LLM_TOKEN_THRESHOLD = 1000

/** Tool-use 下限 —— 少于这个的任务不记(简单问答)。 */
const MIN_TOOL_USE_COUNT = 3

/** LLM 总结请求的超时 */
const LLM_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(300_000, Number(process.env.POLE_AGENT_EXPERIENCE_LLM_TIMEOUT_MS ?? '60000')),
)

/** 喂给 LLM 总结器的最大 output token 数 */
const LLM_MAX_OUTPUT_TOKENS = 2_000

/** In-memory daily rate-limit counters. Reset on process restart. */
const dailyCounters = new Map<string, { day: string; count: number }>()
const dailyLlmCounters = new Map<string, { day: string; count: number }>()

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function bumpCounter(map: Map<string, { day: string; count: number }>, key: string): number {
  const k = todayKey()
  const e = map.get(key)
  if (!e || e.day !== k) {
    map.set(key, { day: k, count: 1 })
    return 1
  }
  e.count += 1
  return e.count
}

function peekCounter(
  map: Map<string, { day: string; count: number }>,
  key: string,
): number {
  const k = todayKey()
  const e = map.get(key)
  return e && e.day === k ? e.count : 0
}

/** 选 memory scope。优先 agent 自己的声明,否则 project(若有 ws)→ user。 */
function resolveMemoryScope(
  agent: ActiveAgent,
  workspacePath: string | null,
): AgentMemoryScope {
  const declared = agent.agentDef.memory
  if (declared === 'user') return 'user'
  if (declared === 'project' || declared === 'local') {
    return workspacePath ? declared : 'user'
  }
  return workspacePath ? 'project' : 'user'
}

/** 从 agent.messages 里提取最近几条 tool use 的 name,用作"用了哪些工具"摘要。 */
function extractToolNames(agent: ActiveAgent): string[] {
  const names: string[] = []
  for (const m of agent.messages) {
    const raw = m as Record<string, unknown>
    const content = raw.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const n = block.name
        if (typeof n === 'string' && n.trim()) {
          if (!names.includes(n)) names.push(n)
        }
      }
    }
  }
  return names
}

/** 粗略估计本次运行的 tool use 总次数(不去重)。 */
function countToolUses(agent: ActiveAgent): number {
  let count = 0
  for (const m of agent.messages) {
    const raw = m as Record<string, unknown>
    const content = raw.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        count++
      }
    }
  }
  return count
}

/** 提取 agent 最后一条 assistant 文本作为"任务最终输出摘要"。截断到 800 字。 */
function extractLastAssistantText(agent: ActiveAgent): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i] as Record<string, unknown>
    if (m.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string') {
      return content.slice(0, 800)
    }
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const block of content as Record<string, unknown>[]) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) return texts.join('\n').slice(0, 800)
    }
  }
  return ''
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s.toFixed(1)} 秒`
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins} 分 ${secs.toString().padStart(2, '0')} 秒`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function buildFrontmatter(
  agent: ActiveAgent,
  scope: AgentMemoryScope,
  source: 'llm' | 'template',
): MemoryFrontmatter {
  const now = new Date().toISOString()
  const label = agent.name || agent.description.slice(0, 40) || agent.agentType
  const scopeMap: Record<AgentMemoryScope, 'user' | 'project' | 'session'> = {
    user: 'user',
    project: 'project',
    local: 'session',
  }
  return {
    name: `${agent.agentType} · ${label}`,
    description: agent.description.slice(0, 200) || `${agent.agentType} 任务完成经验`,
    type: 'feedback',
    created: now,
    updated: now,
    scope: scopeMap[scope],
    enabled: true,
    tags: [
      agent.agentType,
      ...(agent.teamName ? [`team:${agent.teamName}`] : []),
      'agent-experience',
      source === 'llm' ? 'llm-generated' : 'template-generated',
    ],
  }
}

function buildTemplateContent(
  agent: ActiveAgent,
  toolNames: string[],
  toolUseCount: number,
): string {
  const lines: string[] = []
  lines.push(`# ${agent.agentType} 运行经验`)
  lines.push('')
  if (agent.description) {
    lines.push(`**任务描述**:${agent.description}`)
  }
  if (agent.teamName) {
    lines.push(`**团队**:${agent.teamName}`)
  }
  lines.push(`**运行时长**:${formatDuration((agent.endedAt ?? Date.now()) - agent.startTime)}`)
  lines.push(`**Token 消耗**:${formatTokens(agent.tokenCount ?? 0)}`)
  lines.push(`**工具调用**:${toolUseCount} 次`)
  if (toolNames.length > 0) {
    lines.push(`**涉及工具**:${toolNames.join(', ')}`)
  }
  if (agent.agentDef.model) {
    lines.push(`**使用模型**:${agent.agentDef.model}`)
  }
  lines.push('')
  lines.push(
    `> 本条由系统自动生成(模板模式),作为 **${agent.agentType}** 类型智能体的经验沉淀。` +
      `下次启动同类型智能体时会自动作为 memory 上下文。`,
  )
  return lines.join('\n') + '\n'
}

function serializeMemoryMarkdown(fm: MemoryFrontmatter, content: string): string {
  const fmLines: string[] = ['---']
  fmLines.push(`name: ${fm.name}`)
  fmLines.push(`description: ${fm.description}`)
  fmLines.push(`type: ${fm.type}`)
  fmLines.push(`created: ${fm.created}`)
  fmLines.push(`updated: ${fm.updated}`)
  if (fm.scope) fmLines.push(`scope: ${fm.scope}`)
  if (typeof fm.enabled === 'boolean') fmLines.push(`enabled: ${fm.enabled}`)
  if (fm.tags && fm.tags.length > 0) {
    fmLines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(', ')}]`)
  }
  fmLines.push('---')
  return fmLines.join('\n') + '\n\n' + content
}

/**
 * Sprint 8: LLM 总结路径。构造一次调用,不走 fork/sub-agent,避免触及
 * session-memory-internal 的沙盒规则。
 *
 * 失败(网络错误 / 超时 / 未配 key)返回 null,调用方会 fallback 模板。
 */
async function generateLlmExperienceBody(
  agent: ActiveAgent,
  toolNames: string[],
  toolUseCount: number,
): Promise<string | null> {
  // 从设置读 provider credentials
  let config: ProviderConfig | null
  try {
    const settings = readDiskSettings() as Record<string, unknown>
    const creds = resolveAiCredentialsFromDisk(settings)
    if (!creds.apiKey && creds.providerId !== 'bedrock' && creds.providerId !== 'vertex') {
      return null
    }
    config = {
      id: creds.providerId as ProviderId,
      name: creds.providerId,
      apiKey: creds.apiKey ?? '',
      baseUrl: creds.baseUrl || undefined,
      awsRegion: creds.awsRegion,
      projectId: creds.projectId,
    }
  } catch {
    return null
  }

  // 模型选择:优先 agent.model;否则 settings.model;再不行用默认。
  let model = agent.agentDef.model?.trim() || ''
  if (!model || model === 'inherit') {
    const creds = resolveAiCredentialsFromDisk(readDiskSettings() as Record<string, unknown>)
    model = creds.model || 'claude-sonnet-4-5'
  }

  const lastAssistant = extractLastAssistantText(agent)
  const duration = formatDuration((agent.endedAt ?? Date.now()) - agent.startTime)
  const tokens = formatTokens(agent.tokenCount ?? 0)
  const toolLine = toolNames.length > 0 ? toolNames.join(', ') : '(无工具调用)'

  const systemPrompt = `你是"智能体经验沉淀器"。基于一个刚刚完成的子智能体的运行数据,写一份可复用的经验
笔记,给下次同类型智能体作为上下文参考。

严格按以下 markdown 模板输出(保留段落标题,逐个填充):

# ${agent.agentType} 经验

## 本次任务
(一句话总结这次做了什么,对应什么样的用户需求场景)

## 成功做法
(列出本次 agent 做得好的关键步骤或决策;如无显著成功点写"常规完成")

## 关键难点
(本次任务中遇到的技术/理解障碍;如顺利完成无难点写"无")

## 可复用模式
(如果下次遇到类似任务,有哪些步骤、工具顺序、提问方式可以抄?用 2-3 条要点)

## 注意事项
(任何陷阱、容易错的地方、需要警惕的边界条件;具体;如无写"暂无")

要求:
- 中文输出,简洁不堆砌
- 不要生造细节,只基于提供的数据推断
- 每段 1-3 句,整体控制在 300 字内
- 不要包含代码块/链接,纯文本段落即可`

  const userMessage =
    `## 智能体运行数据\n\n` +
    `- **Agent 类型**: ${agent.agentType}\n` +
    (agent.name ? `- **运行名**: ${agent.name}\n` : '') +
    (agent.teamName ? `- **所在团队**: ${agent.teamName}\n` : '') +
    `- **任务描述**: ${agent.description || '(未提供)'}\n` +
    `- **运行时长**: ${duration}\n` +
    `- **Token 消耗**: ${tokens}\n` +
    `- **工具调用**: ${toolUseCount} 次\n` +
    `- **涉及工具**: ${toolLine}\n` +
    (lastAssistant
      ? `\n## 智能体最后输出(截取前 800 字)\n\n${lastAssistant}\n`
      : '\n## 智能体最后输出\n\n(没有文本输出,或仅工具调用收尾)\n') +
    `\n请按模板写一份 agent 经验笔记。`

  const streamParams: StreamTextParams = {
    model,
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt,
    maxTokens: LLM_MAX_OUTPUT_TOKENS,
    alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }, LLM_TIMEOUT_MS)

  let buffer = ''
  let errored = false
  const callbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      buffer += text
    },
    onMessageEnd: () => {
      /* no-op */
    },
    onError: () => {
      errored = true
    },
  }

  try {
    await streamText(config, streamParams, callbacks, controller.signal)
  } catch {
    errored = true
  } finally {
    clearTimeout(timer)
  }

  if (errored || buffer.trim().length === 0) return null
  return buffer.trim() + '\n'
}

/**
 * 主入口:在 agent 终止时被调用。返回写入的文件绝对路径,或 null。
 * 不抛异常 —— 记忆系统失败不应影响 agent 正常 teardown。
 *
 * Sprint 8: 当启用 LLM 路径(默认是;token 达标 + 今日 LLM 配额未满)
 * 时,优先调 streamText 做经验总结;失败回退模板。
 */
export async function recordAgentExperience(
  agent: ActiveAgent,
  workspacePath: string | null,
  options?: { enabled?: boolean },
): Promise<string | null> {
  try {
    // ── 门槛检查 ────────────────────────────────────────
    if (options?.enabled !== true) return null
    if (agent.status !== 'completed') return null

    const toolUseCount = countToolUses(agent)
    if (toolUseCount < MIN_TOOL_USE_COUNT) return null
    if ((agent.tokenCount ?? 0) < MIN_TOKEN_THRESHOLD) return null

    const dailyCount = bumpCounter(dailyCounters, agent.agentType)
    if (dailyCount > DAILY_PER_AGENT_MAX) return null

    // ── 路径 ────────────────────────────────────────
    const scope = resolveMemoryScope(agent, workspacePath)
    const dir = getAgentMemoryDir(scope, agent.agentType, workspacePath)
    if (!dir) return null
    fs.mkdirSync(dir, { recursive: true })

    const toolNames = extractToolNames(agent)

    // ── LLM 路径:尝试调用;失败则 fallback 模板 ────
    let content: string
    let source: 'llm' | 'template' = 'template'

    const llmEligible =
      (agent.tokenCount ?? 0) >= LLM_TOKEN_THRESHOLD &&
      peekCounter(dailyLlmCounters, agent.agentType) < DAILY_LLM_PER_AGENT_MAX

    if (llmEligible) {
      bumpCounter(dailyLlmCounters, agent.agentType)
      try {
        const llmBody = await generateLlmExperienceBody(agent, toolNames, toolUseCount)
        if (llmBody && llmBody.trim().length > 0) {
          // 在 LLM 生成的主体之后,追加一段机器可读的元数据(模板模式的简表)。
          // 这样"用户读"+"下次 agent 读"都有足够上下文。
          const meta =
            `\n---\n\n` +
            `_runtime_: ${formatDuration((agent.endedAt ?? Date.now()) - agent.startTime)} · ` +
            `${formatTokens(agent.tokenCount ?? 0)} tokens · ${toolUseCount} tool uses\n`
          content = llmBody + meta
          source = 'llm'
        } else {
          content = buildTemplateContent(agent, toolNames, toolUseCount)
        }
      } catch {
        content = buildTemplateContent(agent, toolNames, toolUseCount)
      }
    } else {
      content = buildTemplateContent(agent, toolNames, toolUseCount)
    }

    // ── 构建文件 ────────────────────────────────────
    const fm = buildFrontmatter(agent, scope, source)
    const markdown = serializeMemoryMarkdown(fm, content)

    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '')
    const shortId = crypto.randomBytes(3).toString('hex')
    const kindTag = source === 'llm' ? 'llm' : 'tpl'
    const filename = `experience_${kindTag}_${ts}_${shortId}.md`
    const filePath = path.join(dir, filename)

    fs.writeFileSync(filePath, markdown, 'utf-8')
    return filePath
  } catch (err) {
    console.warn('[agentExperienceMemory] record failed:', err)
    return null
  }
}
