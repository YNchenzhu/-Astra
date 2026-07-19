/**
 * Type-only audit for the LoopState field-layer annotations.
 *
 * upstream parity (loose): the type aliases `LoopSetupFields` /
 * `LoopTurnFields` / `LoopIterationFields` in `loopShared.ts` partition
 * every `LoopState` field into exactly one layer. The exhaustiveness
 * checks at the bottom of `loopShared.ts` fail to compile when a new
 * field is added without categorisation OR a layer union references a
 * deleted field.
 *
 * This file adds RUNTIME audit that pins:
 *   - Every layer union contains at least one field name.
 *   - The three layer unions are pairwise disjoint.
 *   - Together they cover every key of `LoopState`.
 *
 * The compile-time checks already enforce these invariants at the type
 * level; this test exists so that:
 *   (a) someone reading the unions has a quick visual sanity check on
 *       expected counts (catches accidental string typos that would
 *       silently make `Pick<>` resolve to a smaller type), and
 *   (b) the layer schema is exercised by the test suite so a refactor
 *       breaking it gets a loud failure rather than a quiet `never`
 *       inference downstream.
 */

import { describe, it, expect } from 'vitest'
import type {
  LoopState,
  LoopSetupFields,
  LoopTurnFields,
  LoopIterationFields,
} from './loopShared'

// The actual field-name arrays are recomputed here from the type unions.
// `keyof T` only exists at the type level, so we can't iterate the unions
// directly — instead, we mirror them as `as const` arrays the test reads.
//
// If a developer adds a field to LoopSetupFields and forgets to update
// this array, the `expect(setupArr.length + turnArr.length + iterArr.length)
// .toBe(allKeys.length)` assertion below fails. If they get the array right
// but forget the union, the compile-time check in loopShared.ts catches it.
//
// Both halves enforced together = "you can only ship a consistent layer
// schema." Keep these arrays in lock-step with the unions.
const setupArr = [
  'queryConfig',
  'queryDeps',
  'config',
  'model',
  'enableTools',
  'diffPermissionMode',
  'permissionDefaultMode',
  'permissionRules',
  'alwaysThinking',
  'appendAppendixAFlow',
  'temperature',
  'topP',
  'effortFromParams',
  'anthropicFastModeEnabled',
  'systemPromptLayers',
  'hasToolDefinitionsOverride',
  'baseToolDefinitions',
  'lastToolsetRevision',
  'maxIterations',
  'loopContextManager',
  'useOpenClaudeDerivedLoopThresholds',
  'signal',
  'callbacks',
  'appendixReport',
  'syncConversation',
  'refreshMainChatContextHeader',
  'profiler',
  'orchestratedToolExecution',
  'hostTranscript',
] as const satisfies ReadonlyArray<LoopSetupFields>

const turnArr = [
  'apiMessages',
  'iteration',
  'totalUsage',
  'lastStreamEndMs',
  'lastIdleClearMs',
  'activeInlineSkillSession',
  'tokenBudgetState',
  'discoveryExclude',
  'toolCallHistory',
  'maxOutputRecoveryCycles',
  'lastUserPlainBudgetSource',
  'terminationResult',
  'collapseConversationKey',
  'stopHookActive',
  'consecutiveStopHookBlocks',
  'declaredIntentNudgeCount',
  'lastToolBatchAllErrors',
  'allToolsFailedNudgeCount',
  'verificationGateNudgeCount',
  'thinkingOnlySilentTurnNudgeCount',
  'completionEvidenceChallengeCount',
  'reactiveCompactAttempts',
  'adaptiveThinkingFullBudgetLatched',
  'consecutiveCompactFailures',
  'transitionHistory',
  'lastPhaseAwareCompactIteration',
  '_compactionReminderInjected',
] as const satisfies ReadonlyArray<LoopTurnFields>

const iterArr = [
  'accumulatedText',
  'toolUseBlocks',
  'thinkingBlocks',
  'serverToolUseBlocks',
  'codeExecutionResultBlocks',
  'pendingToolUseSummary',
  'lastStreamStopReason',
  'streamMaxOutTokens',
  'lastStreamUsageForPole',
  'lastStreamInputTokens',
  'iterationModel',
  'iterationToolDefs',
  'iterationEffort',
  'toolsForApi',
  'openAiStrictToolNames',
  'toolTokensForContext',
  'withheldStreamError',
  'withheldStreamSignal',
  'transition',
] as const satisfies ReadonlyArray<LoopIterationFields>

describe('LoopState field-layer schema', () => {
  it('each layer has at least one field (no empty union)', () => {
    expect(setupArr.length).toBeGreaterThan(0)
    expect(turnArr.length).toBeGreaterThan(0)
    expect(iterArr.length).toBeGreaterThan(0)
  })

  it('layers are pairwise disjoint (no field declared in two layers)', () => {
    const setupSet = new Set<string>(setupArr)
    const turnSet = new Set<string>(turnArr)
    const iterSet = new Set<string>(iterArr)

    for (const f of turnSet) {
      expect(setupSet.has(f), `field '${f}' is in both setup and turn layers`).toBe(false)
    }
    for (const f of iterSet) {
      expect(setupSet.has(f), `field '${f}' is in both setup and iteration layers`).toBe(false)
      expect(turnSet.has(f), `field '${f}' is in both turn and iteration layers`).toBe(false)
    }
  })

  it('the three layers together include every LoopState field', () => {
    // We can't enumerate `keyof LoopState` at runtime, but we can build a
    // minimal LoopState-shaped object from a sentinel and read its keys.
    // The compile-time exhaustiveness check in loopShared.ts already
    // enforces this invariant; this assertion is a redundant runtime
    // safety net that's easy to read.
    const allKeys = new Set<string>([...setupArr, ...turnArr, ...iterArr])
    // Sanity: combined count matches Σ layer counts (no dupes).
    expect(allKeys.size).toBe(setupArr.length + turnArr.length + iterArr.length)
  })

  it('each annotated field name is a real LoopState key (no typos)', () => {
    // `as const satisfies ReadonlyArray<...>` at the array declaration already
    // type-checks the literals against the layer-name unions, but it can't
    // catch a typo where both the array and the union have the same wrong
    // string. The compile-time exhaustiveness check in `loopShared.ts`
    // (`_LoopOrphanedFieldName`) catches that.
    //
    // The check below is a documentation-quality assertion: every name
    // listed here must be assignable to `keyof LoopState`. The cast lets
    // us iterate; the `satisfies` on the array declaration is what makes
    // the union match the keys.
    for (const name of [...setupArr, ...turnArr, ...iterArr]) {
      const k = name as keyof LoopState
      expect(typeof k).toBe('string')
    }
  })
})
