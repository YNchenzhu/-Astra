/**
 * Audit tests for the {@link LoopTransition} union — guards against the
 * regression we hit in 2026-05 where `'continue_after_tools'` lived in
 * the union + documentation for 6 months without a single production
 * writer (upstream parity audit found it; this test prevents it from
 * happening again).
 *
 * Two kinds of coverage:
 *
 *   1. **Exhaustive classification** — every value passes through
 *      {@link isRecoveryTransition}, which is implemented as a TS
 *      exhaustive `switch`. A new union member without an explicit case
 *      fails the compile, but we also lock the classification in a
 *      runtime table so the recovery / non-recovery split stays a
 *      conscious decision rather than a silent default.
 *
 *   2. **No dead values** — scan the phase modules
 *      (`agenticLoop/{setup,stream,noTools}.ts` + the canonical
 *      `orchestration/phases/iteration.ts` after the F2 barrel removal)
 *      for `state.transition = '…'` writes and assert every declared
 *      {@link LoopTransition} value has at least one writer. Dead values
 *      are union members that nobody assigns; they confuse readers and
 *      let telemetry consumers branch on impossible states.
 *
 * Both checks are cheap (string regex over five small files) and run on
 * every push, so a future PR that declares `'cool_new_transition'` but
 * forgets to wire a writer fails CI immediately.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KNOWN_LOOP_TRANSITIONS,
  isRecoveryTransition,
  type LoopTransition,
} from './loopEvents'

const HERE = dirname(fileURLToPath(import.meta.url))

// Phase modules + orchestrator that own the production `state.transition`
// writes. Keep this list small and explicit — broadening the scope to a
// whole directory would re-introduce the noise (comments / test fixtures /
// audit table) that the regex was trying to filter out.
const PRODUCTION_WRITER_SOURCES: ReadonlyArray<string> = [
  // F2 follow-up: `agenticLoop.ts` barrel was deleted; the canonical home
  // for `runAgenticIteration` (and its `state.transition` writes) is now
  // `electron/orchestration/phases/iteration.ts`.
  resolve(HERE, '..', 'orchestration', 'phases', 'iteration.ts'),
  resolve(HERE, 'agenticLoop', 'setup.ts'),
  resolve(HERE, 'agenticLoop', 'stream.ts'),
  resolve(HERE, 'agenticLoop', 'noTools.ts'),
  // P1 (2026-05): `decideIterationOutcome` is the canonical authority
  // for `transition` values that the loop body now applies via
  // `applyOutcome`. The string literals live as `transition: 'X'` in
  // the returned `IterationOutcome` shape, which the audit regex picks
  // up via its object-literal branch.
  resolve(HERE, 'agenticLoop', 'iterationDecision.ts'),
  // P2 (2026-05): stream-phase recovery paths extracted into focused
  // modules. Each still writes `state.transition = 'X'` so the loop's
  // transitionHistory captures the path taken.
  resolve(HERE, 'agenticLoop', 'stream', 'reactiveCompactRecovery.ts'),
  resolve(HERE, 'agenticLoop', 'stream', 'stripImageRetry.ts'),
  // P0-3 audit Bug-5 fix — owns the `collapse_drain` writer site; without
  // it `collapse_drain` shows up as a dead union value in the writer audit.
  resolve(HERE, 'agenticLoop', 'stream', 'recoverFromContext.ts'),
]

/**
 * Match `state.transition = 'value'`, the P2-4 canonical writer
 * `recordTransition(state, 'value')`, or `transition: 'value'` in object
 * literals built by `setup.ts` / `agenticLoopAsync.ts`. Captures the
 * literal so we can build an inventory of writers per value.
 *
 * Why not just `transition: '...'`? That would match the AppendixA
 * payload field too. Restricting to the three shapes above avoids those
 * false positives.
 */
const TRANSITION_WRITER_REGEX =
  /(?:state\.transition\s*=\s*|recordTransition\(\s*state,\s*|^\s*transition\s*:\s*)['"]([a-z_]+)['"]/gm

function collectTransitionWritesFromSource(source: string): Set<string> {
  const text = readFileSync(source, 'utf8')
  const found = new Set<string>()
  for (const match of text.matchAll(TRANSITION_WRITER_REGEX)) {
    found.add(match[1])
  }
  return found
}

describe('LoopTransition union — production audit', () => {
  it('declares at least one value', () => {
    expect(KNOWN_LOOP_TRANSITIONS.length).toBeGreaterThan(0)
  })

  it('has no duplicates', () => {
    const unique = new Set<string>(KNOWN_LOOP_TRANSITIONS)
    expect(unique.size).toBe(KNOWN_LOOP_TRANSITIONS.length)
  })

  // upstream parity guard — the regression that motivated this test.
  // 'continue_after_tools' was declared in the union but never written
  // by any phase module. Removed in the audit; the literal name lives on
  // here so a future re-introduction is caught immediately.
  it('does NOT contain the historical dead value', () => {
    expect((KNOWN_LOOP_TRANSITIONS as ReadonlyArray<string>)).not.toContain(
      'continue_after_tools',
    )
  })

  it('every declared transition has at least one production writer', () => {
    const allWrites = new Set<string>()
    for (const source of PRODUCTION_WRITER_SOURCES) {
      for (const v of collectTransitionWritesFromSource(source)) {
        allWrites.add(v)
      }
    }

    const dead: LoopTransition[] = []
    for (const t of KNOWN_LOOP_TRANSITIONS) {
      if (!allWrites.has(t)) dead.push(t)
    }

    expect(
      dead,
      `LoopTransition declares values with no production writer: ${dead.join(', ')}. ` +
        `Either remove from KNOWN_LOOP_TRANSITIONS (electron/ai/loopEvents.ts) ` +
        `or add a real \`state.transition = '${dead[0] ?? '<value>'}'\` assignment in one of: ` +
        PRODUCTION_WRITER_SOURCES.map((s) => s.replace(/.*[\\/]/, '')).join(', '),
    ).toEqual([])
  })

  it('production writers only emit declared values (no typos)', () => {
    const declared = new Set<string>(KNOWN_LOOP_TRANSITIONS)
    const undeclared: Array<{ source: string; value: string }> = []
    for (const source of PRODUCTION_WRITER_SOURCES) {
      for (const v of collectTransitionWritesFromSource(source)) {
        if (!declared.has(v)) {
          undeclared.push({
            source: source.replace(/.*[\\/]/, ''),
            value: v,
          })
        }
      }
    }
    expect(
      undeclared,
      `Phase modules write transition values not declared in KNOWN_LOOP_TRANSITIONS: ` +
        undeclared.map((u) => `'${u.value}' in ${u.source}`).join(', '),
    ).toEqual([])
  })
})

describe('isRecoveryTransition — classification audit', () => {
  /**
   * Locked classification — keep in sync with the switch in
   * {@link isRecoveryTransition}. A divergence here is the same kind of
   * "I added a value but forgot the consequence" bug the dead-value
   * audit catches, just at the classification surface rather than the
   * writer surface.
   */
  const EXPECTED_RECOVERY: Record<LoopTransition, boolean> = {
    init: false,
    tool_use: false,
    no_tool_use_continue: false,
    stop_hook_continue: false,
    reactive_compact: true,
    collapse_drain: true,
    max_output_recovery: true,
    max_output_escalate: true,
    strip_retry: true,
    overload_fallback: true,
  }

  for (const t of KNOWN_LOOP_TRANSITIONS) {
    it(`'${t}' is classified as ${EXPECTED_RECOVERY[t] ? 'recovery' : 'normal advance'}`, () => {
      expect(isRecoveryTransition(t)).toBe(EXPECTED_RECOVERY[t])
    })
  }

  it('every declared transition has an entry in the EXPECTED_RECOVERY table', () => {
    for (const t of KNOWN_LOOP_TRANSITIONS) {
      expect(
        EXPECTED_RECOVERY,
        `Missing classification entry for '${t}' in EXPECTED_RECOVERY. ` +
          `Update both the switch in isRecoveryTransition AND this table.`,
      ).toHaveProperty(t)
    }
  })
})
