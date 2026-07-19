import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildUserRulesPromptFromStorage, CLAUDE_RULES_STORAGE_KEY, type StoredRule } from './userRulesPrompt'
import { ENABLED_PRESETS_KEY } from './rulePresets'

function makeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

function stubWindow(ls: Storage) {
  vi.stubGlobal('window', { localStorage: ls })
}

describe('buildUserRulesPromptFromStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns empty when nothing stored', () => {
    stubWindow(makeLocalStorage())
    expect(buildUserRulesPromptFromStorage()).toBe('')
  })

  it('renders a user rule under "## User rules"', () => {
    const rules: StoredRule[] = [
      { id: 'rule-1', name: 'My Rule', description: 'desc', type: 'user', content: 'be concise' },
    ]
    stubWindow(makeLocalStorage({ [CLAUDE_RULES_STORAGE_KEY]: JSON.stringify(rules) }))
    const out = buildUserRulesPromptFromStorage()
    expect(out).toContain('## User rules')
    expect(out).toContain('### My Rule (desc)')
    expect(out).toContain('be concise')
    expect(out).not.toContain('## Project rules')
  })

  it('separates project rules into their own section', () => {
    const rules: StoredRule[] = [
      { id: 'rule-1', name: 'U', description: '', type: 'user', content: 'u-content' },
      { id: 'rule-2', name: 'P', description: '', type: 'project', content: 'p-content' },
    ]
    stubWindow(makeLocalStorage({ [CLAUDE_RULES_STORAGE_KEY]: JSON.stringify(rules) }))
    const out = buildUserRulesPromptFromStorage()
    expect(out).toContain('## User rules')
    expect(out).toContain('## Project rules')
  })

  it('drops malformed rules (missing/empty content or bad type)', () => {
    const rules = [
      { id: 'good', name: 'G', description: '', type: 'user', content: 'ok' },
      { id: 'no-content', name: 'X', type: 'user', content: '   ' },
      { id: 'bad-type', name: 'Y', type: 'weird', content: 'z' },
    ]
    stubWindow(makeLocalStorage({ [CLAUDE_RULES_STORAGE_KEY]: JSON.stringify(rules) }))
    const out = buildUserRulesPromptFromStorage()
    expect(out).toContain('ok')
    expect(out).not.toContain('bad-type')
    expect(out).not.toContain('no-content')
  })

  it('includes enabled presets and dedupes by id over user rules', () => {
    stubWindow(
      makeLocalStorage({
        [ENABLED_PRESETS_KEY]: JSON.stringify(['preset-user-concise']),
        [CLAUDE_RULES_STORAGE_KEY]: JSON.stringify([
          // same id as preset — preset wins, user copy dropped
          { id: 'preset-user-concise', name: 'Hijacked', type: 'user', content: 'evil' },
        ]),
      }),
    )
    const out = buildUserRulesPromptFromStorage()
    expect(out).toContain('简洁沟通')
    expect(out).not.toContain('evil')
  })

  it('tolerates invalid JSON in storage', () => {
    stubWindow(makeLocalStorage({ [CLAUDE_RULES_STORAGE_KEY]: '{not json' }))
    expect(buildUserRulesPromptFromStorage()).toBe('')
  })

  it('returns empty when window is undefined', () => {
    vi.stubGlobal('window', undefined)
    expect(buildUserRulesPromptFromStorage()).toBe('')
  })
})
