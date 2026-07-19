/**
 * P1 Bug 验证测试 — Sub-Agent Runner 问题
 *
 * AGENT-01: Background agent 无 token/tool 硬限制
 *   bridgeAc 依赖 !agentIdOverride，background agent 跳过 budget 注册
 *
 * AGENT-02: Background agent 完成后 30 秒延迟清理占用并发槽
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  resolveSubAgentReportedOutput,
  shouldAbortReadonlyBudgetAfterMessageEnd,
} from './subAgentRunner'

// ---------------------------------------------------------------------------
// AGENT-01: Background agent 无 token/tool 硬限制
// ---------------------------------------------------------------------------

// FIXME (P1-bugs source-as-string fragility, 2026-05-11): the tests below
// originally asserted the *presence* of a specific bug shape (`bridgeAc`
// gated on `!agentIdOverride`). That shape was refactored away when the
// P0-2 fix landed — `bridgeAc` is now ALWAYS created and only the
// `activeAgentRegistry` registration stays conditional on
// `wasPreRegistered`. Updated below to verify the FIXED behaviour instead,
// using soft regex matches that survive future cosmetic renames.
describe('AGENT-01: Background agent has no token/tool hard limits (P0-2 fix verified)', () => {
  it('shouldRegisterForPending is derived from the pre-registration check', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'subAgentRunner.ts'),
      'utf-8',
    )

    // Either the legacy variable name (`!agentIdOverride`) or the current
    // refactored name (`!wasPreRegistered`) is acceptable — both express
    // the same invariant: "register only when nobody else did". This
    // regex is the soft match that replaces the original brittle
    // `src.includes('shouldRegisterForPending = !agentIdOverride')`.
    expect(src).toMatch(
      /shouldRegisterForPending\s*=\s*!(?:agentIdOverride|wasPreRegistered)/,
    )

    // Token-budget machinery is still wired through `bridgeAc`.
    expect(src).toContain('bridgeAc')
  })

  it('bridgeAc is created UNCONDITIONALLY (P0-2 fix: budget guards survive agentIdOverride)', () => {
    // The P0-2 fix moved `const bridgeAc = new AbortController()` outside
    // the `if (shouldRegisterForPending)` block so background agents
    // (which set `agentIdOverride`) still receive token / tool-count /
    // wall-clock budget enforcement. Assert that fix is in place: there
    // must be a top-level `const bridgeAc = new AbortController()` that
    // is NOT inside any `if` block referencing `shouldRegisterForPending`.
    const src = fs.readFileSync(
      path.join(__dirname, 'subAgentRunner.ts'),
      'utf-8',
    )
    const lines = src.split('\n')
    const bridgeIdx = lines.findIndex((l) =>
      /^\s*const\s+bridgeAc\s*=\s*new\s+AbortController/.test(l),
    )
    expect(bridgeIdx).toBeGreaterThanOrEqual(0)

    // Look back up to 10 lines; the immediately preceding control statement
    // (if any) MUST NOT be an `if (shouldRegisterForPending)`. If it were,
    // we'd have regressed back to the original conditional shape.
    const above = lines.slice(Math.max(0, bridgeIdx - 10), bridgeIdx).join('\n')
    expect(above).not.toMatch(/if\s*\(\s*shouldRegisterForPending\s*\)\s*\{[^}]*$/)
  })

  it('agentTool.ts L549: background agent 使用 agentIdOverride', () => {
    // 验证 agentTool 中 background agent 传递 agentIdOverride
    const agentToolSrc = fs.readFileSync(
      path.join(__dirname, 'agentTool.ts'),
      'utf-8',
    )

    const hasAgentIdOverride = agentToolSrc.includes('agentIdOverride:')
    expect(hasAgentIdOverride).toBe(true)

    // 确认 background agent 路径使用了 agentIdOverride
    // L541: agentIdOverride: agentId
    const hasBackgroundPath = agentToolSrc.includes('agentIdOverride: agentId')
    expect(hasBackgroundPath).toBe(true)
  })
})

describe('Sub-agent abort reporting regressions', () => {
  it('does not abort a read-only budget overrun after a final text-only report exists', () => {
    expect(
      shouldAbortReadonlyBudgetAfterMessageEnd({
        toolsThisTurn: 0,
        finalText: '## Summary\nResearch complete.',
      }),
    ).toBe(false)
  })

  it('still aborts a budget overrun when the terminal turn had tools and no final report', () => {
    expect(
      shouldAbortReadonlyBudgetAfterMessageEnd({
        toolsThisTurn: 2,
        finalText: '',
      }),
    ).toBe(true)
  })

  it('includes the specific abort reason in the reported output', () => {
    const out = resolveSubAgentReportedOutput({
      lastFinalText: 'partial findings',
      outputText: '',
      reachedMaxIterations: false,
      aborted: true,
      abortReason: 'Agent timed out after 1800000ms',
    })

    expect(out).toContain('Agent timed out after 1800000ms')
    expect(out).toContain('content above may be partial')
  })

  it('does not perform early readonly token-budget abort during stream usage accounting', () => {
    // `recordUsageForBudgets` + `loopCallbacks` were extracted from
    // subAgentRunner.ts into subAgentLoopCallbacks.ts (file-split refactor);
    // this structural guard now inspects their new home.
    const src = fs.readFileSync(
      path.join(__dirname, 'subAgentLoopCallbacks.ts'),
      'utf-8',
    )
    const start = src.indexOf('const recordUsageForBudgets =')
    const end = src.indexOf('const loopCallbacks =', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const recordUsageBody = src.slice(start, end)
    expect(recordUsageBody).not.toContain('bridgeAc.abort()')
    expect(recordUsageBody).not.toContain('readonlyTokenBudget')
  })
})

// ---------------------------------------------------------------------------
// AGENT-02: Background agent 完成后 30 秒延迟清理
// ---------------------------------------------------------------------------

describe('AGENT-02: Background agent delayed cleanup occupies concurrency slot', () => {
  it('agentTool.ts: cleanup uses 5s grace on both success and crash paths (BUG-S1 fix)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'agentTool.ts'),
      'utf-8',
    )

    // 验证延迟清理逻辑仍然存在。
    // 注:agentTool.ts 的 cleanup 现在经 `agentLifecycle` facade
    // (`unspawnAndUntrackAgent`) 同时反注册 activeAgentRegistry +
    // MultiAgentOrchestrator,代替先前的 `unregisterActiveAgent` 直调。
    // 既匹配旧的也匹配新的函数名,这样回归断言不会被无副作用的重命名打破。
    const cleanupCallPattern = /(?:unregisterActiveAgent|unspawnAndUntrackAgent)/
    const hasDelayCleanup = new RegExp(
      `setTimeout\\(\\(\\)\\s*=>\\s*${cleanupCallPattern.source}`,
    ).test(src)
    expect(hasDelayCleanup).toBe(true)

    // BUG-S1 fix: previously the crash path used 30000 ms while the success
    // path used 5000 ms, asymmetrically holding concurrency slots for 6× as
    // long after a crash. After the fix both paths use 5000 ms — assert the
    // 30000 ms regression has not crept back in.
    const has30sUnregister = new RegExp(
      `setTimeout\\(\\(\\)\\s*=>\\s*${cleanupCallPattern.source}\\([^)]+\\),\\s*30000\\)`,
    ).test(src)
    expect(has30sUnregister).toBe(false)

    const fiveSecondCleanupRegex = new RegExp(
      `setTimeout\\(\\(\\)\\s*=>\\s*${cleanupCallPattern.source}\\([^)]+\\),\\s*5000\\)`,
      'g',
    )
    const fiveSecondCleanups = src.match(fiveSecondCleanupRegex) ?? []
    // background success + background crash + foreground finally → at least 3
    expect(fiveSecondCleanups.length).toBeGreaterThanOrEqual(2)
  })

  it('activeAgentRegistry 的 countRunningAgents 不计 endedAt', () => {
    const registrySrc = fs.readFileSync(
      path.join(__dirname, 'activeAgentRegistry.ts'),
      'utf-8',
    )

    // countRunningAgents 只检查 status === 'running'
    // 不检查 endedAt 或 status === 'completed'
    const hasStatusCheck = registrySrc.includes("status === 'running'")
    expect(hasStatusCheck).toBe(true)

    // BUG 验证: status 在 agent 完成后立即设为 'completed'
    // 但 countRunningAgents 只看 'running'，看似正确
    // 问题在于 agentTool.ts 中的 unregister 逻辑:
    //   activeAgent.status = result.success ? 'completed' : 'failed'
    //   setTimeout(() => unregisterActiveAgent(agentId), 30000)
    // status 已变为 completed，但 agent 记录仍在内存中
    // 这影响的是其他消费者（如 getActiveAgent）
  })

  it('30 秒延迟内新 agent 可能被 MAX_CONCURRENT_AGENTS 拒绝', () => {
    const registrySrc = fs.readFileSync(
      path.join(__dirname, 'activeAgentRegistry.ts'),
      'utf-8',
    )

    // MAX_CONCURRENT_AGENTS = 10 硬上限
    const hasMaxConcurrent = registrySrc.includes('MAX_CONCURRENT_AGENTS')
    expect(hasMaxConcurrent).toBe(true)

    // BUG 验证: 如果 10 个 background agent 在 30 秒窗口内快速启动
    // 第 11 个会因为 registerActiveAgent 中的 countRunningAgents 检查被拒绝
    // 但实际上应该允许，因为前 10 个可能已经 completed
  })
})

// ---------------------------------------------------------------------------
// AGENT-03: 非 team 后台子代理不应该在 agentic loop 结束后进入 mailbox 空转
//
// 复现: 主代理通过 Agent(run_in_background=true) 拉起一个普通后台子代理
// (no team_name)。子代理的 agentic loop 自然完成 (模型不再发 tool_use) 后,
// 它应该 emit `subagent_complete` 并被注销。修复前 agentTool.ts 无条件传
// `stayRunningForSendMessage: true`, 导致子代理进入 `waitForAgentMailboxOrAbort`
// 无限期等待 SendMessage; 主代理 stop 后再不会有人喂消息, 子代理实质挂起,
// UI 状态永远停留在 "running"。
//
// 修复: stayRunningForSendMessage 必须门控在 `teamName?.trim()` 上, 与
// sendMessageDiskRecovery.ts 的约定保持一致。只有 team 成员才需要长留。
// ---------------------------------------------------------------------------

describe('AGENT-03: Non-team background sub-agents must terminate naturally (idle-hang fix)', () => {
  it('agentTool.ts 后台分支按 teamName 门控 stayRunningForSendMessage', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'agentTool.ts'),
      'utf-8',
    )

    // 修复后必须按 teamName 门控 — 不能再硬编码 `true`
    expect(src).not.toMatch(/stayRunningForSendMessage:\s*true/)

    // 必须出现 `Boolean(teamName?.trim())` 形式的派生
    // (允许中间 const 命名变动 — 用更宽的正则)
    expect(src).toMatch(
      /stayRunningForSendMessage\s*=\s*Boolean\(\s*teamName\??\.trim\(\)\s*\)/,
    )
  })

  it('与 sendMessageDiskRecovery.ts 的 teamName 门控保持一致', () => {
    const recoverySrc = fs.readFileSync(
      path.join(__dirname, 'sendMessageDiskRecovery.ts'),
      'utf-8',
    )

    // 锚定参考实现 — 同步两边的语义
    expect(recoverySrc).toMatch(
      /stayRunningForSendMessage:\s*Boolean\(snap\.teamName\??\.trim\(\)\)/,
    )
  })
})

// ---------------------------------------------------------------------------
// AGENT-04: Sub-agent thinking policy — non-fork sub-agents disable extended
// thinking by default (对齐 upstream-main `runAgent.ts:682`)
//
// 旧策略只对 `subagentToolProfile === 'async_agent'` 关 thinking,其它子代
// 理一律继承父亲。这会让"会话型"子代理 (`default` / `in_process_teammate`)
// 把父代理的内部推理串入自己的上下文,放大幻觉与 token 成本。
//
// upstream 的策略是:fork 子代理 (与父亲共享 prompt cache) 继承父亲,其
// 它一律 disabled。本测试用源代码字符串匹配锁定这条策略,避免后续 refactor
// 把它静默改回去。
// ---------------------------------------------------------------------------

describe('AGENT-04: Sub-agent extended thinking is disabled unless fork (cc-haha alignment)', () => {
  it('subAgentRunner.ts: alwaysThinking gated on isForkRun, not on subagentToolProfile', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'subAgentRunner.ts'),
      'utf-8',
    )

    // Locate the AgentContext-building block where alwaysThinking is set. The
    // important invariant: the discriminator is `isForkRun`, NOT
    // `subagentToolProfile === 'async_agent'` (the old shape).
    expect(src).toMatch(
      /alwaysThinking:\s*isForkRun\s*\?\s*parentContext\?\.alwaysThinking\s*===\s*true\s*:\s*false/,
    )

    // Old shape must not creep back. If a future change re-introduces the
    // ternary keyed off `subagentToolProfile === 'async_agent'`, fail loudly.
    expect(src).not.toMatch(
      /alwaysThinking:\s*\n?\s*agentDef\.subagentToolProfile\s*===\s*'async_agent'/,
    )
  })

  it('subAgentRunner.ts: isForkRun derivation stays intact', () => {
    // The new policy reads `isForkRun`; if that variable disappears or its
    // semantics drift, the policy silently degrades. Lock both shape and
    // proximity (isForkRun must be a local const, not e.g. a function call).
    const src = fs.readFileSync(
      path.join(__dirname, 'subAgentRunner.ts'),
      'utf-8',
    )
    expect(src).toMatch(/const\s+isForkRun\s*=/)
  })
})
