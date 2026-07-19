/**
 * Skill hook declarations: optional `hooks.json` next to SKILL.md, or frontmatter `hooks` JSON string.
 *
 * Layout (per skill directory):
 *   SKILL.md
 *   hooks.json   — optional; { "hooks": [ { "event", "command", "matcher?" } ] }
 *
 * Frontmatter (optional, for small setups):
 *   hooks: '[{"event":"PreToolUse","command":"./scripts/check.sh"}]'
 *
 * Commands run with cwd = skill directory so `node scripts/x.js` works.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SkillHookSpec } from './types'
import { HOOK_EVENTS, type HookEvent, type HookExecutionKind } from '../tools/hooks/types'

const EXEC_KINDS = new Set<HookExecutionKind>(['command', 'prompt', 'agent', 'http'])

function isHookEvent(s: string): s is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(s)
}

function normalizeMatcher(raw: unknown): SkillHookSpec['matcher'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const workspacePattern = typeof o.workspacePattern === 'string' ? o.workspacePattern : undefined
  const toolPattern = typeof o.toolPattern === 'string' ? o.toolPattern : undefined
  if (!workspacePattern && !toolPattern) return undefined
  return { workspacePattern, toolPattern }
}

function normalizeOneHook(raw: Record<string, unknown>): SkillHookSpec | null {
  const eventRaw = raw.event
  if (typeof eventRaw !== 'string' || !eventRaw.trim()) {
    return null
  }
  const event = eventRaw.trim()
  if (!isHookEvent(event)) {
    console.warn(`[SkillHooks] Unknown hook event "${event}" — still registering (forward compat)`)
  }

  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : undefined
  const handler = raw.handler
  if (!command && typeof handler !== 'function') {
    console.warn('[SkillHooks] Hook entry missing "command" (and no function handler) — skipped')
    return null
  }

  const ek =
    typeof raw.executionKind === 'string' && EXEC_KINDS.has(raw.executionKind as HookExecutionKind)
      ? (raw.executionKind as HookExecutionKind)
      : undefined

  const spec: SkillHookSpec = {
    event,
    matcher: normalizeMatcher(raw.matcher),
    command,
    async: raw.async === true,
    asyncRewake: raw.asyncRewake === true,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    ...(ek ? { executionKind: ek } : {}),
  }
  if (typeof handler === 'function') {
    spec.handler = handler as SkillHookSpec['handler']
  }
  return spec
}

function normalizeHooksArray(arr: unknown): SkillHookSpec[] {
  if (!Array.isArray(arr)) return []
  const out: SkillHookSpec[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const spec = normalizeOneHook(item as Record<string, unknown>)
    if (spec) out.push(spec)
  }
  return out
}

function hookKey(h: SkillHookSpec): string {
  return `${h.event}:${h.command ?? ''}:${h.matcher?.toolPattern ?? ''}:${h.matcher?.workspacePattern ?? ''}`
}

/** Later lists override earlier entries with the same key. */
export function mergeHookLists(...lists: SkillHookSpec[][]): SkillHookSpec[] {
  const map = new Map<string, SkillHookSpec>()
  for (const list of lists) {
    for (const h of list) {
      map.set(hookKey(h), h)
    }
  }
  return [...map.values()]
}

/** Parse frontmatter `hooks` value: JSON array or `{ "hooks": [...] }`. */
export function parseHooksFromFrontmatterValue(value: unknown): SkillHookSpec[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return normalizeHooksArray(value)
  }
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return normalizeHooksArray(parsed)
    if (parsed && typeof parsed === 'object' && 'hooks' in parsed) {
      return normalizeHooksArray((parsed as { hooks: unknown }).hooks)
    }
  } catch {
    console.warn('[SkillHooks] Invalid JSON in frontmatter `hooks` — ignored')
  }
  return []
}

/** Load hooks.json from a skill directory (if present). */
export function loadHooksJsonFromSkillDir(skillDir: string): SkillHookSpec[] {
  const filePath = path.join(skillDir, 'hooks.json')
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return normalizeHooksArray(parsed)
    if (parsed && typeof parsed === 'object' && 'hooks' in parsed) {
      return normalizeHooksArray((parsed as { hooks: unknown }).hooks)
    }
    console.warn(`[SkillHooks] hooks.json must be an array or { "hooks": [...] }: ${filePath}`)
  } catch (e) {
    console.warn(`[SkillHooks] Failed to parse hooks.json: ${filePath}`, e)
  }
  return []
}
