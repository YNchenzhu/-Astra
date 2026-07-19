/**
 * Rules from Settings → Rules panel, injected into the main-process system prompt.
 *
 * 数据来源（按合并顺序）：
 *  1. localStorage[ENABLED_PRESETS_KEY] —— 已勾选的预设 id 集合 → 从 RULE_PRESETS 取 content
 *  2. localStorage[CLAUDE_RULES_STORAGE_KEY] —— 用户自建规则
 *
 * 预设按 id 去重优先（同 id 时 1 覆盖 2），避免历史遗留的 preset-* 副本和当前预设打架。
 */

import { ENABLED_PRESETS_KEY, RULE_PRESETS, presetToStoredRule } from './rulePresets'

export const CLAUDE_RULES_STORAGE_KEY = 'claude-rules'

export interface StoredRule {
  id: string
  name: string
  description: string
  type: 'user' | 'project'
  content: string
}

function formatOneRule(r: StoredRule): string {
  const title = r.name?.trim() || r.id
  const desc = r.description?.trim() ? ` (${r.description})` : ''
  return `### ${title}${desc}\n${r.content.trim()}`
}

function isStoredRule(item: unknown): item is StoredRule {
  if (!item || typeof item !== 'object') return false
  const r = item as Partial<StoredRule>
  return (
    typeof r.id === 'string' &&
    typeof r.content === 'string' &&
    r.content.trim().length > 0 &&
    (r.type === 'user' || r.type === 'project')
  )
}

function readEnabledPresets(): StoredRule[] {
  try {
    const raw = window.localStorage.getItem(ENABLED_PRESETS_KEY)
    if (!raw) return []
    const ids = JSON.parse(raw) as unknown
    if (!Array.isArray(ids)) return []
    const enabled = new Set(ids.filter((x): x is string => typeof x === 'string'))
    if (enabled.size === 0) return []
    return RULE_PRESETS.filter((p) => enabled.has(p.id)).map(presetToStoredRule)
  } catch {
    return []
  }
}

function readUserRules(): StoredRule[] {
  try {
    const raw = window.localStorage.getItem(CLAUDE_RULES_STORAGE_KEY)
    if (!raw) return []
    const rules = JSON.parse(raw) as unknown
    if (!Array.isArray(rules)) return []
    return rules.filter(isStoredRule)
  } catch {
    return []
  }
}

/**
 * Markdown block for system prompt, or empty string if no rules.
 */
export function buildUserRulesPromptFromStorage(): string {
  if (typeof window === 'undefined' || !window.localStorage) return ''

  const presetRules = readEnabledPresets()
  const userRules = readUserRules()

  if (presetRules.length === 0 && userRules.length === 0) return ''

  const seen = new Set(presetRules.map((r) => r.id))
  const merged: StoredRule[] = [...presetRules]
  for (const r of userRules) {
    if (seen.has(r.id)) continue
    merged.push(r)
    seen.add(r.id)
  }

  const user = merged.filter((r) => r.type === 'user')
  const project = merged.filter((r) => r.type === 'project')

  const parts: string[] = []
  if (user.length > 0) {
    parts.push('## User rules\n\n' + user.map(formatOneRule).join('\n\n'))
  }
  if (project.length > 0) {
    parts.push('## Project rules\n\n' + project.map(formatOneRule).join('\n\n'))
  }

  return parts.join('\n\n')
}
