import { describe, expect, it } from 'vitest'
import {
  SIDE_CHANNEL_KIND,
  SIDE_CHANNEL_KIND_SPECS,
  detectSideChannelKindFromText,
  isHostSideChannelMessage,
  makeSideChannelUserMessage,
  readSideChannelKind,
  renderSideChannelKindsSystemPromptBlock,
  wrapSideChannelBody,
} from './sideChannelKinds'

describe('sideChannelKinds — registry shape', () => {
  it('every kind id is unique and maps to a spec', () => {
    const ids = Object.values(SIDE_CHANNEL_KIND)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(SIDE_CHANNEL_KIND_SPECS[id]).toBeDefined()
      expect(SIDE_CHANNEL_KIND_SPECS[id].kind).toBe(id)
    }
  })

  it('non-user-meta kinds wire to plain <system-reminder>', () => {
    for (const spec of Object.values(SIDE_CHANNEL_KIND_SPECS)) {
      if (spec.kind === SIDE_CHANNEL_KIND.userMetaContext) continue
      expect(spec.wireOpenTag).toBe('<system-reminder>')
      expect(spec.wireCloseTag).toBe('</system-reminder>')
    }
  })

  it('user-meta kind uses its dedicated attributed opener', () => {
    expect(SIDE_CHANNEL_KIND_SPECS[SIDE_CHANNEL_KIND.userMetaContext].wireOpenTag).toBe(
      '<system-reminder type="user-meta-context">',
    )
  })
})

describe('wrapSideChannelBody', () => {
  it('produces the canonical envelope around the body', () => {
    const out = wrapSideChannelBody(
      SIDE_CHANNEL_KIND.pairingRepair,
      '[Pairing repair] body text here.',
    )
    expect(out).toBe(
      '<system-reminder>\n[Pairing repair] body text here.\n</system-reminder>',
    )
  })

  it('is idempotent for a body already wrapped with the same kind', () => {
    const once = wrapSideChannelBody(
      SIDE_CHANNEL_KIND.stopHookError,
      '[Stop hook reported an error]\nlint failed',
    )
    const twice = wrapSideChannelBody(SIDE_CHANNEL_KIND.stopHookError, once)
    expect(twice).toBe(once)
  })

  it('preserves byte-exact legacy compactSummary emission', () => {
    const body =
      '[Previous conversation was compacted to save context — this block is a host-generated transcript recap, NOT a user statement. ' +
      'Treat the summary as the authoritative record of what was already done in this session: previously read files, edits applied, errors encountered, decisions made, and pending work. ' +
      `Do NOT re-do work that's already listed; if the user's next turn refers to "the file" / "that change" / "what we did", look here first.]\nSummary:\n…`
    const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.compactSummary, body)
    // Legacy shape: `<system-reminder>\n{body}\n</system-reminder>`
    expect(wrapped.startsWith('<system-reminder>\n')).toBe(true)
    expect(wrapped.endsWith('\n</system-reminder>')).toBe(true)
    expect(wrapped.slice('<system-reminder>\n'.length, -'\n</system-reminder>'.length)).toBe(body)
  })
})

describe('makeSideChannelUserMessage', () => {
  it('produces a user-role message tagged with kind + _convertedFromSystem', () => {
    const msg = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.toolPoolDelta,
      '[pole-tool-pool-delta] something changed',
    )
    expect(msg.role).toBe('user')
    expect(msg._convertedFromSystem).toBe(true)
    expect(msg._sideChannelKind).toBe(SIDE_CHANNEL_KIND.toolPoolDelta)
    expect(String(msg.content)).toContain('[pole-tool-pool-delta]')
    expect(String(msg.content).startsWith('<system-reminder>')).toBe(true)
  })

  it('merges caller-supplied extras (e.g. compact boundary flags)', () => {
    const msg = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.compactSummary,
      '[Previous conversation was compacted to save context] X',
      { _type: 'compact_boundary', _compactBoundary: true },
    )
    expect(msg._type).toBe('compact_boundary')
    expect(msg._compactBoundary).toBe(true)
    expect(msg._sideChannelKind).toBe(SIDE_CHANNEL_KIND.compactSummary)
  })
})

describe('detectSideChannelKindFromText', () => {
  it('returns null for genuine user text', () => {
    expect(detectSideChannelKindFromText('hi please read file.ts')).toBeNull()
    expect(detectSideChannelKindFromText('')).toBeNull()
  })

  it('detects pairing repair', () => {
    const text = wrapSideChannelBody(SIDE_CHANNEL_KIND.pairingRepair, '[Pairing repair] x')
    expect(detectSideChannelKindFromText(text)).toBe(SIDE_CHANNEL_KIND.pairingRepair)
  })

  it('detects compact summary by its bracket marker', () => {
    const text = wrapSideChannelBody(
      SIDE_CHANNEL_KIND.compactSummary,
      '[Previous conversation was compacted to save context — body]',
    )
    expect(detectSideChannelKindFromText(text)).toBe(SIDE_CHANNEL_KIND.compactSummary)
  })

  it('detects user-meta-context via the attribute', () => {
    const text = '<system-reminder type="user-meta-context">\nbody\n</system-reminder>'
    expect(detectSideChannelKindFromText(text)).toBe(SIDE_CHANNEL_KIND.userMetaContext)
  })

  it('returns genericConvertedSystem for a plain system-reminder body with no marker', () => {
    const text = '<system-reminder>\nopaque host body without a marker\n</system-reminder>'
    expect(detectSideChannelKindFromText(text)).toBe(SIDE_CHANNEL_KIND.genericConvertedSystem)
  })

  it('does NOT misclassify a compact summary whose body mid-text mentions another marker', () => {
    // Real-world risk: an LLM-generated summary text might legitimately
    // quote phrases like "[Previous tool batch ledger]" as it narrates what
    // happened. The detector must lock to the opening marker, not chase
    // substrings buried inside the body.
    const body =
      '[Previous conversation was compacted to save context — host recap]\nSummary:\n' +
      // pad to push the foreign marker beyond the detection window
      'x'.repeat(400) +
      '\nEarlier the model produced [Previous tool batch ledger — host-generated] entries that wasted turns.'
    const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.compactSummary, body)
    expect(detectSideChannelKindFromText(wrapped)).toBe(SIDE_CHANNEL_KIND.compactSummary)
  })

  it('matches markers anywhere inside the detection window (tight envelopes)', () => {
    const wrapped = wrapSideChannelBody(
      SIDE_CHANNEL_KIND.imageBudgetNote,
      '[Image budget note] 1 earlier image attachment was omitted.',
    )
    expect(detectSideChannelKindFromText(wrapped)).toBe(SIDE_CHANNEL_KIND.imageBudgetNote)
  })
})

describe('isHostSideChannelMessage / readSideChannelKind', () => {
  it('respects typed flag', () => {
    const msg = { role: 'user', content: 'whatever', _sideChannelKind: SIDE_CHANNEL_KIND.imageBudgetNote }
    expect(isHostSideChannelMessage(msg)).toBe(true)
    expect(readSideChannelKind(msg)).toBe(SIDE_CHANNEL_KIND.imageBudgetNote)
  })

  it('detects from body when no flag is set', () => {
    const msg = {
      role: 'user',
      content: wrapSideChannelBody(SIDE_CHANNEL_KIND.imageBudgetNote, '[Image budget note] dropped 2'),
    }
    expect(isHostSideChannelMessage(msg)).toBe(true)
    expect(readSideChannelKind(msg)).toBe(SIDE_CHANNEL_KIND.imageBudgetNote)
  })

  it('returns false for a real user message (no flag, no envelope)', () => {
    const msg = { role: 'user', content: 'please fix the bug' }
    expect(isHostSideChannelMessage(msg)).toBe(false)
    expect(readSideChannelKind(msg)).toBeNull()
  })

  it('does not crack open arrayed user content (e.g. tool_result turns)', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't_1', content: 'ok' }],
    }
    expect(isHostSideChannelMessage(msg)).toBe(false)
  })
})

/**
 * 2026-05 audit regression — when the typed `_sideChannelKind` flag is
 * stripped (e.g. by an upstream `normalizeMessagesForAPI(..., {
 * stripInternalMeta: true })` call or by a transcript loaded from disk
 * after restart), the only remaining identifier is the body's first-
 * line bracket marker. Specs that have `marker: null` cannot be
 * recovered this way and decay to `genericConvertedSystem`. The audit
 * found this caused `staleTodoNudge` / `staleTaskNudge` double-cadence
 * throttling to silently break. The fix paired each "ID-via-body-
 * needed" kind with a real marker; these tests pin that contract so
 * the next person to set a marker back to `null` for a kind that needs
 * it sees a red CI immediately.
 */
describe('readSideChannelKind body-fallback for kinds whose downstream depends on identification', () => {
  // Kinds whose collector or other consumer calls
  // `readSideChannelKind(msg)` against history messages and relies on
  // the equality check `kind === SIDE_CHANNEL_KIND.<this>`. If you add
  // such a consumer for a new kind, add the kind here so the body-
  // fallback contract is verified in CI.
  const IDENTIFIABLE_KINDS = [
    SIDE_CHANNEL_KIND.staleTodoNudge,
    SIDE_CHANNEL_KIND.staleTaskNudge,
  ] as const

  it.each(IDENTIFIABLE_KINDS)(
    'spec for %s carries a non-null marker (typed-flag-free fallback)',
    (kind) => {
      const spec = SIDE_CHANNEL_KIND_SPECS[kind]
      expect(spec).toBeDefined()
      expect(
        spec.marker,
        `kind "${kind}" has a downstream consumer that calls readSideChannelKind() against ` +
          `state.apiMessages history. When the typed flag is missing (resume-from-disk path), ` +
          `the only fallback is the body marker. A null marker here would silently break that ` +
          `consumer's identification — see staleTodoNudge.computeTurnCounts. If this kind no ` +
          `longer needs body-fallback identification, remove it from IDENTIFIABLE_KINDS.`,
      ).not.toBeNull()
      expect(typeof spec.marker).toBe('string')
      expect((spec.marker as string).length).toBeGreaterThan(0)
    },
  )

  it.each(IDENTIFIABLE_KINDS)(
    'detectSideChannelKindFromText recovers %s from a wrapped body (no typed flag)',
    (kind) => {
      const spec = SIDE_CHANNEL_KIND_SPECS[kind]
      // Build a body that begins with the spec's marker, exactly the way
      // the collector emits it. Anything after the marker is irrelevant
      // for detection.
      const body = `${spec.marker}\nsome representative body text`
      const wrapped = wrapSideChannelBody(kind, body)
      expect(detectSideChannelKindFromText(wrapped)).toBe(kind)
    },
  )

  it.each(IDENTIFIABLE_KINDS)(
    'readSideChannelKind falls back to body when typed flag is absent for %s',
    (kind) => {
      const spec = SIDE_CHANNEL_KIND_SPECS[kind]
      const msg = {
        role: 'user',
        // Deliberately NO `_sideChannelKind` / `_convertedFromSystem`
        // flags — simulates a normalize pass with stripInternalMeta=true
        // having gone over this message.
        content: wrapSideChannelBody(kind, `${spec.marker}\nbody`),
      }
      expect(readSideChannelKind(msg)).toBe(kind)
      expect(isHostSideChannelMessage(msg)).toBe(true)
    },
  )
})

/**
 * 2026-05 audit regression — pin the contract that
 * `makeSideChannelUserMessage` writes both the typed flag AND a body
 * whose first line is the spec marker. The two together give us
 * defense-in-depth: typed flag for the in-process case, body marker
 * for the resume-from-disk case. The collector tests
 * (`staleTodoNudge.test.ts` / `staleTaskNudge.test.ts`) cover the
 * in-process case; this test covers what happens when the typed flag
 * is then stripped (e.g. by `normalizeMessagesForAPI`).
 */
describe('round-trip: makeSideChannelUserMessage → strip typed flag → readSideChannelKind', () => {
  it('staleTodoNudge survives typed flag strip when its body begins with the spec marker', () => {
    // Match what `renderTodoListBody` emits — starts with the
    // `[Stale todo reminder]` marker. If the collector ever stops
    // emitting this marker at the head of its body, this test fails
    // and the resume-from-disk identification path silently breaks.
    const msg = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTodoNudge,
      '[Stale todo reminder]\nbody body body',
    )
    // Simulate stripInternalMeta=true having run.
    const stripped: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    }
    expect(readSideChannelKind(stripped)).toBe(SIDE_CHANNEL_KIND.staleTodoNudge)
  })

  it('staleTaskNudge survives typed flag strip when its body begins with the spec marker', () => {
    const msg = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTaskNudge,
      '[Stale task reminder]\nbody body body',
    )
    const stripped: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    }
    expect(readSideChannelKind(stripped)).toBe(SIDE_CHANNEL_KIND.staleTaskNudge)
  })
})

describe('renderSideChannelKindsSystemPromptBlock', () => {
  it('lists every named kind in deterministic order', () => {
    const block = renderSideChannelKindsSystemPromptBlock()
    expect(block).toContain('## Side-channel kinds the host may inject')
    expect(block).toContain('[Pairing repair]')
    expect(block).toContain('[Previous conversation was compacted')
    expect(block).toContain('[Image budget note]')
    expect(block).toContain('user-meta-context')
    // Must not list the catch-all `generic_converted_system` kind — that
    // is an internal classification, not a host contract.
    expect(block).not.toMatch(/generic_converted_system/)

    // Stable order: re-rendering twice gives the exact same string (used
    // for prompt-cache fingerprint stability).
    expect(renderSideChannelKindsSystemPromptBlock()).toBe(block)
  })

  it('excludes deprecated kinds (never emitted anymore)', () => {
    const block = renderSideChannelKindsSystemPromptBlock()
    // `iterationDirective` is retained in the registry for historical
    // transcripts only — declaring it would advertise a signal that will
    // never arrive (2026-07 audit).
    expect(block).not.toContain('wrap-up directive')
  })

  it('splits kinds into action and background attention tiers', () => {
    const block = renderSideChannelKindsSystemPromptBlock()
    const actHeading = block.indexOf('### Events / directives')
    const backgroundHeading = block.indexOf('### Status / reference recaps')
    expect(actHeading).toBeGreaterThan(-1)
    expect(backgroundHeading).toBeGreaterThan(actHeading)
    // Sub-agent terminal notices are actionable; the tool-pool delta is
    // routine bookkeeping — they must land in different tiers.
    const subAgentRow = block.indexOf('[Background sub-agents')
    const toolPoolRow = block.indexOf('[pole-tool-pool-delta]')
    expect(subAgentRow).toBeGreaterThan(actHeading)
    expect(subAgentRow).toBeLessThan(backgroundHeading)
    expect(toolPoolRow).toBeGreaterThan(backgroundHeading)
  })
})
