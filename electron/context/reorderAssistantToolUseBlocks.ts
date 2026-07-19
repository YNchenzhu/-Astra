/**
 * `reorderAssistantToolUseBlocks` — tool_use 簇连续化（Bedrock 兜底）。
 *
 * Bedrock 与若干 Anthropic-compat gateway 严格要求一条 assistant 消息内的
 * `tool_use` 块必须连续出现：如果中间夹了 `text` / `thinking` 等其他块，
 * 服务端会返回 400 "tool_use blocks must be contiguous in an assistant
 * message" 类错误。Anthropic 自身宽松，但工作区面向多 provider，必须按
 * 最严的下游做防御。
 *
 * 移植自 upstream-main `src/utils/messages.ts:2454-2489`
 * (`reorderAssistantToolUseBlocks` 函数主体一字不改照搬，30 行算法)。
 *
 * 算法行为：
 *   1. 找出所有 `tool_use` 块的 indices；少于 2 个直接返回（无序列要重排）
 *   2. 找窗口 `[first, last]`，如果窗口内全是 `tool_use` 则已连续，无需重排
 *   3. 否则把窗口拆成 tools + displaced，重组为
 *      `[head, ...tools, ...displaced, ...tail]`
 *
 * 重要约束（与 upstream 一致）：
 *   - thinking / redacted_thinking 块如果**夹在 tool_use 簇内部**，会被
 *     推到 tool_use 簇之后（属于 displaced）。这是已生产验证过的行为 —
 *     跨 turn 的 thinking 签名按 `message.id` 分组校验，**块内位置变化
 *     不影响签名校验**（签名只针对 thinking 内容计算）。
 *   - 不丢任何块（无副作用）：head/tools/displaced/tail 拼回去等长。
 *
 * Idempotent：对已连续的内容是 no-op（返回同一引用）。
 */

export function reorderAssistantToolUseBlocks<T extends { type: string }>(
  content: T[],
): T[] {
  if (content.length < 2) return content

  const toolUseIndices: number[] = []
  for (let i = 0; i < content.length; i++) {
    if (content[i]!.type === 'tool_use') toolUseIndices.push(i)
  }
  if (toolUseIndices.length < 2) return content

  const first = toolUseIndices[0]!
  const last = toolUseIndices[toolUseIndices.length - 1]!

  let hasInterleaved = false
  for (let i = first; i <= last; i++) {
    if (content[i]!.type !== 'tool_use') {
      hasInterleaved = true
      break
    }
  }
  if (!hasInterleaved) return content

  const head = content.slice(0, first)
  const window = content.slice(first, last + 1)
  const tail = content.slice(last + 1)

  const tools: T[] = []
  const displaced: T[] = []
  for (const block of window) {
    if (block.type === 'tool_use') tools.push(block)
    else displaced.push(block)
  }

  return [...head, ...tools, ...displaced, ...tail]
}
