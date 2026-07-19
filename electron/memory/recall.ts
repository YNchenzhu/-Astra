/**
 * Keyword-based memory recall.
 * Provider-agnostic — no LLM call required.
 *
 * Scoring: tokenize user message → score each memory on
 *   name match (+3), description match (+2), content match (+1)
 *   × recency multiplier (7d=1.5, 30d=1.2, older=1.0)
 *   + type priority tiebreaker (user=4, project=3, reference=2, feedback=1)
 */

import type { MemoryEntry, MemoryType } from './types'

// ---------------------------------------------------------------------------
// Stopwords
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'it',
  'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
  'what', 'which', 'who', 'whom', 'their', 'our', 'us', 'please',
  // Audit fix F19: `也` previously appeared twice — kept once here.
  '也', '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
  '都', '一', '个', '上', '很', '到', '说', '要', '去', '你',
  '会', '着', '没有', '看', '好', '自己', '这',
])

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))

  return new Set(tokens)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const TYPE_PRIORITY: Record<MemoryType, number> = {
  user: 4,
  project: 3,
  reference: 2,
  feedback: 1,
}

function recencyMultiplier(ageDays: number): number {
  if (ageDays <= 7) return 1.5
  if (ageDays <= 30) return 1.2
  return 1.0
}

function countOccurrences(haystack: string, keyword: string): number {
  let count = 0
  let pos = 0
  const lower = haystack.toLowerCase()
  while ((pos = lower.indexOf(keyword, pos)) !== -1) {
    count++
    pos += keyword.length
  }
  return count
}

function scoreMemory(
  keywords: Set<string>,
  memory: MemoryEntry,
): number {
  let score = 0

  for (const kw of keywords) {
    score += countOccurrences(memory.frontmatter.name, kw) * 3
    score += countOccurrences(memory.frontmatter.description, kw) * 2
    score += countOccurrences(memory.content, kw) * 1
  }

  score *= recencyMultiplier(memory.ageDays)
  score += TYPE_PRIORITY[memory.frontmatter.type] * 0.1

  return score
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recall the top-N most relevant memories for a user message.
 * Returns memories sorted by relevance score (descending).
 */
export function recallMemories(
  userMessage: string,
  allMemories: MemoryEntry[],
  topN: number = 5,
): MemoryEntry[] {
  if (allMemories.length === 0 || !userMessage.trim()) return []

  const enabledMemories = allMemories.filter(
    (m) => m.frontmatter.enabled !== false,
  )

  const keywords = tokenize(userMessage)
  if (keywords.size === 0) return []

  const scored = enabledMemories.map((mem) => ({
    memory: mem,
    score: scoreMemory(keywords, mem),
  }))

  scored.sort((a, b) => b.score - a.score)

  return scored
    .filter((s) => s.score > 0)
    .slice(0, topN)
    .map((s) => s.memory)
}

/**
 * Format recalled memories as a prompt-ready string.
 * Includes staleness warnings for memories older than 1 day.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ''

  const lines: string[] = ['# Project Memory', '']

  const staleNames: string[] = []

  for (const mem of memories) {
    lines.push(`## ${mem.frontmatter.name} [${mem.frontmatter.type}]`)

    const ageText = formatAge(mem.ageDays)
    lines.push(`Updated: ${ageText}`)

    if (mem.isStale) {
      staleNames.push(mem.frontmatter.name)
    }

    lines.push('')
    lines.push(mem.content)
    lines.push('')
  }

  if (staleNames.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push(
      `Note: The following memories may be stale and should be verified against current code: ${staleNames.join(', ')}`,
    )
  }

  return lines.join('\n')
}

function formatAge(ageDays: number): string {
  if (ageDays === 0) return 'today'
  if (ageDays === 1) return 'yesterday'
  return `${ageDays} days ago`
}
