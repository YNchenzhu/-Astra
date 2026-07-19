/**
 * RedactedThinkingBlock — Anthropic 加密 chain-of-thought 的 UI 占位。
 *
 * 当服务端启用 REDACT_THINKING beta（详见
 * `electron/ai/anthropicThinkingApiContext.ts#getAnthropicThinkingApiContext`），
 * 模型返回的不是 `thinking` 块（含可读文本）而是 `redacted_thinking` 块
 * （含 Anthropic 加密后的 `data` blob — 客户端读不到 model-visible 内容）。
 *
 * UI 设计：
 *   - 不可展开（没有 model-visible 文本可显示）
 *   - 视觉与 ThinkingBlock 区分（icon 不同，hint 文本明确"加密"）
 *   - 极简：单行 icon + 标签 + 提示
 *
 * 跨轮回灌：data 字段必须存入 ChatMessage.blocks，下一轮
 * `chatMessageToAgentApiRows` 原样回灌给 Anthropic（不回灌会让 trajectory
 * 不连续 → 服务端拒签）。本组件只负责"已经存好的块"的展示，回灌逻辑见
 * `src/services/contextBuilder.ts`。
 *
 * 镜像 upstream-main `src/components/messages/AssistantRedactedThinkingMessage.tsx`：
 * 同样的"不可展开 + 简单占位"设计。
 */

import React from 'react'
import './RedactedThinkingBlock.css'

export const RedactedThinkingBlock: React.FC = () => (
  <div
    className="redacted-thinking-block"
    role="note"
    aria-label="模型私密推理（已加密）"
  >
    <span className="redacted-thinking-icon" aria-hidden="true">
      ✻
    </span>
    <span className="redacted-thinking-label">Thinking</span>
    <span className="redacted-thinking-hint">(私密推理已加密)</span>
  </div>
)
