/**
 * bundleAgentsBridge —— 把当前激活 Bundle 里的 agents 展开成
 * `AgentDefinitionUnion[]`,接入 `tools/registry` 的 `allAgentsCache`
 * 与 `Agent` 工具的路由列表。
 *
 * 为什么需要这层:
 *   - `AgentBundleEntry` 继承自 `AgentDefinition`,字段布局其实已经
 *     接近 `CustomAgentDefinition` 了,但缺少一个运行时必须的
 *     `getSystemPrompt()` 闭包。Bundle 里的 agent 可能用两种方式
 *     提供提示词:
 *       1. `promptSections[]`(结构化,由模板引导编辑器写入)
 *       2. `systemPromptRaw`(自由文本)
 *     我们在这里用 `composeSystemPrompt` 把二者合并成运行时闭包。
 *
 *   - Bundle 里也经常出现"只有 meta、没有 prompt"的条目(例如
 *     code-dev.json 的 agents 数组只是给内置 Explore/Plan/Debug
 *     写个中文 displayName)。这类条目**不应该**被转成 custom agent
 *     登记——否则会在合并时覆盖内置实现,丢掉内置 `getSystemPrompt`。
 *     因此只有 `promptSections` / `systemPromptRaw` 至少有一个
 *     非空的条目才会被转换输出。
 *
 *   - 合并时在 `mergeLayeredAgentDefinitions` 里挂到新的 `bundle`
 *     层级(优先级低于 flag/policy,高于 renderer custom agents),
 *     使用 `force: false`,不会替换 built-in 实现。
 */

import type { AgentDefinitionUnion, CustomAgentDefinition } from '../types'
import type { AgentBundleEntry, Bundle } from './types'
import { composeSystemPrompt } from './bundleSerialize'

/**
 * Bundle 里的 `whenToUse` 经常是英文模板或者干脆空着,而 `displayName` /
 * `tagline` 是用户写的中文。Agent 工具路由只看 `whenToUse`+`capability`,
 * 这里把最具信息量的文案合并成一句路由提示,避免主 AI 看到一行空名字。
 */
function resolveWhenToUse(entry: AgentBundleEntry): string {
  const parts: string[] = []
  if (typeof entry.whenToUse === 'string' && entry.whenToUse.trim()) {
    parts.push(entry.whenToUse.trim())
  }
  if (typeof entry.tagline === 'string' && entry.tagline.trim()) {
    parts.push(entry.tagline.trim())
  }
  if (parts.length === 0 && typeof entry.displayName === 'string' && entry.displayName.trim()) {
    parts.push(entry.displayName.trim())
  }
  return parts.join(' — ')
}

/**
 * 从激活 Bundle 展开可路由的 agents。
 *
 * 仅输出那些"有自定义提示词"的 agent(有 `promptSections` 或
 * `systemPromptRaw`);纯 meta 条目(比如 code-dev 里的 general-purpose
 * 快捷方式)被跳过,让内置 built-in 版本继续生效。
 *
 * 返回的每个条目把 Bundle 里所有通用字段(tools / model / maxTurns /
 * permissionMode 等)透传到 `CustomAgentDefinition`,这样 Agent 工具
 * 的路由描述 + 运行时过滤 + 模型 alias 都和普通自定义 agent 完全一致。
 */
export function bundleAgentsToDefinitions(
  bundle: Bundle | undefined | null,
): AgentDefinitionUnion[] {
  if (!bundle || !Array.isArray(bundle.agents)) return []
  const out: AgentDefinitionUnion[] = []
  for (const entry of bundle.agents) {
    // 只要 type 为空就跳过(防御异常数据)
    if (typeof entry.agentType !== 'string' || !entry.agentType.trim()) continue

    // 先尝试合成提示词;没有自定义提示词的条目不登记,让 built-in
    // 的 `getSystemPrompt` 保留原状。
    const composed = composeSystemPrompt(entry)
    if (!composed || composed.trim().length === 0) continue

    const def: CustomAgentDefinition = {
      source: 'custom',
      agentType: entry.agentType,
      // 如果 whenToUse 为空,fallback 到 tagline / displayName,让 Agent 工具
      // 路由列表至少有一点语义,否则主 AI 看到的就是一行空 (Tools: ...)
      whenToUse: resolveWhenToUse(entry),
      getSystemPrompt: () => composed,
      ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
      ...(entry.color !== undefined ? { color: entry.color } : {}),
      // 运行时参数
      ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
      ...(entry.disallowedTools !== undefined
        ? { disallowedTools: entry.disallowedTools }
        : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.maxTurns !== undefined ? { maxTurns: entry.maxTurns } : {}),
      ...(entry.maxTokenBudget !== undefined
        ? { maxTokenBudget: entry.maxTokenBudget }
        : {}),
      ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
      ...(entry.thinkingBudgetTokens !== undefined
        ? { thinkingBudgetTokens: entry.thinkingBudgetTokens }
        : {}),
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      ...(entry.permissionMode !== undefined
        ? { permissionMode: entry.permissionMode }
        : {}),
      ...(entry.parentPolicy !== undefined ? { parentPolicy: entry.parentPolicy } : {}),
      ...(entry.subagentToolProfile !== undefined
        ? { subagentToolProfile: entry.subagentToolProfile }
        : {}),
      ...(entry.coordinatorPhase !== undefined
        ? { coordinatorPhase: entry.coordinatorPhase }
        : {}),
      ...(entry.orchestrationRole !== undefined
        ? { orchestrationRole: entry.orchestrationRole }
        : {}),
      ...(entry.isReadOnly !== undefined ? { isReadOnly: entry.isReadOnly } : {}),
      ...(entry.omitClaudeMd !== undefined ? { omitClaudeMd: entry.omitClaudeMd } : {}),
      ...(entry.memory !== undefined ? { memory: entry.memory } : {}),
      ...(entry.isolation !== undefined ? { isolation: entry.isolation } : {}),
      ...(entry.background !== undefined ? { background: entry.background } : {}),
      ...(entry.initialPrompt !== undefined ? { initialPrompt: entry.initialPrompt } : {}),
      ...(entry.criticalReminder !== undefined
        ? { criticalReminder: entry.criticalReminder }
        : {}),
      ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
      ...(entry.mcpServers !== undefined ? { mcpServers: entry.mcpServers } : {}),
      ...(entry.agentHooks !== undefined ? { agentHooks: entry.agentHooks } : {}),
    } as CustomAgentDefinition

    out.push(def)
  }
  return out
}
