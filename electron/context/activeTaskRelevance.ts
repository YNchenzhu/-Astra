/**
 * Active-task relevance terms — deterministic input for the tool-result
 * history clamp's relevance-weighted eviction (2026-07 deep-loop uplift,
 * item #10).
 *
 * ## Why
 *
 * `clampToolResultsInMessages` evicts oldest-first, which anti-correlates
 * with task relevance in deep loops: the core files of the task are read
 * EARLY, so their tool_results are the first victims of the global budget
 * sweep — and the model then re-reads them (burning iterations, feeding
 * the read-spin the repetition guard has to catch) or, worse, edits from
 * memory. This module extracts path-like tokens from the CURRENTLY OPEN
 * work items so the clamp can evict unrelated results first and keep
 * task-relevant ones longest.
 *
 * ## Determinism
 *
 * Pure string extraction over the todo list / plan snapshot / objective —
 * no LLM judgement, same philosophy as the compact fact ledger. When no
 * tracked work exists (or nothing in it looks like a path) the term list
 * is empty and the clamp's legacy oldest-first order applies unchanged.
 */

import { getAgentContext } from '../agents/agentContext'
import { getTodos, getTodoObjective } from '../tools/TodoWriteTool'
import { getActivePlanStepsSnapshot } from '../planning/planRuntime'

/** Cap the term list so a pathological todo list stays cheap to match. */
export const MAX_RELEVANCE_TERMS = 24

/** Ignore ultra-short tokens ("a.b") that would match everything. */
const MIN_TERM_LENGTH = 4

/**
 * Path-like tokens: contain a path separator, or look like a filename
 * with an extension (`foo.ts`, `SKILL.md`). Deliberately narrow — plain
 * prose words never qualify, so a writing-task todo ("润色第三章") simply
 * produces no terms and leaves eviction order unchanged.
 */
const PATH_LIKE_RE = /[\w@.-]*[/\\][\w@./\\-]+|\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{1,8}\b/g

/** Extract deduplicated, lowercased path-like terms from free text. */
export function extractPathLikeTerms(texts: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    const matches = text.match(PATH_LIKE_RE)
    if (!matches) continue
    for (const raw of matches) {
      const term = raw.trim().replace(/[),.;:]+$/, '').toLowerCase()
      if (term.length < MIN_TERM_LENGTH) continue
      // A bare version-ish token ("1.2.3") is not a path.
      if (/^\d+(\.\d+)*$/.test(term)) continue
      seen.add(term)
      if (seen.size >= MAX_RELEVANCE_TERMS) return [...seen]
    }
  }
  return [...seen]
}

/**
 * Gather the current agent's open work-item texts and extract relevance
 * terms. Main chat additionally contributes the active plan's open step
 * subjects. Never throws — a state-read failure degrades to `[]` (legacy
 * eviction order), never blocks the pre-model pipeline.
 */
export function collectActiveTaskRelevanceTerms(): string[] {
  try {
    const agentId = getAgentContext()?.agentId ?? 'main'
    const texts: string[] = []

    const objective = getTodoObjective(agentId)
    if (objective) texts.push(objective)

    for (const t of getTodos(agentId)) {
      if (t.status === 'pending' || t.status === 'in_progress') {
        texts.push(t.content)
      }
    }

    if (agentId === 'main') {
      const snapshot = getActivePlanStepsSnapshot()
      if (snapshot) {
        for (const s of snapshot.steps) {
          if (s.status === 'pending' || s.status === 'in_progress') {
            texts.push(s.subject)
          }
        }
      }
    }

    return extractPathLikeTerms(texts)
  } catch {
    return []
  }
}
