import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetVerificationGateStateForTests,
  clearAllVerificationGateState,
  clearVerificationGateForConversation,
  getVerificationGateState,
  isInlineVerificationCommand,
  noteInlineVerification,
  noteWorkspaceMutation,
  parseVerdict,
  recordVerificationVerdict,
} from './verificationGateState'

const CONV = 'conv-test-1'

afterEach(() => {
  __resetVerificationGateStateForTests()
})

describe('audit #2 — production clear seams', () => {
  it('clearVerificationGateForConversation drops one conversation', () => {
    noteWorkspaceMutation('conv-a', 3)
    noteWorkspaceMutation('conv-b', 2)
    clearVerificationGateForConversation('conv-a')
    expect(getVerificationGateState('conv-a')).toBeUndefined()
    expect(getVerificationGateState('conv-b')?.mutationCount).toBe(2)
  })

  it('clearAllVerificationGateState drops everything (bundle switch hygiene)', () => {
    noteWorkspaceMutation('conv-a', 3)
    noteWorkspaceMutation('conv-b', 2)
    clearAllVerificationGateState()
    expect(getVerificationGateState('conv-a')).toBeUndefined()
    expect(getVerificationGateState('conv-b')).toBeUndefined()
  })
})

describe('parseVerdict', () => {
  it('returns undefined when no verdict line is present', () => {
    expect(parseVerdict(undefined)).toBeUndefined()
    expect(parseVerdict('')).toBeUndefined()
    expect(parseVerdict('All good, looks fine to me.')).toBeUndefined()
  })

  it('parses each verdict kind', () => {
    expect(parseVerdict('...\nVERDICT: PASS')).toBe('PASS')
    expect(parseVerdict('VERDICT: FAIL\n')).toBe('FAIL')
    expect(parseVerdict('VERDICT: PARTIAL')).toBe('PARTIAL')
  })

  it('is case-insensitive and tolerates surrounding text', () => {
    expect(parseVerdict('verdict: pass')).toBe('PASS')
  })

  it('does not false-match longer words like PASSED', () => {
    expect(parseVerdict('VERDICT: PASSED the suite')).toBeUndefined()
    expect(parseVerdict('VERDICT: FAILURE')).toBeUndefined()
  })

  it('takes the LAST verdict so an in-body example cannot shadow the terminal one', () => {
    const report = [
      'End with exactly VERDICT: PASS or VERDICT: FAIL.',
      '### Check: build',
      'VERDICT: FAIL',
    ].join('\n')
    expect(parseVerdict(report)).toBe('FAIL')
  })
})

describe('verification gate state lifecycle', () => {
  it('starts with no entry', () => {
    expect(getVerificationGateState(CONV)).toBeUndefined()
  })

  it('noteWorkspaceMutation marks needsVerification and counts edits', () => {
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(true)
    expect(s?.mutationCount).toBe(2)
  })

  it('noteWorkspaceMutation accepts a per-batch edit count', () => {
    noteWorkspaceMutation(CONV, 3)
    noteWorkspaceMutation(CONV, 2)
    expect(getVerificationGateState(CONV)?.mutationCount).toBe(5)
  })

  it('clamps non-positive / non-finite counts to 1', () => {
    noteWorkspaceMutation(CONV, 0)
    noteWorkspaceMutation(CONV, -4)
    noteWorkspaceMutation(CONV, Number.NaN)
    expect(getVerificationGateState(CONV)?.mutationCount).toBe(3)
  })

  it('PASS clears the gate and resets the mutation count', () => {
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    recordVerificationVerdict(CONV, 'PASS', 'VERDICT: PASS')
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(false)
    expect(s?.mutationCount).toBe(0)
    expect(s?.lastVerdict).toBe('PASS')
  })

  it('PARTIAL also clears the gate (environmental limitation, not a failure)', () => {
    noteWorkspaceMutation(CONV)
    recordVerificationVerdict(CONV, 'PARTIAL')
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(false)
    expect(s?.lastVerdict).toBe('PARTIAL')
  })

  it('FAIL keeps the gate pending and stores a clipped report excerpt', () => {
    noteWorkspaceMutation(CONV)
    const longReport = 'x'.repeat(2000) + '\nVERDICT: FAIL'
    recordVerificationVerdict(CONV, 'FAIL', longReport)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(true)
    expect(s?.lastVerdict).toBe('FAIL')
    expect(s?.failDetail).toBeDefined()
    expect((s?.failDetail?.length ?? 0)).toBeLessThanOrEqual(800)
  })

  it('a new mutation after a PASS re-arms the gate', () => {
    noteWorkspaceMutation(CONV)
    recordVerificationVerdict(CONV, 'PASS')
    noteWorkspaceMutation(CONV)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(true)
    expect(s?.mutationCount).toBe(1)
  })

  it('ignores empty conversation ids', () => {
    noteWorkspaceMutation('')
    recordVerificationVerdict('', 'PASS')
    expect(getVerificationGateState('')).toBeUndefined()
  })
})

describe('isInlineVerificationCommand', () => {
  it('matches package-manager verification scripts', () => {
    for (const cmd of [
      'npm test',
      'npm run test',
      'npm run typecheck',
      'npm run lint',
      'npm run build',
      'pnpm test',
      'yarn typecheck',
      'bun run test:e2e',
      'npx vitest run electron/foo.test.ts',
      'npm run build && npm test',
    ]) {
      expect(isInlineVerificationCommand(cmd)).toBe(true)
    }
  })

  it('matches standalone test / toolchain runners', () => {
    for (const cmd of [
      'vitest run',
      'jest --ci',
      'pytest -q',
      'python -m pytest',
      'tsc -b',
      'npx tsc -b tsconfig.app.json',
      'eslint .',
      'go test ./...',
      'cargo test',
      'make check',
      'npx playwright test',
    ]) {
      expect(isInlineVerificationCommand(cmd)).toBe(true)
    }
  })

  it('does NOT match unrelated shell work', () => {
    for (const cmd of [
      'git status',
      'npm install',
      'npm ci',
      'npm run dev',
      'ls -la',
      'cat package.json',
      'echo build',
      '',
      undefined,
    ]) {
      expect(isInlineVerificationCommand(cmd)).toBe(false)
    }
  })
})

describe('noteInlineVerification', () => {
  it('clears an armed gate the same way a PASS verdict does', () => {
    noteWorkspaceMutation(CONV, 3)
    expect(getVerificationGateState(CONV)?.needsVerification).toBe(true)
    noteInlineVerification(CONV)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(false)
    expect(s?.mutationCount).toBe(0)
    expect(s?.lastVerdict).toBe('PASS')
  })

  it('clears a stuck FAIL state and its detail', () => {
    noteWorkspaceMutation(CONV)
    recordVerificationVerdict(CONV, 'FAIL', 'boom\nVERDICT: FAIL')
    noteInlineVerification(CONV)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(false)
    expect(s?.failDetail).toBeUndefined()
  })

  it('is a no-op when the gate was never armed (no phantom entry)', () => {
    noteInlineVerification(CONV)
    expect(getVerificationGateState(CONV)).toBeUndefined()
  })

  it('a new mutation after inline verification re-arms the gate', () => {
    noteWorkspaceMutation(CONV, 3)
    noteInlineVerification(CONV)
    noteWorkspaceMutation(CONV)
    const s = getVerificationGateState(CONV)
    expect(s?.needsVerification).toBe(true)
    expect(s?.mutationCount).toBe(1)
  })

  it('ignores empty conversation ids', () => {
    noteInlineVerification('')
    expect(getVerificationGateState('')).toBeUndefined()
  })
})
