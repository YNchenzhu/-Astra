/**
 * upstream §3.5 — parse optional **output** token budget extensions from natural-language user text
 * (`+500k`, `use 2m tokens`, …). Main thread only; amounts are summed and applied once per distinct
 * user-turn text (see {@link extractLastUserTurnPlainText} + caller dedupe).
 */

import {
  getAgentContext,
  patchAgentContextOutputTokenBudgetCeiling,
} from '../agents/agentContext'

/** Sum of additional output-token ceiling implied by `text` (additive). */
export function parsePoleOutputTokenBudgetAdditions(text: string): number {
  if (!text || typeof text !== 'string') return 0
  const s = text
  let sum = 0
  const rePlusK = /(?:^|[\s\n])\+(\d+(?:\.\d+)?)\s*k\b/gi
  const rePlusM = /(?:^|[\s\n])\+(\d+(?:\.\d+)?)\s*m\b/gi
  const reUseK = /\buse\s+(\d+(?:\.\d+)?)\s*k\s*(?:output\s*)?tokens?\b/gi
  const reUseM = /\buse\s+(\d+(?:\.\d+)?)\s*m\s*(?:output\s*)?tokens?\b/gi
  const bump = (m: RegExpExecArray, mult: number) => {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) sum += Math.floor(n * mult)
  }
  for (const re of [rePlusK, reUseK]) {
    let m: RegExpExecArray | null
    const r = new RegExp(re.source, re.flags)
    while ((m = r.exec(s)) != null) bump(m, 1000)
  }
  for (const re of [rePlusM, reUseM]) {
    let m: RegExpExecArray | null
    const r = new RegExp(re.source, re.flags)
    while ((m = r.exec(s)) != null) bump(m, 1_000_000)
  }
  return sum
}

/**
 * Walk from the end of the transcript and return plain text from the last **user** turn
 * (string `content` or concatenated `content[].text`).
 */
export function extractLastUserTurnPlainText(
  messages: Array<Record<string, unknown>>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string' && c.trim()) return c
    if (Array.isArray(c)) {
      const parts: string[] = []
      for (const block of c) {
        if (!block || typeof block !== 'object') continue
        const o = block as Record<string, unknown>
        if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
      }
      const joined = parts.join('\n').trim()
      if (joined.length > 0) return joined
    }
  }
  return null
}

/** Parse `text` and extend main-thread output ceiling (no-op if amount is 0). */
export function applyPoleOutputTokenBudgetFromUserText(text: string): void {
  const add = parsePoleOutputTokenBudgetAdditions(text)
  if (add > 0) patchAgentContextOutputTokenBudgetCeiling(add)
}

/** When ceiling > 0 and output usage ≥ ceiling + compaction extension, return a user-facing reason. */
export function getPoleOutputBudgetBlockMessage(): string | null {
  const ctx = getAgentContext()
  if (!ctx || ctx.agentId !== 'main') return null
  const base = ctx.poleOutputTokenBudgetCeiling ?? 0
  if (base <= 0) return null
  const used = ctx.poleOutputTokenBudgetUsed ?? 0
  const ext = ctx.poleCompactConsumedInputEstimate ?? 0
  const allowed = base + ext
  if (used >= allowed) {
    return `主线程输出令牌预算已用尽（已用 ${used.toLocaleString()} / 上限 ${allowed.toLocaleString()}，其中 ${ext.toLocaleString()} 为压缩带来的额度回补）。请新建会话或调整指令。`
  }
  return null
}
