import { estimateMessageTokens, estimateTextTokens } from './tokenCounter'

export type ContextBreakdownCategoryId =
  | 'system_prompt'
  | 'tool_schemas'
  | 'memory'
  | 'skills'
  | 'lsp'
  | 'session'
  | 'environment'
  | 'retrieval'
  | 'tool_results'
  | 'thinking'
  | 'conversation'
  | 'reconciled_total'

export interface ContextBreakdownCategory {
  id: ContextBreakdownCategoryId
  label: string
  tokens: number
  percentOfTotal: number
}

export interface ContextBreakdown {
  totalTokens: number
  heuristicTokens: number
  generatedAt: number
  accuracy: 'heuristic' | 'anchored'
  cache?: ContextBreakdownCache
  categories: ContextBreakdownCategory[]
}

export interface ContextBreakdownCache {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  cacheHitRate: number
}

type MutableCategory = {
  id: ContextBreakdownCategoryId
  label: string
  tokens: number
}

const LABELS: Record<ContextBreakdownCategoryId, string> = {
  system_prompt: 'System prompt',
  tool_schemas: 'Tool schemas',
  memory: 'Memory',
  skills: 'Skills',
  lsp: 'LSP diagnostics',
  session: 'Session context',
  environment: 'Environment',
  retrieval: 'Retrieved context',
  tool_results: 'Tool results',
  thinking: 'Thinking history',
  conversation: 'Conversation',
  reconciled_total: 'Server/anchor adjustment',
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
      if (block.type === 'thinking') return typeof block.thinking === 'string' ? block.thinking : ''
      if (block.type === 'redacted_thinking') return typeof block.data === 'string' ? block.data : ''
      if (block.type === 'tool_result') {
        const c = block.content
        return typeof c === 'string' ? c : JSON.stringify(c ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function add(map: Map<ContextBreakdownCategoryId, MutableCategory>, id: ContextBreakdownCategoryId, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const cur = map.get(id)
  if (cur) {
    cur.tokens += Math.ceil(tokens)
    return
  }
  map.set(id, { id, label: LABELS[id], tokens: Math.ceil(tokens) })
}

function usageNum(usage: Record<string, unknown> | undefined, key: string): number {
  const v = usage?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

function buildCacheBreakdown(usage: Record<string, unknown> | undefined): ContextBreakdownCache | undefined {
  if (!usage) return undefined
  const inputTokens = usageNum(usage, 'input_tokens')
  const outputTokens = usageNum(usage, 'output_tokens')
  const cacheCreationInputTokens = usageNum(usage, 'cache_creation_input_tokens')
  const cacheReadInputTokens = usageNum(usage, 'cache_read_input_tokens')
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens
  const totalInput = inputTokens + cachedInputTokens
  if (totalInput <= 0 && outputTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cachedInputTokens,
    cacheHitRate: totalInput > 0 ? (cacheReadInputTokens / totalInput) * 100 : 0,
  }
}

function tagTokens(text: string, tagName: string): number {
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi')
  let total = 0
  for (const match of text.matchAll(re)) {
    total += estimateTextTokens(match[0])
  }
  return total
}

function environmentTokens(text: string): number {
  const marker = '# Environment'
  const idx = text.indexOf(marker)
  if (idx < 0) return 0
  const rest = text.slice(idx)
  const next = rest.search(/\n# (?!Environment\b)/u)
  const block = next > 0 ? rest.slice(0, next) : rest
  return estimateTextTokens(block)
}

function skillIndexTokens(text: string): number {
  const marker = '# Skill index (compact)'
  const idx = text.indexOf(marker)
  if (idx < 0) return 0
  const rest = text.slice(idx)
  const next = rest.search(/\n# (?!Skill index \(compact\)\b)/u)
  const block = next > 0 ? rest.slice(0, next) : rest
  return estimateTextTokens(block)
}

function classifyMessageText(
  map: Map<ContextBreakdownCategoryId, MutableCategory>,
  role: string,
  text: string,
): number {
  let classified = 0
  const memory = tagTokens(text, 'memory-capabilities') + tagTokens(text, 'project-memory')
  const lsp = tagTokens(text, 'lsp-passive-diagnostics')
  const session = tagTokens(text, 'session-context')
  const retrieval = tagTokens(text, 'retrieved-workspace-context') + tagTokens(text, 'retrieved-attachments')
  const env = environmentTokens(text)
  const skills = skillIndexTokens(text)

  add(map, 'memory', memory)
  add(map, 'lsp', lsp)
  add(map, 'session', session)
  add(map, 'retrieval', retrieval)
  add(map, 'environment', env)
  add(map, 'skills', skills)
  classified += memory + lsp + session + retrieval + env + skills

  const total = estimateTextTokens(text)
  const remainder = Math.max(0, total - classified)
  add(map, role === 'assistant' ? 'conversation' : 'conversation', remainder)
  return total
}

function classifyMessage(
  map: Map<ContextBreakdownCategoryId, MutableCategory>,
  message: Record<string, unknown>,
): number {
  const role = typeof message.role === 'string' ? message.role : ''
  const content = message.content
  let total = 0
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') {
        const tokens = estimateMessageTokens({ role, content: [block] })
        add(map, 'tool_results', tokens)
        total += tokens
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const tokens = estimateMessageTokens({ role, content: [block] })
        add(map, 'thinking', tokens)
        total += tokens
      } else if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        total += classifyMessageText(map, role, text)
      } else {
        const tokens = estimateMessageTokens({ role, content: [block] })
        add(map, 'conversation', tokens)
        total += tokens
      }
    }
    return total
  }
  const text = textOfContent(content)
  if (text) return classifyMessageText(map, role, text)
  return 0
}

export function buildContextBreakdown(params: {
  apiMessages: Array<Record<string, unknown>>
  systemPrompt: string
  toolTokens: number
  totalTokens: number
  anchored: boolean
  usageSnapshot?: Record<string, unknown>
}): ContextBreakdown {
  const map = new Map<ContextBreakdownCategoryId, MutableCategory>()
  add(map, 'system_prompt', estimateTextTokens(params.systemPrompt))
  add(map, 'tool_schemas', params.toolTokens)

  let heuristicTokens = estimateTextTokens(params.systemPrompt) + Math.max(0, params.toolTokens)
  for (const message of params.apiMessages) {
    heuristicTokens += classifyMessage(map, message)
  }

  const totalTokens = Math.max(0, Math.ceil(params.totalTokens))
  const delta = totalTokens - heuristicTokens
  // Only surface positive reconciliation. A negative delta means the
  // heuristic over-estimated (one of the per-category estimators counted
  // more than the server actually billed); we cannot say which category
  // was high, and `add()` rejects negatives anyway. Silently dropping the
  // negative branch keeps the per-category sum ≤ totalTokens so the
  // renderer's percentage bars never exceed 100%.
  if (delta > 0) {
    add(map, 'reconciled_total', delta)
  }

  const categories = [...map.values()]
    .filter((cat) => cat.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((cat) => ({
      ...cat,
      percentOfTotal: totalTokens > 0 ? (cat.tokens / totalTokens) * 100 : 0,
    }))

  return {
    totalTokens,
    heuristicTokens,
    generatedAt: Date.now(),
    accuracy: params.anchored ? 'anchored' : 'heuristic',
    cache: buildCacheBreakdown(params.usageSnapshot),
    categories,
  }
}
