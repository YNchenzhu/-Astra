/**
 * Mirrors selected renderer localStorage keys to userData for backup / reinstall survival.
 * File always contains every key (empty string = cleared in renderer on hydrate).
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFileAtomic } from '../fs/atomicWrite'

export const RENDERER_MIRROR_KEYS = [
  'custom-agents',
  'claude-rules',
  'claude-rules-enabled-presets',
  'recentProjects',
  'buddy-pos',
] as const

export type RendererMirrorKey = (typeof RENDERER_MIRROR_KEYS)[number]

export function getRendererPrefsPath(userData: string): string {
  return path.join(userData, 'renderer-ui-prefs.json')
}

function emptySnapshot(): Record<RendererMirrorKey, string> {
  return {
    'custom-agents': '',
    'claude-rules': '',
    'claude-rules-enabled-presets': '',
    recentProjects: '',
    'buddy-pos': '',
  }
}

/** Full snapshot for IPC (all keys present). */
export function loadRendererPrefs(userData: string): Record<RendererMirrorKey, string> {
  const out = emptySnapshot()
  const p = getRendererPrefsPath(userData)
  if (!fs.existsSync(p)) return out
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>
    for (const k of RENDERER_MIRROR_KEYS) {
      const v = j[k]
      out[k] = typeof v === 'string' ? v : ''
    }
    return out
  } catch {
    return out
  }
}

export function mergeRendererPrefs(
  userData: string,
  patch: Record<string, string>,
): void {
  const prev = loadRendererPrefs(userData)
  const allowed = new Set<string>(RENDERER_MIRROR_KEYS)
  const next = { ...prev }
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) next[k as RendererMirrorKey] = v
  }
  writeJsonFileAtomic(getRendererPrefsPath(userData), next)
}
