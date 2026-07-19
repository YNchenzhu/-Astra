/**
 * Regression tests for TaskRuntimeStore audit fix R7 (2026-05) — alias hygiene
 * on terminal-record recycle.
 *
 * Scenario:
 *   Owner A:  linkAlias('agent-A', 'tool-X')
 *             start('agent-A') → record under 'tool-X', alias 'agent-A → tool-X'
 *             … finishes …
 *             markCompleted('tool-X') → record terminal, alias still present
 *
 *   Owner B:  linkAlias('agent-B', 'tool-X')
 *             start('agent-B') → recycles the terminal record
 *
 * Pre-fix: the old alias 'agent-A → tool-X' survives the recycle, so any
 * stale reader still holding `agentId === 'agent-A'` would dirty-read
 * Owner B's data. Post-fix: terminal-record recycle drops every alias
 * pointing at the canonical key EXCEPT the alias the new owner is
 * currently using.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { taskRuntimeStore } from './TaskRuntimeStore'

const CANONICAL = 'tool-X-r7'
const ALIAS_A = 'agent-A-r7'
const ALIAS_B = 'agent-B-r7'

beforeEach(() => {
  taskRuntimeStore.removeRecord(CANONICAL)
  taskRuntimeStore.removeRecord(ALIAS_A)
  taskRuntimeStore.removeRecord(ALIAS_B)
})

describe('R7 — TaskRuntimeStore alias hygiene on terminal-record recycle', () => {
  it('drops the stale alias from the previous owner when a new owner recycles a terminal record', () => {
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.start(ALIAS_A, 'agent')
    taskRuntimeStore.append(ALIAS_A, 'text', 'owner-A chunk')
    taskRuntimeStore.markCompleted(CANONICAL)

    // The stale alias is still resolvable here (no fix applied yet).
    expect(taskRuntimeStore.get(ALIAS_A)?.status).toBe('completed')

    taskRuntimeStore.linkAlias(ALIAS_B, CANONICAL)
    taskRuntimeStore.start(ALIAS_B, 'agent')

    // After recycle: ALIAS_A is gone (no dirty read into B's record),
    // ALIAS_B points at the fresh record.
    expect(taskRuntimeStore.get(ALIAS_A)).toBeUndefined()
    expect(taskRuntimeStore.get(ALIAS_B)?.status).toBe('running')

    // Reset semantics still hold — no leftover chunks from owner A.
    expect(taskRuntimeStore.get(ALIAS_B)?.chunks).toHaveLength(0)
  })

  it('drops ALL aliases when the recycler used the canonical id directly (no new alias to preserve)', () => {
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.start(ALIAS_A, 'agent')
    taskRuntimeStore.markFailed(CANONICAL, 'boom')

    taskRuntimeStore.start(CANONICAL, 'agent')

    expect(taskRuntimeStore.get(ALIAS_A)).toBeUndefined()
    expect(taskRuntimeStore.get(CANONICAL)?.status).toBe('running')
  })

  it('preserves the new alias when it is the same as the previous one (idempotent re-link)', () => {
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.start(ALIAS_A, 'agent')
    taskRuntimeStore.markCompleted(CANONICAL)

    // Same owner / alias retries the same canonical — the alias is current,
    // must NOT be dropped.
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.start(ALIAS_A, 'agent')

    expect(taskRuntimeStore.get(ALIAS_A)?.status).toBe('running')
  })

  it('leaves aliases alone when recycling a NON-terminal record (caller bug, no paper-over)', () => {
    // This codifies the design decision in the R7 comment: if `existing`
    // is still `running` (e.g. a second `start()` arrived mid-flight), we
    // do NOT drop aliases — a real in-flight reader may still need them,
    // and the double-start itself is the bug the caller should fix.
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.start(ALIAS_A, 'agent')
    expect(taskRuntimeStore.get(CANONICAL)?.status).toBe('running')

    taskRuntimeStore.linkAlias(ALIAS_B, CANONICAL)
    taskRuntimeStore.start(ALIAS_B, 'agent')

    // ALIAS_A is intentionally still alive (the design exits the cleanup
    // path when status is non-terminal).
    expect(taskRuntimeStore.get(ALIAS_A)?.status).toBe('running')
    expect(taskRuntimeStore.get(ALIAS_B)?.status).toBe('running')
  })

  it('removeRecord drops every alias for that canonical regardless of terminal state', () => {
    // Sanity: the original `unlinkAliasesForCanonical` path (called from
    // `removeRecord` / sweep) was already correct; this test guards that
    // R7 did not accidentally narrow its semantics.
    taskRuntimeStore.linkAlias(ALIAS_A, CANONICAL)
    taskRuntimeStore.linkAlias(ALIAS_B, CANONICAL)
    taskRuntimeStore.start(CANONICAL, 'agent')

    taskRuntimeStore.removeRecord(CANONICAL)

    expect(taskRuntimeStore.get(ALIAS_A)).toBeUndefined()
    expect(taskRuntimeStore.get(ALIAS_B)).toBeUndefined()
    expect(taskRuntimeStore.get(CANONICAL)).toBeUndefined()
  })
})
