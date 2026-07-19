/**
 * 示例：如何在后端流式事件中使用新的思考链和工具卡片功能
 */

// ============================================================================
// 1. 思考链流式事件示例
// ============================================================================

// 当 AI 开始思考时，发送思考内容的增量更新
const thinkingExample = [
  {
    type: 'thinking_delta',
    text: '用户要求优化 UI 界面。'
  },
  {
    type: 'thinking_delta',
    text: '我需要：\n1. 分析当前代码结构\n2. 识别优化点\n3. 实现改进'
  },
  {
    type: 'thinking_delta',
    text: '\n首先，让我读取相关文件...'
  }
]

// ============================================================================
// 2. 工具调用流式事件示例
// ============================================================================

const toolCallExample = [
  // 工具开始
  {
    type: 'tool_start',
    toolUse: {
      id: 'tool-read-1',
      name: 'Read',
      input: {
        file_path: 'G:\\workspace-code\\projects\\cursor-ui-clone\\src\\components\\AIChat\\ChatMessage.tsx'
      }
    }
  },

  // 工具完成
  {
    type: 'tool_result',
    toolResult: {
      id: 'tool-read-1',
      name: 'Read',
      success: true,
      output: 'import React from "react";\n// ... 文件内容 ...'
    }
  },

  // 工具出错
  {
    type: 'tool_result',
    toolResult: {
      id: 'tool-read-2',
      name: 'Read',
      success: false,
      error: 'File not found: /invalid/path'
    }
  }
]

// ============================================================================
// 3. 完整的消息流示例
// ============================================================================

const completeMessageFlow = [
  // 用户消息
  {
    type: 'message_start',
    role: 'user'
  },

  // AI 开始思考
  {
    type: 'thinking_delta',
    text: '分析需求...'
  },

  {
    type: 'thinking_delta',
    text: '\n需要读取文件来理解当前实现'
  },

  // 调用工具
  {
    type: 'tool_start',
    toolUse: {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'src/components/AIChat/ChatMessage.tsx' }
    }
  },

  // 工具结果
  {
    type: 'tool_result',
    toolResult: {
      id: 'tool-1',
      name: 'Read',
      success: true,
      output: '// 文件内容...'
    }
  },

  // AI 继续思考
  {
    type: 'thinking_delta',
    text: '\n现在我理解了结构，开始实现优化...'
  },

  // AI 生成响应
  {
    type: 'text_delta',
    text: '我已经分析了代码。'
  },

  {
    type: 'text_delta',
    text: '主要改进包括：\n1. 添加思考链显示\n2. 增强工具卡片'
  },

  // 消息完成
  {
    type: 'message_stop'
  }
]

// ============================================================================
// 4. 前端接收和处理示例
// ============================================================================

/**
 * 前端会自动处理这些事件，更新 UI：
 *
 * 1. thinking_delta 事件：
 *    - 累积思考内容到 message.thinking
 *    - 设置 message.isThinking = true
 *    - ThinkingBlock 组件自动展示
 *
 * 2. tool_start 事件：
 *    - 创建新的 ToolUseDisplay
 *    - 状态设为 'running'
 *    - ToolUseCard 显示运行状态
 *
 * 3. tool_result 事件：
 *    - 更新对应工具的状态为 'completed' 或 'error'
 *    - 填充 result 或 error 字段
 *    - ToolUseCard 显示结果
 *
 * 4. text_delta 事件：
 *    - 累积文本到 message.content
 *    - Markdown 渲染器自动处理
 *
 * 5. message_stop 事件：
 *    - 设置 message.isStreaming = false
 *    - 设置 message.isThinking = false
 *    - 完成消息流
 */

// ============================================================================
// 5. UI 组件层级
// ============================================================================

/**
 * ChatMessage
 * ├── ThinkingBlock (如果有 message.thinking)
 * │   └── 可折叠的思考内容
 * ├── Markdown 内容
 * ├── ToolUseCard[] (如果有 message.toolUses)
 * │   ├── Input 部分 + 复制按钮
 * │   ├── Output 部分 + 复制按钮
 * │   └── Error 部分 + 复制按钮
 * └── AgentBlock[] (如果有 message.subAgents)
 */

// ============================================================================
// 6. 样式和交互
// ============================================================================

/**
 * 思考块 (ThinkingBlock):
 * - 点击头部展开/折叠
 * - 流式更新时显示脉冲动画
 * - 蓝色主题，与 the IDE 风格一致
 *
 * 工具卡片 (ToolUseCard):
 * - 点击头部展开/折叠详情
 * - 每个部分有独立的复制按钮
 * - 复制后显示 ✓ 反馈
 * - 运行/完成/错误状态用不同颜色表示
 * - 代码块可滚动，最大高度 300px
 */

// ============================================================================
// 7. 类型定义参考
// ============================================================================

/**
 * ChatMessage 类型：
 * {
 *   id: string
 *   role: 'user' | 'assistant'
 *   content: string
 *   timestamp: number
 *   isStreaming?: boolean
 *   thinking?: string              // 新增：思考内容
 *   isThinking?: boolean           // 新增：是否正在思考
 *   toolUses?: ToolUseDisplay[]
 *   subAgents?: SubAgentDisplay[]
 *   codeBlocks?: CodeBlock[]
 *   referencedFiles?: string[]
 * }
 *
 * ToolUseDisplay 类型：
 * {
 *   id: string
 *   name: string
 *   input: Record<string, unknown>
 *   status: 'running' | 'completed' | 'error'
 *   result?: string
 *   error?: string
 * }
 */

export { completeMessageFlow, thinkingExample, toolCallExample }
