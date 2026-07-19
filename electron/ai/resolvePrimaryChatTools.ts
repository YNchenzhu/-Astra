/**
 * resolvePrimaryChatTools —— 把 Bundle 主智能体的 `tools` / `disallowedTools` /
 * `mcpServers` 转成主对话可用的工具子集,再返回给 agenticLoop 的
 * `toolDefinitionsOverride`。
 *
 * 跟子智能体 `resolveAgentTools` 的差异:
 *   - 不剥离 INTERACTIVE_TOOL_NAMES(EnterPlanMode / AskUserQuestion 这类在
 *     主对话里是正常工具,子 agent 才需要禁)
 *   - 不走 `applyGlobalSubagentDenylist` / async_agent profile(主对话不是 sub-agent)
 *   - 不做 coordinatorDefWithRuntimeAllowlist 收紧(主对话如果是 Coordinator,
 *     在 streamHandler 已经通过 sessionAgentType 特殊分支注入 coordinator prompt)
 *
 * 调用前提:
 *   - 至少有一个字段非空,否则直接返回 undefined 让调用方走默认全量工具。
 *   - MCP 服务器要求已连接(通过 Settings 面板的 MCP 管理器);本函数不负责建连,
 *     只从 `toolRegistry.getAll()` 里挑。没连接的 `mcp__*` 工具不会出现在
 *     registry 里,自然也就不会被返回。
 */

import type { Tool } from '../tools/types'
import { toolRegistry } from '../tools/registry'
import { registryPrimaryToolName } from '../tools/builtinToolAliases'
import { shouldExposeDeferredTool } from '../tools/deferredDiscovery'

function normalizeToolsList(list: string[] | undefined): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const s = raw.trim()
    if (s.length === 0) continue
    out.push(s)
  }
  return out.length > 0 ? out : undefined
}

function normalizeMcpServerNameList(
  refs: Array<string | { name: string }> | undefined,
): string[] {
  if (!Array.isArray(refs)) return []
  const out: string[] = []
  for (const r of refs) {
    if (typeof r === 'string') {
      const s = r.trim()
      if (s) out.push(s)
    } else if (r && typeof (r as { name?: unknown }).name === 'string') {
      const s = (r as { name: string }).name.trim()
      if (s) out.push(s)
    }
  }
  return out
}

function toolNamesToRegistryKeys(names: string[]): Set<string> {
  const set = new Set<string>()
  for (const raw of names) {
    const n = raw.trim()
    if (n.length === 0) continue
    if (n === '*') {
      set.add('*')
      continue
    }
    set.add(registryPrimaryToolName(n))
  }
  return set
}

function filterMcpToolsByServers(tools: Tool[], mcpServers: string[]): Tool[] {
  if (mcpServers.length === 0) return tools
  const allow = new Set(mcpServers)
  return tools.filter((t) => {
    if (!t.name.startsWith('mcp__')) return true
    const server = extractMcpServerName(t.name)
    return server !== null && allow.has(server)
  })
}

export function extractMcpServerName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.split('__')
  if (parts.length < 3 || !parts[1]) return null
  return parts[1]
}

/**
 * 计算 Bundle 主智能体在主对话里能看到的工具列表。
 *
 * @returns  过滤后的 Tool[];如果主智能体没声明任何收紧约束(tools 是 `['*']` 或空,
 *           disallowedTools 空,mcpServers 空),返回 `null` 表示"不需要 override,
 *           沿用默认全量工具"。
 */
export function resolvePrimaryChatTools(params: {
  tools: string[] | undefined
  disallowedTools: string[] | undefined
  mcpServers: Array<string | { name: string }> | undefined
}): Tool[] | null {
  const toolsAllow = normalizeToolsList(params.tools)
  const toolsDeny = normalizeToolsList(params.disallowedTools)
  const mcpAllowNames = normalizeMcpServerNameList(params.mcpServers)

  const hasAllowlist =
    !!toolsAllow && !(toolsAllow.length === 1 && toolsAllow[0] === '*')
  const hasDenylist = !!toolsDeny && toolsDeny.length > 0
  const hasMcpFilter = mcpAllowNames.length > 0

  if (!hasAllowlist && !hasDenylist && !hasMcpFilter) {
    // 没有任何收紧条件,直接走 streamHandler 的默认工具解析路径
    return null
  }

  const allTools = toolRegistry.getAll().filter((t) => t.isEnabled?.() !== false)

  let base: Tool[]
  if (hasAllowlist) {
    // 显式点名 = 显式授权:白名单命中的工具 BYPASS 延迟加载(与子智能体
    // `resolveAgentTools` 的姿势一致 —— "Excel 专员" bundle 列了 excel_*
    // 就开局拿到全 schema,不需要 ToolSearch 发现)。
    const allowedSet = toolNamesToRegistryKeys(toolsAllow!)
    const resolvedByName = allTools.filter((t) => allowedSet.has(t.name))
    // MCP:白名单里没列 mcp__* 但列了 mcpServers 时,按 server 放宽
    const mcpTools = allTools.filter(
      (t) => t.name.startsWith('mcp__') && !allowedSet.has(t.name),
    )
    base = [...resolvedByName, ...filterMcpToolsByServers(mcpTools, mcpAllowNames)]
  } else if (hasDenylist) {
    // 2026-06 自审计修复:deny-only / mcp-only 分支此前不应用延迟加载过滤,
    // 任何配置了黑名单的 bundle 主对话会把全部 `shouldDefer` 工具(31 个
    // Office 工具 + LSP)整体拉回默认面 —— 与默认路径 `getToolDefinitions`
    // 的行为不一致,也让工具面减肥对这些工作区失效。这两个分支没有任何
    // "显式点名"语义,延迟工具应与默认路径同样隐藏、经 ToolSearch 发现。
    // (`mcp__*` 不在此过滤范围:MCP 工具的曝光由 mcpServers 白名单管。)
    const deniedSet = toolNamesToRegistryKeys(toolsDeny!)
    base = allTools.filter((t) => !deniedSet.has(t.name))
    base = base.filter((t) => t.name.startsWith('mcp__') || shouldExposeDeferredTool(t))
    base = filterMcpToolsByServers(base, mcpAllowNames)
  } else {
    base = filterMcpToolsByServers(allTools, mcpAllowNames)
    base = base.filter((t) => t.name.startsWith('mcp__') || shouldExposeDeferredTool(t))
  }

  return base
}
