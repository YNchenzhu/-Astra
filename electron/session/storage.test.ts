import { describe, expect, it } from 'vitest'
import { formatSessionForPrompt } from './storage'
import type { SessionNote } from './types'

function makeNote(overrides: Partial<SessionNote> = {}): SessionNote {
  return {
    title: 'Test',
    state: 'active',
    tasks: [],
    files: [],
    errors: [],
    learnings: [],
    worklog: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('formatSessionForPrompt', () => {
  it('marks session notes as derived context that may be stale', () => {
    const text = formatSessionForPrompt(makeNote())
    expect(text).toContain('Derived from tooling/session notes; may be stale')
  })

  it('bounds active tasks and files in prompt context', () => {
    const text = formatSessionForPrompt(
      makeNote({
        tasks: Array.from({ length: 15 }, (_, i) => ({
          description: `task-${i}`,
          status: 'pending',
        })),
        files: Array.from({ length: 45 }, (_, i) => ({
          path: `src/file-${i}.ts`,
          action: 'modified',
        })),
      }),
    )

    expect(text).not.toContain('task-0')
    expect(text).toContain('task-14')
    expect(text).not.toContain('src/file-0.ts')
    expect(text).toContain('src/file-44.ts')
    expect(text).toContain('older item(s) omitted from session context')
  })
})
