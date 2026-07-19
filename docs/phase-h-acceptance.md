# Phase H — Claude Code Alignment Acceptance

## Goal

Verify that the Phase A–G changes actually shift the runtime behaviour
of the chat in the direction of Claude Code. This phase is the
empirical floor — passing here closes the alignment gap from ~6.5/10
to 9+/10.

## What was implemented

| Phase | Deliverable | Lock |
|---|---|---|
| A | `electron/diagnostics/baselineReport.ts` + IPC `context:render-baseline-report` | `baselineReport.test.ts` (6 cases) |
| B | `electron/ai/promptSections/*` + registry-driven `buildSystemPromptLayers` | `sectionRegistry.test.ts` byte-equality (6 cases) |
| C | `electron/ai/systemReminderInjector.ts` + `streamHandler.ts` integration | `systemReminderInjector.test.ts` (7 cases) |
| D | `compact.ts` verbatim user-turn splice + analysis/summary prompt | `compact.userMessagePreservation.test.ts` (6 cases) |
| E | `electron/memory/autoMemoryWriteLoop.ts` + `streamHandler.ts` capture wiring | `autoMemoryWriteLoop.test.ts` (11 cases) |
| F | `forkGuidanceSection` + `selfAwarenessSection` + registry order | `forkAndSelfAwareness.test.ts` (5 cases) |
| G | `SlashCommandPopup` + `slashCommands.ts` + ChatInput integration | `slashCommands.test.ts` (12 cases) |

## How to run the acceptance comparison

1. **Make sure auto-memory capture is at the default (off)** unless
   you specifically want to test it: `unset POLE_AUTO_MEMORY_CAPTURE`.
2. **Capture a "before" snapshot**: check out the commit immediately
   before this PR, start the app with a real provider key, send a
   couple of representative prompts (one short, one medium). Use the
   chat panel's context drawer or call `getPromptDiagnostics()`
   directly to dump the records to JSON. Save as
   `docs/baseline-records-<date>.json`.
3. **Restore the new code and re-run the same prompts**. Dump the
   records again as `docs/current-records-<date>.json`.
4. **Render the comparison**. In dev tools console:
   ```js
   const before = JSON.parse(await fs.readFile('docs/baseline-records-2026-05-20.json'))
   const after = JSON.parse(await fs.readFile('docs/current-records-2026-05-20.json'))
   const md = await window.electronAPI.context.renderBaselineComparison({
     title: 'Claude Code alignment — Phase H',
     baselineLabel: 'before',
     currentLabel: 'after',
     baseline: before,
     current: after,
   })
   console.log(md)
   ```
5. **Save the rendered markdown** under
   `docs/alignment-comparison-<date>.md` and link it in the PR
   description.

## Pass criteria

The acceptance is **PASS** when the comparison report meets ALL of:

- **TTFB p50** drops by at least 30% on the short prompt.
- **TTFB p95** drops by at least 20% on the medium prompt.
- **Cache hit rate p50** rises by at least 30 percentage points after
  the third turn in the medium prompt (Claude Code cites 96% hit rate
  in steady state; we expect to be in that ballpark once cache warms).
- **Input tokens p50** drops or stays flat (no regression).
- **No iteration ends with `status: error`**.

If TTFB does not move but cache hit rate climbs, the bottleneck has
shifted from "huge prompt + cold cache" to something else (likely
model thinking budget). Note that in the report and follow up; do not
mark Phase H complete until TTFB has actually moved.

## Mock-mode smoke test (CI-safe)

For pull request CI you can validate the *report generator* without
issuing real API calls:

```bash
npx vitest run electron/diagnostics/baselineReport.test.ts
```

The renderer accepts hand-rolled record fixtures so the formatting
contract is exercised independently of any API key.

## Rollback

Each Phase is independently revertable. If the comparison report shows
a regression on any KPI, identify the offending Phase and revert the
section module / handler change. Re-run the full vitest sweep listed
at the top of this document to confirm nothing else regressed.
