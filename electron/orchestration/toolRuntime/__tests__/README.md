# Tool Orchestration Unit Tests

Unit tests for the per-module primitives of the (now in-merge) tool orchestration
subsystem. See `../TOOL_ORCHESTRATION_MIGRATION.md` for the current consolidation
status.

| File | Covers |
|------|--------|
| `toolRuntimeState.test.ts` | Per-tool lifecycle state machine, resource counters, filter by agent/status |
| `toolScheduler.test.ts` | DAG dependency resolution, priority ordering, wave grouping, preemption |
| `resourceQuota.test.ts` | Dynamic admission, quota overflow blocks, token windowing, hot config updates |
| `globalToolCallHistory.test.ts` | Cross-agent fingerprint dedup, failure escalation, TTL eviction |
| `policyEngine.test.ts` | Allowlist / denylist, global rules, rate limit, token quota |

## Run

```bash
npx vitest run electron/orchestration/__tests__
```
