/**
 * 2026-07 contract tightening (审计4 — cc-haha `transitions.ts` parity) —
 * audit tests for the {@link TerminationReason} union.
 *
 * `LoopTransition` has had this guard since 2026-05 (`loopEvents.test.ts`,
 * motivated by the `'continue_after_tools'` dead value that lived in the
 * union for 6 months with zero writers). `TerminationReason` had no
 * equivalent: a reason could be declared, described, and rendered by UI
 * badges while being impossible to produce — or, worse, a writer literal
 * could drift from the union only where a dynamic `createTerminalResult(
 * reason, …)` call laundered the type.
 *
 * Three kinds of coverage, mirroring the cc-haha compile-time contract
 * ("every union member MUST stay in sync with the corresponding return
 * site in query.ts"):
 *
 *   1. **No dead values** — scan the production writer sources for
 *      `createTerminalResult('…')` literals, decision-table
 *      `reason: '…'` rows (`iterationDecision.ts`), and the
 *      `loopSignalToTerminationReason` mapping returns (`loopSignal.ts`),
 *      and assert every declared reason has at least one writer.
 *   2. **No typos** — every literal found by the scan must be a declared
 *      union member (the dynamic-call laundering path above).
 *   3. **Locked classification** — the five predicate helpers
 *      (`isErrorTermination` / `isUserAbort` / `isContextOverflow` /
 *      `isHookPrevented` / `isPossiblyIncompleteTermination`) are locked
 *      in an exhaustive expectation matrix so adding a reason forces a
 *      conscious classification decision instead of inheriting silent
 *      predicate defaults (UI badges, retry flows, and telemetry all
 *      branch on these).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KNOWN_TERMINATION_REASONS,
  isErrorTermination,
  isUserAbort,
  isContextOverflow,
  isHookPrevented,
  isPossiblyIncompleteTermination,
  describeTermination,
  createTerminalResult,
  type TerminationReason,
} from './queryTermination'

const HERE = dirname(fileURLToPath(import.meta.url))

// Production sources that own terminal writes. Keep the list explicit —
// same rationale as `loopEvents.test.ts`: a directory-wide scan would
// pick up comments, docs tables, and test fixtures.
const PRODUCTION_WRITER_SOURCES: ReadonlyArray<string> = [
  resolve(HERE, '..', 'orchestration', 'phases', 'iteration.ts'),
  resolve(HERE, '..', 'orchestration', 'phases', 'driveInnerLoop.ts'),
  resolve(HERE, 'agenticLoop', 'noTools.ts'),
  resolve(HERE, 'agenticLoop', 'stream.ts'),
  resolve(HERE, 'agenticLoop', 'preModel.ts'),
  resolve(HERE, 'agenticLoop', 'postModel.ts'),
  resolve(HERE, 'agenticLoop', 'stream', 'reactiveCompactRecovery.ts'),
  resolve(HERE, 'agenticLoop', 'stream', 'withheldSignalPromotion.ts'),
]

// The unified decision table — reasons appear as `reason: 'X'` rows that
// `applyOutcome` later feeds into the dynamic `createTerminalResult(
// outcome.reason, …)` call. This is the canonical writer for
// `blocking_limit` / `aborted_tools` / `hook_stopped` /
// `iteration_boundary_stopped` among others.
const DECISION_TABLE_SOURCE = resolve(HERE, 'agenticLoop', 'iterationDecision.ts')

// `loopSignalToTerminationReason` — the canonical writer chain for
// `image_error` (and one of several for `prompt_too_long` /
// `model_error`): its returns feed `withheldSignalPromotion.ts`'s dynamic
// `createTerminalResult(reason, …)`.
const LOOP_SIGNAL_SOURCE = resolve(HERE, 'loopSignal.ts')

const CREATE_TERMINAL_LITERAL_REGEX = /createTerminalResult\(\s*['"]([a-z_]+)['"]/g
const DECISION_REASON_REGEX = /reason:\s*['"]([a-z_]+)['"]/g
const MAPPER_RETURN_REGEX = /return\s+['"]([a-z_]+)['"]/g

function collect(source: string, regex: RegExp): Set<string> {
  const text = readFileSync(source, 'utf8')
  const found = new Set<string>()
  for (const match of text.matchAll(regex)) {
    found.add(match[1])
  }
  return found
}

function collectAllProductionReasonWrites(): Set<string> {
  const all = new Set<string>()
  for (const source of PRODUCTION_WRITER_SOURCES) {
    for (const v of collect(source, CREATE_TERMINAL_LITERAL_REGEX)) all.add(v)
  }
  for (const v of collect(DECISION_TABLE_SOURCE, DECISION_REASON_REGEX)) all.add(v)
  for (const v of collect(LOOP_SIGNAL_SOURCE, MAPPER_RETURN_REGEX)) all.add(v)
  return all
}

describe('TerminationReason union — production audit', () => {
  it('declares at least one value and has no duplicates', () => {
    expect(KNOWN_TERMINATION_REASONS.length).toBeGreaterThan(0)
    const unique = new Set<string>(KNOWN_TERMINATION_REASONS)
    expect(unique.size).toBe(KNOWN_TERMINATION_REASONS.length)
  })

  it('every declared reason has at least one production writer', () => {
    const writes = collectAllProductionReasonWrites()
    const dead: TerminationReason[] = []
    for (const r of KNOWN_TERMINATION_REASONS) {
      if (!writes.has(r)) dead.push(r)
    }
    expect(
      dead,
      `TerminationReason declares values with no production writer: ${dead.join(', ')}. ` +
        `Either remove from KNOWN_TERMINATION_REASONS (electron/ai/queryTermination.ts) ` +
        `or add a real createTerminalResult('${dead[0] ?? '<value>'}', …) / decision-table row / ` +
        `loopSignal mapping in one of the audited sources.`,
    ).toEqual([])
  })

  it('production writers only emit declared reasons (no typos through the dynamic call)', () => {
    const declared = new Set<string>(KNOWN_TERMINATION_REASONS)
    // Decision-table `reason:` rows and loopSignal returns are already
    // TS-typed against the union; the literal `createTerminalResult('X')`
    // calls are too. This scan is the belt to that suspenders: it catches
    // a writer that circumvents the type (e.g. `as TerminationReason`).
    const undeclared: Array<{ source: string; value: string }> = []
    for (const source of PRODUCTION_WRITER_SOURCES) {
      for (const v of collect(source, CREATE_TERMINAL_LITERAL_REGEX)) {
        if (!declared.has(v)) undeclared.push({ source: source.replace(/.*[\\/]/, ''), value: v })
      }
    }
    for (const v of collect(LOOP_SIGNAL_SOURCE, MAPPER_RETURN_REGEX)) {
      if (!declared.has(v)) undeclared.push({ source: 'loopSignal.ts', value: v })
    }
    expect(
      undeclared,
      `Production writers emit termination reasons not declared in KNOWN_TERMINATION_REASONS: ` +
        undeclared.map((u) => `'${u.value}' in ${u.source}`).join(', '),
    ).toEqual([])
  })
})

describe('TerminationReason — locked predicate classification', () => {
  interface ReasonClassification {
    error: boolean
    userAbort: boolean
    contextOverflow: boolean
    hookPrevented: boolean
    possiblyIncomplete: boolean
  }

  /**
   * Keep in sync with the predicate helpers in `queryTermination.ts`.
   * A divergence means someone changed a predicate (or added a reason)
   * without deciding how UI badges / retry flows should treat it.
   */
  const EXPECTED: Record<TerminationReason, ReasonClassification> = {
    blocking_limit: { error: true, userAbort: false, contextOverflow: true, hookPrevented: false, possiblyIncomplete: false },
    aborted_streaming: { error: true, userAbort: true, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    aborted_tools: { error: true, userAbort: true, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    prompt_too_long: { error: true, userAbort: false, contextOverflow: true, hookPrevented: false, possiblyIncomplete: false },
    image_error: { error: true, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    model_error: { error: true, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    stop_hook_prevented: { error: true, userAbort: false, contextOverflow: false, hookPrevented: true, possiblyIncomplete: false },
    hook_stopped: { error: true, userAbort: false, contextOverflow: false, hookPrevented: true, possiblyIncomplete: false },
    stop_hook_circuit_breaker: { error: true, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    iteration_boundary_stopped: { error: true, userAbort: false, contextOverflow: false, hookPrevented: true, possiblyIncomplete: false },
    max_turns: { error: false, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: true },
    iteration_stalled: { error: true, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    output_budget_exhausted: { error: true, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
    verification_required: { error: false, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: true },
    completed: { error: false, userAbort: false, contextOverflow: false, hookPrevented: false, possiblyIncomplete: false },
  }

  for (const r of KNOWN_TERMINATION_REASONS) {
    it(`'${r}' classification is locked`, () => {
      const exp = EXPECTED[r]
      expect(exp, `Missing EXPECTED entry for '${r}' — add a conscious classification row.`).toBeDefined()
      expect(isErrorTermination(r), 'isErrorTermination').toBe(exp.error)
      expect(isUserAbort(r), 'isUserAbort').toBe(exp.userAbort)
      expect(isContextOverflow(r), 'isContextOverflow').toBe(exp.contextOverflow)
      expect(isHookPrevented(r), 'isHookPrevented').toBe(exp.hookPrevented)
      expect(isPossiblyIncompleteTermination(r), 'isPossiblyIncompleteTermination').toBe(exp.possiblyIncomplete)
    })
  }

  it('every declared reason has a non-empty human-readable description', () => {
    for (const r of KNOWN_TERMINATION_REASONS) {
      const described = describeTermination(createTerminalResult(r, { turnCount: 1 }))
      expect(described.trim().length, `empty description for '${r}'`).toBeGreaterThan(0)
    }
  })
})
