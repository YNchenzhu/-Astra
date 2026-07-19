/**
 * CRDT-style merge for skill registries: OR-Map (one entry per skill name) with
 * LWW (last-writer-wins) values using a logical clock:
 *   (sourceRank, mtimeMs, scanOrdinal)
 *
 * - sourceRank: project > user > bundled — matches “project overrides user” intent.
 * - mtimeMs: SKILL.md modification time when resolvedPath exists (concurrent edits on disk).
 * - scanOrdinal: monotonic load order tie-breaker within same rank and mtime.
 *
 * This is not OT/CRDT for skill *body* text; it converges registry membership and
 * which replica wins per skill id without a central coordinator.
 */

import fs from 'node:fs'
import type { SkillDefinition } from './types'

const SOURCE_RANK: Record<SkillDefinition['source'], number> = {
  bundled: 0,
  user: 1,
  project: 2,
}

export type Clock = readonly [sourceRank: number, mtimeMs: number, ordinal: number]

function logicalClock(skill: SkillDefinition, ordinal: number): Clock {
  const rank = SOURCE_RANK[skill.source] ?? 0
  let mtime = 0
  if (skill.resolvedPath) {
    try {
      if (fs.existsSync(skill.resolvedPath)) {
        mtime = fs.statSync(skill.resolvedPath).mtimeMs
      }
    } catch {
      /* ignore */
    }
  }
  return [rank, mtime, ordinal] as const
}

function compareClock(a: Clock, b: Clock): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export function mergeSkillDefinitionsCRDT(
  tagged: Array<{ skill: SkillDefinition; ordinal: number }>,
): SkillDefinition[] {
  const map = new Map<string, { skill: SkillDefinition; clock: Clock }>()
  for (const { skill, ordinal } of tagged) {
    const key = skill.name.toLowerCase()
    const clock = logicalClock(skill, ordinal)
    const prev = map.get(key)
    if (!prev || compareClock(clock, prev.clock) > 0) {
      map.set(key, { skill, clock })
    }
  }
  return [...map.values()]
    .sort((a, b) => a.skill.name.toLowerCase().localeCompare(b.skill.name.toLowerCase()))
    .map((v) => v.skill)
}
