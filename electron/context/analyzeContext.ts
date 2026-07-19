/**
 * upstream §19.4 — Context analysis visualization engine.
 *
 * Aggregates all dimensions of context usage into a structured {@link ContextAnalysisData}
 * object with:
 * - Token breakdown by category (system prompt, tools, messages, memory, etc.)
 * - Grid visualization (10×10 for 200k, 20×10 for 1M)
 * - Contextual suggestions (approaching capacity, large tool results, etc.)
 */

import {
  estimateTextTokens,
  estimateConversationTokens,
  estimateToolDefinitionsTokens,
} from './tokenCounter'
import {
  getModelContextWindowTokens,
  getEffectiveContextWindowTokens,
  AUTOCOMPACT_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from './openClaudeParityConstants'

export interface ContextCategory {
  name: string
  tokens: number
  percent: number
  color: string
}

export interface ContextSuggestion {
  type: 'info' | 'warning' | 'error'
  message: string
}

export interface ContextAnalysisData {
  model: string
  contextWindowTokens: number
  effectiveWindowTokens: number
  totalUsedTokens: number
  usagePercent: number
  categories: ContextCategory[]
  grid: string[][]
  suggestions: ContextSuggestion[]
}

const CATEGORY_COLORS: Record<string, string> = {
  system_prompt: '#4A90D9',
  system_tools: '#7B68EE',
  mcp_tools: '#9B59B6',
  memory_files: '#2ECC71',
  skills: '#F39C12',
  messages: '#E74C3C',
  autocompact_buffer: '#95A5A6',
  compact_buffer: '#BDC3C7',
  free_space: '#ECF0F1',
}

function categorizeMessages(messages: Array<Record<string, unknown>>): {
  toolResultTokens: number
  readResultTokens: number
  userTextTokens: number
  assistantTextTokens: number
  thinkingTokens: number
} {
  let toolResultTokens = 0
  let readResultTokens = 0
  let userTextTokens = 0
  let assistantTextTokens = 0
  let thinkingTokens = 0

  for (const msg of messages) {
    const role = msg.role as string
    const content = msg.content

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        const bType = block.type as string
        if (bType === 'tool_result') {
          const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          const est = estimateTextTokens(body)
          const toolName = String(block.tool_use_id ?? '')
          if (toolName.includes('read') || toolName.includes('Read')) {
            readResultTokens += est
          } else {
            toolResultTokens += est
          }
        } else if (bType === 'text') {
          const est = estimateTextTokens(String(block.text ?? ''))
          if (role === 'user') userTextTokens += est
          else assistantTextTokens += est
        } else if (bType === 'thinking' || bType === 'redacted_thinking') {
          thinkingTokens += estimateTextTokens(String(block.thinking ?? block.data ?? ''))
        }
      }
    } else if (typeof content === 'string') {
      const est = estimateTextTokens(content)
      if (role === 'user') userTextTokens += est
      else if (role === 'assistant') assistantTextTokens += est
    }
  }

  return { toolResultTokens, readResultTokens, userTextTokens, assistantTextTokens, thinkingTokens }
}

/**
 * Build a text grid visualization of context usage.
 * 200k models → 10×10 grid (each cell ≈ 2k tokens)
 * 1M models → 20×10 grid (each cell ≈ 5k tokens)
 */
function buildGrid(
  categories: ContextCategory[],
  contextWindowTokens: number,
): string[][] {
  const is1M = contextWindowTokens >= 500_000
  const rows = is1M ? 20 : 10
  const cols = 10
  const totalCells = rows * cols
  const tokensPerCell = contextWindowTokens / totalCells

  const grid: string[][] = []
  let cellIdx = 0

  for (const cat of categories) {
    const cellCount = Math.max(0, Math.round(cat.tokens / tokensPerCell))
    for (let i = 0; i < cellCount && cellIdx < totalCells; i++, cellIdx++) {
      const r = Math.floor(cellIdx / cols)
      const c = cellIdx % cols
      if (!grid[r]) grid[r] = new Array(cols).fill('░')
      grid[r][c] = cat.name.charAt(0).toUpperCase()
    }
  }

  while (cellIdx < totalCells) {
    const r = Math.floor(cellIdx / cols)
    if (!grid[r]) grid[r] = new Array(cols).fill('░')
    cellIdx++
  }

  return grid
}

function generateSuggestions(
  categories: ContextCategory[],
  usagePercent: number,
  // `totalUsed` / `effectiveWindow` are reserved for future suggestion
  // heuristics (e.g. "switch to a larger-window model"); kept in the wire
  // shape via `_`-prefix so callers don't have to drop the numbers yet.
  _totalUsed: number,
  _effectiveWindow: number,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []

  if (usagePercent >= 80) {
    suggestions.push({
      type: 'warning',
      message: `Context usage at ${usagePercent.toFixed(0)}% — approaching capacity. Consider using /compact.`,
    })
  }

  const toolResultCat = categories.find((c) => c.name === 'tool_results')
  if (toolResultCat && toolResultCat.percent > 15 && toolResultCat.tokens > 10_000) {
    suggestions.push({
      type: 'warning',
      message: `Large tool results consuming ${toolResultCat.percent.toFixed(0)}% of context (${toolResultCat.tokens} tokens). Consider more targeted tool calls.`,
    })
  }

  const readCat = categories.find((c) => c.name === 'read_results')
  if (readCat && readCat.percent > 5 && readCat.tokens > 10_000) {
    suggestions.push({
      type: 'info',
      message: `File read results consuming ${readCat.percent.toFixed(0)}% of context. Consider reading specific line ranges.`,
    })
  }

  const memoryCat = categories.find((c) => c.name === 'memory_files')
  if (memoryCat && memoryCat.percent > 5 && memoryCat.tokens > 5_000) {
    suggestions.push({
      type: 'info',
      message: `Memory files consuming ${memoryCat.percent.toFixed(0)}% of context (${memoryCat.tokens} tokens).`,
    })
  }

  if (usagePercent > 50) {
    const autoDisabled = process.env.DISABLE_AUTO_COMPACT === '1'
    if (autoDisabled) {
      suggestions.push({
        type: 'warning',
        message: 'Auto-compact is disabled. Context may overflow without manual /compact.',
      })
    }
  }

  return suggestions
}

/**
 * Analyze current context state and produce a structured report.
 */
export function analyzeContext(input: {
  model: string
  systemPrompt: string
  messages: Array<Record<string, unknown>>
  toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  memoryTokens?: number
  skillTokens?: number
  /** When called from context:analyze-live without active agent, pass cached values. */
  liveEstimatedTokens?: number
  liveLevel?: string
  liveCompactCount?: number
}): ContextAnalysisData {
  const { model, systemPrompt, messages } = input

  const contextWindow = getModelContextWindowTokens(model)
  const effectiveWindow = getEffectiveContextWindowTokens(model)

  const systemPromptTokens = estimateTextTokens(systemPrompt)
  const toolTokens = input.toolDefinitions
    ? estimateToolDefinitionsTokens(input.toolDefinitions)
    : 0

  const msgBreakdown = categorizeMessages(messages)
  const messageTokens = estimateConversationTokens(messages, '')
  const memoryTokens = input.memoryTokens ?? 0
  const skillTokens = input.skillTokens ?? 0

  // Total-used reconciliation: if the caller gave us a `liveEstimatedTokens`
  // from `ContextManager.getState().estimatedTokens`, that's the
  // authoritative number — it already blends Anthropic `countTokens`
  // prefetch, `_poleContextUsage` anchors, and `lastUsageInputTokens`
  // tail estimates. Using it here keeps the UI gauge, agenticLoop
  // thresholds, and `context:analyze` all reading from the same truth
  // (feature audit — unified token truth source). The per-category
  // breakdown below still uses heuristics since those signals aren't
  // decomposable.
  const heuristicTotal =
    systemPromptTokens + toolTokens + messageTokens + memoryTokens + skillTokens
  const totalUsed =
    typeof input.liveEstimatedTokens === 'number' &&
    Number.isFinite(input.liveEstimatedTokens) &&
    input.liveEstimatedTokens > 0
      ? input.liveEstimatedTokens
      : heuristicTotal
  const usagePercent = effectiveWindow > 0 ? (totalUsed / effectiveWindow) * 100 : 0

  const categories: ContextCategory[] = [
    {
      name: 'system_prompt',
      tokens: systemPromptTokens,
      percent: effectiveWindow > 0 ? (systemPromptTokens / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.system_prompt,
    },
    {
      name: 'system_tools',
      tokens: toolTokens,
      percent: effectiveWindow > 0 ? (toolTokens / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.system_tools,
    },
    {
      name: 'memory_files',
      tokens: memoryTokens,
      percent: effectiveWindow > 0 ? (memoryTokens / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.memory_files,
    },
    {
      name: 'skills',
      tokens: skillTokens,
      percent: effectiveWindow > 0 ? (skillTokens / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.skills,
    },
    {
      name: 'tool_results',
      tokens: msgBreakdown.toolResultTokens,
      percent: effectiveWindow > 0 ? (msgBreakdown.toolResultTokens / effectiveWindow) * 100 : 0,
      color: '#E67E22',
    },
    {
      name: 'read_results',
      tokens: msgBreakdown.readResultTokens,
      percent: effectiveWindow > 0 ? (msgBreakdown.readResultTokens / effectiveWindow) * 100 : 0,
      color: '#D35400',
    },
    {
      name: 'messages',
      tokens:
        msgBreakdown.userTextTokens +
        msgBreakdown.assistantTextTokens +
        msgBreakdown.thinkingTokens,
      percent:
        effectiveWindow > 0
          ? ((msgBreakdown.userTextTokens +
              msgBreakdown.assistantTextTokens +
              msgBreakdown.thinkingTokens) /
              effectiveWindow) *
            100
          : 0,
      color: CATEGORY_COLORS.messages,
    },
    {
      name: 'autocompact_buffer',
      tokens: AUTOCOMPACT_BUFFER_TOKENS,
      percent: effectiveWindow > 0 ? (AUTOCOMPACT_BUFFER_TOKENS / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.autocompact_buffer,
    },
    {
      name: 'compact_buffer',
      tokens: MANUAL_COMPACT_BUFFER_TOKENS,
      percent: effectiveWindow > 0 ? (MANUAL_COMPACT_BUFFER_TOKENS / effectiveWindow) * 100 : 0,
      color: CATEGORY_COLORS.compact_buffer,
    },
    {
      name: 'free_space',
      tokens: Math.max(0, effectiveWindow - totalUsed - AUTOCOMPACT_BUFFER_TOKENS - MANUAL_COMPACT_BUFFER_TOKENS),
      percent: 0,
      color: CATEGORY_COLORS.free_space,
    },
  ]

  const freeIdx = categories.findIndex((c) => c.name === 'free_space')
  if (freeIdx >= 0) {
    categories[freeIdx].percent =
      effectiveWindow > 0 ? (categories[freeIdx].tokens / effectiveWindow) * 100 : 0
  }

  const grid = buildGrid(
    categories.filter((c) => c.tokens > 0),
    contextWindow,
  )

  const suggestions = generateSuggestions(categories, usagePercent, totalUsed, effectiveWindow)

  return {
    model,
    contextWindowTokens: contextWindow,
    effectiveWindowTokens: effectiveWindow,
    totalUsedTokens: totalUsed,
    usagePercent: Math.min(100, usagePercent),
    categories,
    grid,
    suggestions,
  }
}

/**
 * Format analysis data as human-readable text for display or logging.
 */
export function formatContextAnalysis(data: ContextAnalysisData): string {
  const lines: string[] = [
    `Context Analysis — ${data.model}`,
    `Window: ${(data.contextWindowTokens / 1000).toFixed(0)}k | Effective: ${(data.effectiveWindowTokens / 1000).toFixed(0)}k | Used: ${(data.totalUsedTokens / 1000).toFixed(0)}k (${data.usagePercent.toFixed(1)}%)`,
    '',
    'Breakdown:',
  ]

  for (const cat of data.categories) {
    if (cat.tokens === 0) continue
    const bar = '█'.repeat(Math.max(1, Math.round(cat.percent / 5)))
    lines.push(
      `  ${cat.name.padEnd(20)} ${(cat.tokens / 1000).toFixed(1).padStart(7)}k ${cat.percent.toFixed(1).padStart(5)}% ${bar}`,
    )
  }

  if (data.grid.length > 0) {
    lines.push('')
    lines.push('Grid:')
    for (const row of data.grid) {
      lines.push(`  ${row.join(' ')}`)
    }
  }

  if (data.suggestions.length > 0) {
    lines.push('')
    lines.push('Suggestions:')
    for (const s of data.suggestions) {
      const prefix = s.type === 'error' ? '✖' : s.type === 'warning' ? '⚠' : 'ℹ'
      lines.push(`  ${prefix} ${s.message}`)
    }
  }

  return lines.join('\n')
}
