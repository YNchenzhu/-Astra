/**
 * Sub-agent worker ↔ in-process equivalence — drift-prevention baseline.
 *
 * Background
 * ----------
 * The worker_threads sub-agent path (`subAgentWorkerClient.ts`) ran in a
 * separate V8 context, so a long-form audit (Phase 1B matrix, May 2026)
 * surfaced **five maintained-by-hand contracts** that the worker route had
 * silently broken at some point and the in-process route still upheld:
 *
 *   1. **Disk settings snapshot**  — `readDiskSettings()` inside the worker
 *      returned `{}` because `setDiskSettingsLoader` was never injected
 *      across the V8 boundary. The fix attaches a snapshot to
 *      `SessionInit.diskSettingsSnapshot` and the worker installs it on
 *      init via `setToolWorkerDiskSettingsOverride`.
 *
 *   2. **Reported output text**    — `case 'done'` wrote a placeholder
 *      `Completed: ${reason} (${turnCount} turns)`. Parent agents lost the
 *      actual model report. The fix accumulates `outputText` / `lastFinalText`
 *      from the worker's `LoopEvent` stream and feeds them through the
 *      shared `resolveSubAgentReportedOutputDetail`.
 *
 *   3. **Read-only budget**         — Explore / Plan / Verification agents
 *      had no tool-count / token cap in the worker route. The fix mirrors
 *      the in-process onMessageEnd / onToolStart enforcement and trips
 *      `worker.postMessage({kind:'abort'})` when the cap is hit.
 *
 *   4. **Permission RPC ctx**       — `createToolUseContext` hard-coded
 *      `permissionMode:'default'` / `permissionDefaultMode:'ask'` with no
 *      rules. The fix pipes the caller's `effectiveDiffPermissionMode`,
 *      `permissionDefaultMode`, `permissionRules` through `runSubAgentInWorker`
 *      params and into the ctx factory.
 *
 *   5. **Sidechain transcript**     — Worker route only wrote `start`
 *      (from runner) + (after fix #2/#3) `complete`/`error`. The remaining
 *      `tool_start` / `tool_result` / `iteration` / `text` / `warning` /
 *      `limit` entries were missing, breaking debug + `TaskOutput` views.
 *      The fix appends them at the matching `case 'event'` branches.
 *
 * Why this file
 * -------------
 * These five contracts are EASY TO BREAK with a "harmless" refactor of
 * `subAgentWorkerClient.ts`. Behaviour-level tests would need a worker
 * mock + main-process toolRegistry setup — too heavy for the value, and
 * fragile against unrelated module changes. Instead we follow the same
 * pattern as `subAgentRunner.p1-bugs.test.ts:30-69`:
 *
 *   - Pure-function tests for the two helper modules (`subAgentReadonlyBudget`,
 *     `subAgentOutputResolver`) so anyone changing a budget literal or
 *     output-resolver path notices immediately.
 *   - **Source-as-string** regex assertions on `subAgentWorkerClient.ts`
 *     and `subAgentWorker.ts` for the five axes. Yes, this is brittle
 *     against cosmetic refactors — that brittleness is the **point**.
 *     If you legitimately reshape the wire-up, update the regex; if your
 *     refactor breaks the contract, the test will tell you.
 *
 * This file is the durable answer to the question "did axis N regress?".
 * Run `npx vitest run electron/agents/subAgentWorkerEquivalence.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  READONLY_AGENT_TYPES,
  readonlyToolCallLimit,
  readonlyToolCallWarnAt,
  readonlyTokenBudget,
  shouldAbortReadonlyBudgetAfterMessageEnd,
} from './subAgentReadonlyBudget'
import {
  SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS,
  resolveSubAgentReportedOutput,
  resolveSubAgentReportedOutputDetail,
} from './subAgentOutputResolver'

// ────────────────────────────────────────────────────────────────────────
// Pure-function helpers
// ────────────────────────────────────────────────────────────────────────

describe('subAgentReadonlyBudget (pure helpers)', () => {
  it('READONLY_AGENT_TYPES is exactly Explore / Plan / Verification', () => {
    // Sub-agent equivalence relies on the three names being identical
    // at every call site (runner + worker). A typo or a 4th addition
    // would silently widen / narrow the budget gate.
    expect([...READONLY_AGENT_TYPES].sort()).toEqual(['Explore', 'Plan', 'Verification'])
  })

  it('readonlyToolCallLimit defaults to 120 for non-Verification readonly agents', () => {
    expect(readonlyToolCallLimit('Explore')).toBe(120)
    expect(readonlyToolCallLimit('Plan')).toBe(120)
    // Verification uses env-overridable default; floor is documented as
    // `>= MAX_READONLY_SUBAGENT_TOOL_CALLS`, so test the >= invariant
    // rather than a specific number (env may be set in CI).
    expect(readonlyToolCallLimit('Verification')).toBeGreaterThanOrEqual(120)
  })

  it('readonlyToolCallWarnAt is < limit (so the warning fires before the abort)', () => {
    // If these ever invert by mistake, the readonly warn sidechain entry
    // would only fire AFTER the abort had already happened — defeating
    // the early-warning contract.
    for (const t of ['Explore', 'Plan', 'Verification']) {
      expect(readonlyToolCallWarnAt(t)).toBeLessThan(readonlyToolCallLimit(t))
    }
  })

  it('readonlyTokenBudget defaults to 120_000 for non-Verification readonly agents', () => {
    expect(readonlyTokenBudget('Explore')).toBe(120_000)
    expect(readonlyTokenBudget('Plan')).toBe(120_000)
    expect(readonlyTokenBudget('Verification')).toBeGreaterThanOrEqual(120_000)
  })

  it('shouldAbortReadonlyBudgetAfterMessageEnd preserves the "do not clobber finished report" rule', () => {
    // Tool-free terminal turn with a real report → leave alone.
    expect(
      shouldAbortReadonlyBudgetAfterMessageEnd({
        toolsThisTurn: 0,
        finalText: '## Findings\n- a\n- b',
      }),
    ).toBe(false)
    // Tools still pending or empty final → safe to abort.
    expect(
      shouldAbortReadonlyBudgetAfterMessageEnd({ toolsThisTurn: 1, finalText: '' }),
    ).toBe(true)
    expect(
      shouldAbortReadonlyBudgetAfterMessageEnd({ toolsThisTurn: 0, finalText: '   ' }),
    ).toBe(true)
  })
})

describe('subAgentOutputResolver (pure helper)', () => {
  it('uses lastFinalText when available (preferred source)', () => {
    const out = resolveSubAgentReportedOutput({
      lastFinalText: '## Report\nA',
      outputText: 'lots of accumulated transcript text…',
      reachedMaxIterations: false,
    })
    expect(out).toContain('## Report')
  })

  it('falls back to outputText when lastFinalText is empty', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: '',
      outputText: 'fallback body',
      reachedMaxIterations: false,
    })
    expect(detail.body).toContain('fallback body')
  })

  it('falls back to latestTextOutput when both prior sources are empty', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: '',
      outputText: '',
      latestTextOutput: 'last-ditch text',
      reachedMaxIterations: false,
    })
    expect(detail.body).toContain('last-ditch text')
  })

  it('returns a no-output sentinel when every source is empty', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: '',
      outputText: '',
      reachedMaxIterations: false,
    })
    expect(detail.body).toBe('Agent completed without output.')
    expect(detail.charTruncated).toBe(false)
    expect(detail.originalCharCount).toBe(0)
  })

  it('appends an iteration-limit note when reachedMaxIterations is set', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: 'partial work',
      outputText: '',
      reachedMaxIterations: true,
    })
    expect(detail.body).toContain('partial work')
    expect(detail.body).toContain('iteration limit')
  })

  it('appends the abort reason when aborted', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: 'in-flight findings',
      outputText: '',
      reachedMaxIterations: false,
      aborted: true,
      abortReason: 'Explore token budget exceeded (97000/96000)',
    })
    expect(detail.body).toContain('in-flight findings')
    expect(detail.body).toContain('Explore token budget exceeded')
    expect(detail.body).toContain('content above may be partial')
  })

  it('reports charTruncated when the chosen source exceeds the fallback cap', () => {
    const big = 'x'.repeat(SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS + 100)
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: big,
      outputText: '',
      reachedMaxIterations: false,
    })
    expect(detail.charTruncated).toBe(true)
    expect(detail.originalCharCount).toBe(big.length)
    // The truncated body should be smaller than the input (with the
    // truncation note appended) but still bounded around the cap.
    expect(detail.body.length).toBeLessThanOrEqual(
      SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS + 100, // cap + truncation note
    )
    expect(detail.body).toContain('truncated to last')
  })

  it('does not report charTruncated for in-bounds text', () => {
    const detail = resolveSubAgentReportedOutputDetail({
      lastFinalText: 'short',
      outputText: '',
      reachedMaxIterations: false,
    })
    expect(detail.charTruncated).toBe(false)
    expect(detail.originalCharCount).toBe('short'.length)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Source-as-string drift-prevention for the five worker equivalence axes
// ────────────────────────────────────────────────────────────────────────
//
// These tests intentionally read .ts source files and regex-match the
// contract-bearing lines. They are brittle against innocuous cosmetic
// refactors — and that brittleness is the point. If a refactor invalidates
// a regex, update the regex on the same change; if a refactor invalidates
// the contract, the regex will catch it. See file-level docstring for
// rationale.

function readSrc(name: string): string {
  return fs.readFileSync(path.join(__dirname, name), 'utf-8')
}

describe('Worker vs in-process equivalence (source-as-string)', () => {
  const clientSrc = readSrc('subAgentWorkerClient.ts')
  // The LoopEvent handling (`case 'event'` body) was extracted into
  // subAgentWorkerEventBridge.ts (file-split refactor); assertions about that
  // logic read the bridge source instead.
  const eventBridgeSrc = readSrc('subAgentWorkerEventBridge.ts')
  // The tool RPC + scheduler-admission handlers were extracted into
  // subAgentWorkerRpcBridge.ts.
  const rpcBridgeSrc = readSrc('subAgentWorkerRpcBridge.ts')
  const workerSrc = readSrc('subAgentWorker.ts')
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bridge', 'sessionMessages.ts'),
    'utf-8',
  )

  // ── Axis 1: settings snapshot ──
  it('Axis 1: SessionInitSchema declares diskSettingsSnapshot', () => {
    // z.object strips unknown keys; the field MUST be on the schema or
    // every snapshot the client attaches is silently dropped before the
    // worker sees it.
    expect(bridgeSrc).toMatch(/diskSettingsSnapshot:\s*z\.record/)
  })

  it('Axis 1: subAgentWorkerClient attaches a snapshot at every init', () => {
    expect(clientSrc).toMatch(/diskSettingsSnapshot:\s*readDiskSettings\(\)/)
  })

  it('Axis 1: subAgentWorker installs the snapshot before agentic loop starts', () => {
    expect(workerSrc).toMatch(/setToolWorkerDiskSettingsOverride\(init\.diskSettingsSnapshot/)
  })

  // ── Axis 2: reported output ──
  it("Axis 2: case 'done' uses the shared resolver (not the placeholder)", () => {
    expect(clientSrc).toMatch(/resolveSubAgentReportedOutputDetail\(\{[^}]*lastFinalText/m)
    // Specifically forbid the legacy placeholder shape — anyone who tries
    // to "just stringify the termination reason" will trip this guard.
    expect(clientSrc).not.toMatch(/output:\s*`Completed:\s*\$\{result\.terminationResult\.reason\}/)
  })

  it("Axis 2: case 'fail' also composes output from accumulated text (not just the error message)", () => {
    // The fail path was a second placeholder (`Worker failed: ${error}`)
    // that lost any partial sub-agent report when budget abort tripped.
    expect(clientSrc).not.toMatch(/output:\s*`Worker failed:\s*\$\{typed\.error\}`/)
    // Modern shape pulls in resolveSubAgentReportedOutputDetail too.
    expect(clientSrc).toMatch(/failOutput\s*=\s*resolveSubAgentReportedOutputDetail/)
  })

  it('Axis 2: client accumulates outputText / lastFinalText across LoopEvent stream', () => {
    // Audit 2026-06: the inline accumulation moved into
    // `WorkerOutputAccumulator` (unit-tested directly in
    // `agentResultChain.destructive.test.ts`); the client must feed it
    // every text_delta and close turns at message_end.
    expect(eventBridgeSrc).toMatch(/wctx\.outputAcc\.onTextDelta\(loopEv\.text\)/)
    expect(eventBridgeSrc).toMatch(/wctx\.outputAcc\.onMessageEnd\(\)/)
    // lastFinalText / outputText feed the resolver in the client's `done` branch.
    expect(clientSrc).toMatch(/lastFinalText:\s*wctx\.outputAcc\.lastFinalText/)
    expect(clientSrc).toMatch(/outputText:\s*wctx\.outputAcc\.outputText/)
  })

  it('Axis 2: client rolls back partial deltas on streaming_fallback (duplicate-text guard)', () => {
    // Worker mirror of the in-process `onStreamingFallback` contract —
    // without the rollback, a 529 → non-streaming retry leaves "half old
    // + full new" duplicated text in the result the parent agent reads.
    expect(eventBridgeSrc).toMatch(/loopEv\?\.type\s*===\s*'streaming_fallback'/)
    expect(eventBridgeSrc).toMatch(/wctx\.outputAcc\.onStreamingFallback\(\)/)
    expect(eventBridgeSrc).toMatch(/rollbackToCursor\(effectiveAgentId,\s*wctx\.taskCursorAtTurnStart\)/)
  })

  // ── Axis 3: readonly budget ──
  it('Axis 3: tool-start branch trips budget abort on hard limit', () => {
    expect(eventBridgeSrc).toMatch(
      /wctx\.totalToolUses\s*>=\s*hardLimit[\s\S]*?sendBudgetAbort/m,
    )
  })

  it('Axis 3: message_end branch trips budget abort on token overflow', () => {
    expect(eventBridgeSrc).toMatch(
      /effectiveTokens\s*>=\s*tokenBudget[\s\S]*?sendBudgetAbort/m,
    )
  })

  it('Axis 3: budget abort is idempotent (latched against re-entry)', () => {
    // The `sendBudgetAbort` closure short-circuits when already set;
    // without this, repeated tool_start / message_end events after the
    // first trip would spam abort messages to the worker.
    expect(clientSrc).toMatch(
      /sendBudgetAbort[\s\S]*?if\s*\(wctx\.budgetAbortReason\)\s*return/m,
    )
  })

  // ── Axis 4: permission ctx ──
  it('Axis 4: createToolUseContext threads the rpcPermission* closure values (not hard-coded)', () => {
    // The previous hard-coded shape was
    //   permissionMode: 'default',
    //   permissionDefaultMode: 'ask',
    // Forbid that exact pair on a single call to createToolUseContext.
    const ctxBlock = extractToolExecCtxBlock(rpcBridgeSrc)
    expect(ctxBlock).toMatch(/permissionMode:\s*rpcPermissionMode\s*\?\?\s*'default'/)
    expect(ctxBlock).toMatch(/permissionDefaultMode:\s*rpcPermissionDefaultMode\s*\?\?\s*'ask'/)
    expect(ctxBlock).toMatch(/rpcPermissionRules\s*\?\s*\{\s*permissionRules:\s*rpcPermissionRules\s*\}/)
  })

  it('Axis 4: runSubAgentInWorker accepts the three permission params', () => {
    expect(clientSrc).toMatch(/permissionMode\??:\s*ToolPermissionMode/)
    expect(clientSrc).toMatch(/permissionDefaultMode\??:\s*ToolPermissionDefault/)
    expect(clientSrc).toMatch(/permissionRules\??:\s*ReadonlyArray<PermissionRulePayload>/)
  })

  it('Axis 4: runner caller wires effectiveDiffPermissionMode and parent rules through', () => {
    // The worker dispatch (the `runSubAgentInWorker(...)` caller) was split
    // out of subAgentRunner.ts into subAgentWorkerDispatch.ts.
    const dispatchSrc = readSrc('subAgentWorkerDispatch.ts')
    // Locate the runSubAgentInWorker invocation and bracket-balance to
    // find its closing `)`. `indexOf('})')` is unsafe — the body has a
    // nested `})` from the `subAgentMaxIterations` spread + ternary
    // (`...(... ? { ... } : {})`) which would truncate the slice before
    // the permission fields we appended at the tail.
    const invokeBody = extractBalancedCallBody(
      dispatchSrc,
      'runSubAgentInWorker(',
    )
    expect(invokeBody).toMatch(/permissionMode:\s*effectiveDiffPermissionMode/)
    // The runner currently uses a conditional spread
    //   ...(parentContext?.permissionDefaultMode
    //     ? { permissionDefaultMode: parentContext.permissionDefaultMode }
    //     : {}),
    // so the assigned-value form is `parentContext.permissionDefaultMode`
    // (no optional chain — the spread guard already proved truthy).
    // `\??\.` accepts both shapes in case a future refactor flattens
    // the conditional.
    expect(invokeBody).toMatch(/permissionDefaultMode:\s*parentContext\??\.permissionDefaultMode/)
    expect(invokeBody).toMatch(/permissionRules:\s*parentContext\??\.permissionRules/)
  })

  // ── Axis 5: sidechain transcript ──
  it('Axis 5: tool_start branch writes tool_start sidechain entry', () => {
    expect(eventBridgeSrc).toMatch(
      /loopEv\?\.type\s*===\s*'tool_start'[\s\S]*?appendSubAgentSidechain[\s\S]*?kind:\s*'tool_start'/m,
    )
  })

  it('Axis 5: tool_result branch writes tool_result sidechain entry (new event handler)', () => {
    expect(eventBridgeSrc).toMatch(
      /loopEv\?\.type\s*===\s*'tool_result'[\s\S]*?appendSubAgentSidechain[\s\S]*?kind:\s*'tool_result'/m,
    )
  })

  it('Axis 5: message_end branch writes iteration + text + budget-limit sidechain entries', () => {
    expect(eventBridgeSrc).toMatch(
      /loopEv\?\.type\s*===\s*'message_end'[\s\S]*?kind:\s*'iteration'/m,
    )
    expect(eventBridgeSrc).toMatch(/kind:\s*'text'/)
    // The token-budget limit entry is gated on readonly + overflow.
    expect(eventBridgeSrc).toMatch(/kind:\s*'limit',\s*\n\s*summary:\s*`tokenBudget=/)
  })

  it('Axis 5: readonly tool-cap path writes warning + limit sidechain entries', () => {
    expect(eventBridgeSrc).toMatch(/kind:\s*'warning',\s*\n\s*summary:\s*`toolCount=/)
    expect(eventBridgeSrc).toMatch(/kind:\s*'limit',\s*\n\s*summary:\s*`maxToolCalls=/)
  })

  it("Axis 5: case 'done' / case 'fail' write complete / error sidechain entries", () => {
    expect(clientSrc).toMatch(
      /case 'done':[\s\S]*?appendSubAgentSidechain[\s\S]*?kind:\s*'complete'/m,
    )
    expect(clientSrc).toMatch(
      /case 'fail':[\s\S]*?appendSubAgentSidechain[\s\S]*?kind:\s*'error'/m,
    )
  })
})

// ────────────────────────────────────────────────────────────────────────
// Audit batch SA-3 — worker-path fixes (source-as-string)
// ────────────────────────────────────────────────────────────────────────
//
// Same brittle-on-purpose convention as the five axes above. The worker
// module (`subAgentWorker.ts`) cannot be imported in tests (it throws
// unless loaded as a worker_thread), so its contracts are pinned at the
// source level; the runner-side behaviour is covered by
// `subAgentRunner.sa3.test.ts`.

describe('SA-3 worker-path fixes (source-as-string)', () => {
  const clientSrc = readSrc('subAgentWorkerClient.ts')
  const workerSrc = readSrc('subAgentWorker.ts')
  // Worker dispatch (`useWorker` decision + fallback gating) moved out of
  // subAgentRunner.ts into subAgentWorkerDispatch.ts (file-split refactor).
  const dispatchSrc = readSrc('subAgentWorkerDispatch.ts')
  // LoopEvent handling moved to subAgentWorkerEventBridge.ts.
  const eventBridgeSrc = readSrc('subAgentWorkerEventBridge.ts')
  // Tool RPC + admission handlers moved to subAgentWorkerRpcBridge.ts.
  const rpcBridgeSrc = readSrc('subAgentWorkerRpcBridge.ts')
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bridge', 'sessionMessages.ts'),
    'utf-8',
  )

  // ── Fix 1: local tool execution honours the session abort signal ──
  it('Fix 1: execLocal forwards the session AbortSignal to the executor', () => {
    // The session-level `abortController` (aborted on `{kind:'abort'}`)
    // must reach the executor so in-flight bash / fetch / long reads get
    // cancelled, instead of only the NEXT loop iteration observing it.
    // The signal is captured into `sig` (then forwarded on both the
    // direct and scheduler-drive admission paths).
    expect(workerSrc).toMatch(
      /const sig\s*=\s*abortController\?\.signal\s*\?\?\s*new AbortController\(\)\.signal/,
    )
    expect(workerSrc).toMatch(
      /fn\(input,\s*mergeAbortSignals\(sig,\s*preemptController\.signal\)\)/,
    )
    // Forbid the legacy dummy-signal-only call shape.
    expect(workerSrc).not.toMatch(
      /fn\(input,\s*new AbortController\(\)\.signal\)/,
    )
  })

  it('worker local tools always use fail-closed admission with real input and preemption', () => {
    expect(workerSrc).not.toContain('if (schedulerDriveOn)')
    expect(workerSrc).toMatch(
      /admitLocalToolRpc\(reqId,\s*name,\s*input,\s*isReadOnly\)/,
    )
    expect(workerSrc).toContain("msg.kind === 'admit_abort'")
    expect(rpcBridgeSrc).toMatch(/input:\s*toolInput/)
    expect(rpcBridgeSrc).toMatch(/admitted:\s*false/)
    expect(rpcBridgeSrc).toContain("kind: 'admit_abort'")
  })

  // ── Fix 2: worker tool activity is reported to the runner ──
  it('Fix 2: client fires onToolActivity on RPC tool_call AND loop tool_start', () => {
    // RPC branch (host-side execution about to start) — now in
    // subAgentWorkerRpcBridge.ts (handleWorkerToolCall fires onToolActivity).
    expect(rpcBridgeSrc).toMatch(/export function handleWorkerToolCall/)
    expect(rpcBridgeSrc).toMatch(/onToolActivity\?\.\(\)/)
    // Loop-event branch (covers local tools that never RPC back) — now in
    // subAgentWorkerEventBridge.ts.
    expect(eventBridgeSrc).toMatch(
      /loopEv\?\.type\s*===\s*'tool_start'[\s\S]{0,500}?onToolActivity\?\.\(\)/m,
    )
  })

  it('Fix 2: runner gates the in-process fallback on workerToolActivitySeen', () => {
    expect(dispatchSrc).toMatch(/if \(workerToolActivitySeen\) \{/)
    expect(dispatchSrc).toMatch(/fallback was skipped to avoid duplicating tool side effects/i)
  })

  // ── Fix 4(a): session-memory-internal pinned to in-process ──
  it('Fix 4(a): useWorker decision hard-excludes session-memory-internal', () => {
    expect(dispatchSrc).toMatch(
      /const useWorker\s*=\s*\n\s*!isSessionMemoryInternalAgentType\(agentDef\.agentType\)\s*&&/m,
    )
  })

  // ── Fix 4(b): worker-side defensive sandbox refusal ──
  it('Fix 4(b): SessionInitSchema declares sessionAgentType', () => {
    // z.object strips unknown keys — without the schema field the worker
    // would never see the agent type and the defensive check would be dead.
    expect(bridgeSrc).toMatch(/sessionAgentType:\s*z\.string\(\)/)
  })

  it('Fix 4(b): client forwards the child sessionAgentType into the init payload', () => {
    expect(clientSrc).toMatch(/\{\s*sessionAgentType:\s*rpcSessionAgentType\s*\}/)
  })

  it('Fix 4(b): worker records the agent type at init and refuses local execution for the scribe', () => {
    expect(workerSrc).toMatch(/sessionAgentType\s*=\s*init\.sessionAgentType\?\.trim\(\)/)
    expect(workerSrc).toMatch(
      /isSessionMemoryInternalAgentType\(sessionAgentType\)[\s\S]{0,400}?success:\s*false/m,
    )
  })
})

/**
 * Extract the `createToolUseContext({ ... })` block inside the
 * `tool_call` RPC handler so axis-4 assertions don't accidentally match
 * a different ctx construction elsewhere in the file. Returns the raw
 * substring (including braces). Uses bracket-balancing so nested object
 * literals in the body (e.g. spread+ternary) do not truncate the slice.
 */
function extractToolExecCtxBlock(src: string): string {
  return extractBalancedCallBody(src, 'const toolExecCtx = createToolUseContext(')
}

/**
 * Generic "find `prefix` then return up to the matching `)`" helper.
 *
 * The prefix MUST end with `(` so we know we're entering the argument
 * list. We then bracket-balance across `(){}[]` to find the matching
 * closing `)` of the call. The returned string includes both the prefix
 * and the trailing `)`.
 *
 * This is needed because the simple `indexOf(')')` approach falls into
 * the first nested `)` (inside a spread / ternary / nested object) and
 * truncates the slice before the fields the test wants to assert.
 *
 * NOTE: this is a syntactic match on raw source. It does not understand
 * comments, template literals, or quoted parens — those would all break
 * the count. The call sites we exercise here (`runSubAgentInWorker(...)`
 * and `createToolUseContext(...)`) only carry plain object literals, so
 * the simple counter is sufficient.
 */
function extractBalancedCallBody(src: string, prefix: string): string {
  if (!prefix.endsWith('(')) {
    throw new Error(
      `extractBalancedCallBody: prefix must end with '(', got '${prefix}'`,
    )
  }
  const start = src.indexOf(prefix)
  if (start < 0) {
    throw new Error(
      `Test setup error: cannot find '${prefix}' in source. ` +
        'If the call was renamed, update the test.',
    )
  }
  let depth = 0
  let pos = start + prefix.length - 1 // start at the opening '('
  const len = src.length
  while (pos < len) {
    const ch = src[pos]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && ch === ')') {
        return src.slice(start, pos + 1)
      }
    }
    pos++
  }
  throw new Error(`Unterminated call starting at '${prefix}'`)
}
