/**
 * Unit tests for the completion-evidence handshake (row 12f) — tag
 * detection, directive builders, env gates, and the streaming filter
 * that keeps the tag out of the user-visible delta stream.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// N1 fix (2026-07 复审) — the handshake is work-package gated. Mock the
// bundle registry so tests can flip the active work package; the same
// mock feeds `verificationGate.getActiveBundleVerificationPolicy`.
type MockBundle = {
  meta: { id: string }
  executionPolicy?: { verification?: { kind: string } }
}
let mockActiveBundle: MockBundle | undefined
vi.mock('../../agents/bundles/bundleRegistryQueries', () => ({
  getActiveBundle: () => mockActiveBundle,
  getActiveBundleId: () => mockActiveBundle?.meta.id,
}))

import {
  COMPLETE_EVIDENCE_CLOSE,
  COMPLETE_EVIDENCE_OPEN,
  COMPLETION_EVIDENCE_GATE_MARKER,
  COMPLETION_EVIDENCE_REMINDER_MARKER,
  buildCompletionEvidenceDirective,
  buildCompletionEvidenceReminderText,
  classifyCompletionEvidenceOutcome,
  completionEvidenceChallengeCap,
  completionEvidenceHandshakeApplies,
  createCompleteEvidenceStreamFilter,
  hasCompleteEvidenceTag,
  isCompletionEvidenceGateEnabled,
  withEphemeralCompletionEvidenceReminder,
} from './completionEvidenceGate'

const TAG = `${COMPLETE_EVIDENCE_OPEN}fixed the bug; tests pass${COMPLETE_EVIDENCE_CLOSE}`

afterEach(() => {
  delete process.env.POLE_COMPLETION_EVIDENCE_GATE
  delete process.env.POLE_COMPLETION_EVIDENCE_MAX_CHALLENGES
  mockActiveBundle = undefined
})

describe('hasCompleteEvidenceTag', () => {
  it('detects a well-formed tag', () => {
    expect(hasCompleteEvidenceTag(`All done.\n\n${TAG}`)).toBe(true)
  })

  it('accepts an unclosed tag (truncated stream still counts as a submission)', () => {
    expect(hasCompleteEvidenceTag(`Done. ${COMPLETE_EVIDENCE_OPEN}fixed it`)).toBe(true)
  })

  it('rejects text without the tag', () => {
    expect(hasCompleteEvidenceTag('All done. I fixed the bug and tests pass.')).toBe(false)
  })

  it('rejects a bare prefix of the opening marker', () => {
    expect(hasCompleteEvidenceTag('Generic text about <complete-evi something')).toBe(false)
  })
})

describe('isCompletionEvidenceGateEnabled / completionEvidenceChallengeCap', () => {
  it('defaults to enabled', () => {
    expect(isCompletionEvidenceGateEnabled()).toBe(true)
  })

  it('POLE_COMPLETION_EVIDENCE_GATE=0 disables', () => {
    process.env.POLE_COMPLETION_EVIDENCE_GATE = '0'
    expect(isCompletionEvidenceGateEnabled()).toBe(false)
  })

  it('cap defaults to 2 and honours the env override', () => {
    expect(completionEvidenceChallengeCap()).toBe(2)
    process.env.POLE_COMPLETION_EVIDENCE_MAX_CHALLENGES = '5'
    expect(completionEvidenceChallengeCap()).toBe(5)
  })

  it('cap falls back to default on garbage / non-positive values', () => {
    process.env.POLE_COMPLETION_EVIDENCE_MAX_CHALLENGES = 'abc'
    expect(completionEvidenceChallengeCap()).toBe(2)
    process.env.POLE_COMPLETION_EVIDENCE_MAX_CHALLENGES = '0'
    expect(completionEvidenceChallengeCap()).toBe(2)
  })
})

// ── 2026-07 复审 N1 fix — work-package gating ─────────────────────────
// Product design: ONLY the built-in code-dev work package (or a bundle
// explicitly declaring `executionPolicy.verification.kind === 'code'`)
// walks the host's internal verification/handshake path; every other
// domain is prompt-driven and owes the host no evidence tag.
describe('completionEvidenceHandshakeApplies (N1)', () => {
  it('applies when no bundle is active (default coding-agent experience)', () => {
    mockActiveBundle = undefined
    expect(completionEvidenceHandshakeApplies()).toBe(true)
  })

  it('applies for the built-in code-dev work package', () => {
    mockActiveBundle = { meta: { id: 'code-dev' } }
    expect(completionEvidenceHandshakeApplies()).toBe(true)
  })

  it('does NOT apply for a non-code work package (prompt-driven domain)', () => {
    mockActiveBundle = { meta: { id: 'legal-writing' } }
    expect(completionEvidenceHandshakeApplies()).toBe(false)
  })

  it('respects an explicit executionPolicy opt-in to code verification', () => {
    mockActiveBundle = {
      meta: { id: 'my-forked-coding-pack' },
      executionPolicy: { verification: { kind: 'code' } },
    }
    expect(completionEvidenceHandshakeApplies()).toBe(true)
  })

  it('respects an explicit non-code executionPolicy (self-review domain)', () => {
    mockActiveBundle = {
      meta: { id: 'writing-pack' },
      executionPolicy: { verification: { kind: 'self-review' } },
    }
    expect(completionEvidenceHandshakeApplies()).toBe(false)
  })
})

// ── M1 (2026-07 会话审计监控) — handshake outcome classifier ────────────
describe('classifyCompletionEvidenceOutcome (M1)', () => {
  const base = {
    enabled: true,
    applies: true,
    isMainChat: true,
    turnUsedTools: true,
    questionTail: false,
    hasTag: false,
    challengeCount: 0,
    cap: 2,
  }

  it('not_applicable when out of scope (disabled / non-code / sub-agent / no tools)', () => {
    expect(classifyCompletionEvidenceOutcome({ ...base, enabled: false })).toBe('not_applicable')
    expect(classifyCompletionEvidenceOutcome({ ...base, applies: false })).toBe('not_applicable')
    expect(classifyCompletionEvidenceOutcome({ ...base, isMainChat: false })).toBe('not_applicable')
    expect(classifyCompletionEvidenceOutcome({ ...base, turnUsedTools: false })).toBe('not_applicable')
  })

  it('in_band_tag is the zero-latency happy path (tag wins over question tail)', () => {
    expect(classifyCompletionEvidenceOutcome({ ...base, hasTag: true })).toBe('in_band_tag')
    expect(
      classifyCompletionEvidenceOutcome({ ...base, hasTag: true, questionTail: true }),
    ).toBe('in_band_tag')
  })

  it('question_tail is exempt', () => {
    expect(classifyCompletionEvidenceOutcome({ ...base, questionTail: true })).toBe('question_tail')
  })

  it('challenge_issued while budget remains; cap_exhausted after', () => {
    expect(classifyCompletionEvidenceOutcome({ ...base, challengeCount: 0 })).toBe('challenge_issued')
    expect(classifyCompletionEvidenceOutcome({ ...base, challengeCount: 1 })).toBe('challenge_issued')
    expect(classifyCompletionEvidenceOutcome({ ...base, challengeCount: 2 })).toBe('cap_exhausted')
  })
})

describe('buildCompletionEvidenceDirective', () => {
  it('first challenge explains the protocol and carries the marker', () => {
    const d = buildCompletionEvidenceDirective(0)
    expect(d).toContain(COMPLETION_EVIDENCE_GATE_MARKER)
    expect(d).toContain(COMPLETE_EVIDENCE_OPEN)
    expect(d).toMatch(/continue it NOW with tool calls/)
  })

  it('repeat challenge is the 请完成你的承诺 push', () => {
    const d = buildCompletionEvidenceDirective(1)
    expect(d).toContain(COMPLETION_EVIDENCE_GATE_MARKER)
    expect(d).toContain('请完成你的承诺')
  })
})

describe('withEphemeralCompletionEvidenceReminder', () => {
  const baseMessages = () => [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'working on it' },
    { role: 'user', content: 'tool results here' },
  ]

  it('appends the reminder into the trailing user message once tools were used', () => {
    const messages = baseMessages()
    const out = withEphemeralCompletionEvidenceReminder(messages, {
      turnUsedTools: true,
    })
    expect(out).not.toBe(messages)
    const tail = out[out.length - 1] as { content: string }
    expect(tail.content).toContain(COMPLETION_EVIDENCE_REMINDER_MARKER)
    expect(tail.content).toContain(COMPLETE_EVIDENCE_OPEN)
    // Ephemeral: the input array and its messages are untouched.
    expect((messages[messages.length - 1] as { content: string }).content).toBe(
      'tool results here',
    )
  })

  it('no-ops before any tool use (pure Q&A pays nothing)', () => {
    const messages = baseMessages()
    expect(
      withEphemeralCompletionEvidenceReminder(messages, { turnUsedTools: false }),
    ).toBe(messages)
  })

  it('no-ops for a non-code work package (prompt-driven domain, N1 fix)', () => {
    mockActiveBundle = { meta: { id: 'legal-writing' } }
    const messages = baseMessages()
    expect(
      withEphemeralCompletionEvidenceReminder(messages, { turnUsedTools: true }),
    ).toBe(messages)
  })

  it('no-ops when the gate is disabled', () => {
    process.env.POLE_COMPLETION_EVIDENCE_GATE = '0'
    const messages = baseMessages()
    expect(
      withEphemeralCompletionEvidenceReminder(messages, { turnUsedTools: true }),
    ).toBe(messages)
  })

  it('reminder text carries the tag protocol and the question exemption', () => {
    const text = buildCompletionEvidenceReminderText()
    expect(text).toContain(COMPLETION_EVIDENCE_REMINDER_MARKER)
    expect(text).toContain(COMPLETE_EVIDENCE_OPEN)
    expect(text).toContain(COMPLETE_EVIDENCE_CLOSE)
    expect(text).toMatch(/question to the user/)
  })
})

describe('createCompleteEvidenceStreamFilter', () => {
  it('passes plain text through untouched', () => {
    const f = createCompleteEvidenceStreamFilter()
    expect(f.push('hello ') + f.push('world') + f.flush()).toBe('hello world')
  })

  it('strips a whole tag arriving in a single chunk', () => {
    const f = createCompleteEvidenceStreamFilter()
    const out = f.push(`Done.\n${TAG}`) + f.flush()
    expect(out).toBe('Done.\n')
  })

  it('strips a tag split across many chunks (marker boundary inside chunks)', () => {
    const f = createCompleteEvidenceStreamFilter()
    let out = ''
    for (const chunk of ['All done', '.\n<comp', 'lete-evid', 'ence>proof he', 're</complete-', 'evidence>']) {
      out += f.push(chunk)
    }
    out += f.flush()
    expect(out).toBe('All done.\n')
  })

  it('releases a held-back false-positive prefix on flush', () => {
    const f = createCompleteEvidenceStreamFilter()
    // Ends with a proper prefix of the opening marker — held back until
    // disambiguated; flush proves it was ordinary text.
    let out = f.push('generics like Map<complete')
    expect(out).toBe('generics like Map') // prefix held
    out += f.flush()
    expect(out).toBe('generics like Map<complete')
  })

  it('disambiguates a false-positive prefix as soon as the next chunk arrives', () => {
    const f = createCompleteEvidenceStreamFilter()
    const out = f.push('a <complete') + f.push('ly normal word') + f.flush()
    expect(out).toBe('a <completely normal word')
  })

  it('drops the suppressed remainder of an unclosed tag on flush', () => {
    const f = createCompleteEvidenceStreamFilter()
    const out =
      f.push(`Done.\n${COMPLETE_EVIDENCE_OPEN}evidence that never closes`) + f.flush()
    expect(out).toBe('Done.\n')
  })

  it('resumes visible text after the closing marker', () => {
    const f = createCompleteEvidenceStreamFilter()
    const out = f.push(`before ${TAG} after`) + f.flush()
    expect(out).toBe('before  after')
  })

  it('handles a closing marker split across chunks while suppressing', () => {
    const f = createCompleteEvidenceStreamFilter()
    let out = ''
    for (const chunk of [`x ${COMPLETE_EVIDENCE_OPEN}proof`, ' more proof</comp', 'lete-evidence> y']) {
      out += f.push(chunk)
    }
    out += f.flush()
    expect(out).toBe('x  y')
  })
})
