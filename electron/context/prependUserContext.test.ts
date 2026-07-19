/**
 * Stage 10 (audit-fixed) — `prependUserContext` strips stale leading
 * `<system-reminder type="user-meta-context">` messages before
 * prepending the fresh one. The dedup is content-shape based (not flag
 * based) because `_convertedFromSystem` is in `INTERNAL_KEYS` and
 * `stripInternalFields` removes it BEFORE `prependUserContext` runs at
 * the streamHandler call site.
 *
 * Other host-injected `<system-reminder>` blocks (task ledger, compact
 * summaries, sub-agent context updates) use the plain
 * `<system-reminder>` opening tag and must NOT be stripped — only the
 * dedicated `type="user-meta-context"` form gets dedupped here.
 */

import { describe, expect, it } from 'vitest'
import { prependUserContext } from './normalizeMessagesForAPI'

const USER_META_TAG = '<system-reminder type="user-meta-context">'

describe('prependUserContext (Stage 10 audit-fixed — content-shape dedup)', () => {
  it('prepends the fresh user-meta when none exists', () => {
    const out = prependUserContext(
      [{ role: 'user', content: 'real prompt' }],
      'fresh memory + date',
    )
    expect(out).toHaveLength(2)
    const m0 = out[0]!
    expect(m0._convertedFromSystem).toBe(true)
    const text = m0.content as string
    expect(text.startsWith(USER_META_TAG)).toBe(true)
    expect(text).toContain('fresh memory + date')
    expect(out[1]!.content).toBe('real prompt')
  })

  it('strips a single stale leading user-meta-context and prepends the fresh one', () => {
    const out = prependUserContext(
      [
        { role: 'user', content: `${USER_META_TAG}\nstale\n</system-reminder>` },
        { role: 'user', content: 'real prompt' },
      ],
      'fresh',
    )
    expect(out).toHaveLength(2)
    const text = out[0]!.content as string
    expect(text.startsWith(USER_META_TAG)).toBe(true)
    expect(text).toContain('fresh')
    expect(text).not.toContain('stale')
    expect(out[1]!.content).toBe('real prompt')
  })

  it('strips multiple consecutive stale user-meta-context msgs at the head', () => {
    const out = prependUserContext(
      [
        { role: 'user', content: `${USER_META_TAG}\nstale-1\n</system-reminder>` },
        { role: 'user', content: `${USER_META_TAG}\nstale-2\n</system-reminder>` },
        { role: 'user', content: 'real prompt' },
      ],
      'fresh',
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.content).toContain('fresh')
    expect(out[1]!.content).toBe('real prompt')
  })

  it('does NOT strip plain <system-reminder> messages — only user-meta-context shape', () => {
    // Critical invariant: sub-agent injection, compact summaries, and
    // stop-hook error injections all use the plain `<system-reminder>`
    // opening tag (no attribute) — those are NOT user-meta-context and
    // must not be stripped by this function. Only the explicit
    // user-meta-context type is owned by `prependUserContext`.
    const out = prependUserContext(
      [
        { role: 'user', content: '<system-reminder>\n[Stop hook reported an error]\nlint failed\n</system-reminder>' },
        { role: 'user', content: 'real prompt' },
      ],
      'fresh',
    )
    expect(out).toHaveLength(3)
    expect(out[0]!.content).toContain('fresh') // newly prepended
    expect(out[1]!.content).toContain('[Stop hook') // preserved
    expect(out[2]!.content).toBe('real prompt')
  })

  it('does NOT strip a non-leading user-meta (only consecutive head meta msgs are dedupped)', () => {
    // Even a `user-meta-context`-shaped message is left untouched if it
    // is not at the absolute head of the array. The dedup owns ONLY
    // the messages[0] slot.
    const out = prependUserContext(
      [
        { role: 'user', content: 'first real' },
        { role: 'user', content: `${USER_META_TAG}\nmid-stream meta\n</system-reminder>` },
        { role: 'user', content: 'second real' },
      ],
      'fresh',
    )
    expect(out).toHaveLength(4)
    expect(out[0]!.content).toContain('fresh')
    expect(out[1]!.content).toBe('first real')
    expect(out[2]!.content).toContain('mid-stream meta')
    expect(out[3]!.content).toBe('second real')
  })

  it('returns a stripped messages list when fresh user context is empty', () => {
    // Edge: `userContext` empty + stale leading user-meta-context
    // exists → strip the stale one but do NOT prepend a fresh empty
    // one. (Resume semantics: caller should have provided context if
    // they wanted any.)
    const out = prependUserContext(
      [
        { role: 'user', content: `${USER_META_TAG}\nstale\n</system-reminder>` },
        { role: 'user', content: 'real prompt' },
      ],
      '',
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('real prompt')
  })

  it('content shape — fresh meta uses the new opening tag with the type attribute', () => {
    const out = prependUserContext(
      [{ role: 'user', content: 'real' }],
      'body',
    )
    const text = out[0]!.content as string
    expect(text.startsWith(USER_META_TAG)).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('\nbody\n')
  })
})
