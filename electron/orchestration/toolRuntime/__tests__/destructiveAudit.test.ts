/**
 * 编排层破坏性审计（2026-06）—— 用敌意输入实证 scheduler / state /
 * policy / rateLimitRing 的边界行为。断言写的是「期望的正确行为」：
 * 失败的用例即审计发现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
} from '../scheduler'
import {
  clearToolRuntimeStateForTests,
  getToolEntry,
  markToolCompleted,
  markToolResumed,
  markToolRunning,
  preemptTool,
  registerToolInvocation,
  abortToolsInTree,
} from '../state'
import { asAgentId } from '../../../tools/ids'
import {
  clearToolRateLimitRingForTests,
  countToolInvocationsSince,
  recordToolInvocationForRateLimit,
} from '../rateLimitRing'
import { getPolicyEngine, resetPolicyEngineForTests } from '../policy'

const A = asAgentId('agent-a')
const B = asAgentId('agent-b')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  resetToolSchedulerForTests()
  clearToolRuntimeStateForTests()
  clearToolRateLimitRingForTests()
  resetPolicyEngineForTests()
})

describe('破坏性: ToolScheduler', () => {
  it('S1 重复 toolUseId 重入 enqueue 后，旧 terminal 节点的清理定时器不得误删新节点', () => {
    const s = getToolScheduler()
    s.enqueueBatch([
      { toolUseId: 'dup_1', toolName: 'grep', agentId: A, input: {}, readOnly: true },
    ])
    s.markCompleted('dup_1') // 启动 120s 清理定时器
    // 网关复用 id（DeepSeek 系 call_0）→ 同 id 重新入队
    vi.advanceTimersByTime(60_000)
    s.enqueueBatch([
      { toolUseId: 'dup_1', toolName: 'grep', agentId: A, input: {}, readOnly: true },
    ])
    expect(s.getNodeStatus('dup_1')).toBe('ready')
    // 推进到旧定时器的触发点之后 —— 新节点必须仍然存在
    vi.advanceTimersByTime(70_000)
    expect(s.getNodeStatus('dup_1')).toBe('ready')
  })

  it('S2 同批依赖环 A↔B 不崩溃，且两者不会被错误调度', () => {
    const s = getToolScheduler()
    s.enqueueBatch([
      { toolUseId: 'c_a', toolName: 'x', agentId: A, input: {}, readOnly: true, dependsOn: ['c_b'] },
      { toolUseId: 'c_b', toolName: 'y', agentId: A, input: {}, readOnly: true, dependsOn: ['c_a'] },
    ])
    const plan = s.planNextWaves()
    expect(plan.waves.length).toBe(0)
    expect(plan.deferred.map((d) => d.toolUseId).sort()).toEqual(['c_a', 'c_b'])
  })

  it('S3 markFailed 在依赖环上不无限递归', () => {
    const s = getToolScheduler()
    s.enqueueBatch([
      { toolUseId: 'r_a', toolName: 'x', agentId: A, input: {}, readOnly: true, dependsOn: ['r_b'] },
      { toolUseId: 'r_b', toolName: 'y', agentId: A, input: {}, readOnly: true, dependsOn: ['r_a'] },
    ])
    expect(() => s.markFailed('r_a')).not.toThrow()
    expect(s.getNodeStatus('r_a')).toBe('failed')
    expect(s.getNodeStatus('r_b')).toBe('failed')
  })

  it('S4 依赖一个从未存在的 id：立即级联失败（带 120s 保留），不再永久 pending 泄漏', () => {
    const s = getToolScheduler()
    s.enqueueBatch([
      { toolUseId: 'ghost_dep', toolName: 'x', agentId: A, input: {}, readOnly: true, dependsOn: ['never-existed'] },
    ])
    // 幽灵依赖永远无法满足（markCompleted 不会到达不存在的节点，
    // 后到的同 id 节点也不会回填 dependedBy 边）→ 视同 failed 依赖
    expect(s.getNodeStatus('ghost_dep')).toBe('failed')
    // 标准 120s 保留后被清理，不再无限泄漏
    vi.advanceTimersByTime(130_000)
    expect(s.getNodeStatus('ghost_dep')).toBeUndefined()
  })
})

describe('破坏性: ToolRuntimeState', () => {
  it('T1 重复 register 同 id：旧 terminal entry 的清理定时器不得误删新 entry', () => {
    registerToolInvocation({ toolUseId: 'tdup', toolName: 'grep', agentId: A, input: {} })
    markToolRunning('tdup')
    markToolCompleted('tdup') // 启动 120s 清理
    vi.advanceTimersByTime(60_000)
    // 同 id 第二次注册（跨轮/跨会话 id 复用）
    registerToolInvocation({ toolUseId: 'tdup', toolName: 'grep', agentId: B, input: {} })
    vi.advanceTimersByTime(70_000) // 越过旧定时器触发点
    expect(getToolEntry('tdup')).toBeDefined()
    expect(getToolEntry('tdup')?.agentId).toBe(B)
  })

  it('T2 markToolResumed 不得复活 terminal 工具', () => {
    registerToolInvocation({ toolUseId: 'res_1', toolName: 'grep', agentId: A, input: {} })
    markToolRunning('res_1')
    markToolCompleted('res_1')
    markToolResumed('res_1')
    expect(getToolEntry('res_1')?.status).toBe('completed')
  })

  it('T3 preemptTool 幂等：未知 id / 已 terminal 返回 false', () => {
    expect(preemptTool('nope', 'r')).toBe(false)
    registerToolInvocation({ toolUseId: 'pre_1', toolName: 'grep', agentId: A, input: {} })
    markToolRunning('pre_1')
    expect(preemptTool('pre_1', 'r1')).toBe(true)
    expect(preemptTool('pre_1', 'r2')).toBe(false)
    expect(getToolEntry('pre_1')?.status).toBe('aborted')
  })

  it('T4 abortToolsInTree 在环状 parent 边上不死循环', () => {
    // 构造 parent 环：a 的 parent 是 b，b 的 parent 是 a
    registerToolInvocation({ toolUseId: 'cyc_a', toolName: 'x', agentId: A, parentAgentId: B, input: {} })
    registerToolInvocation({ toolUseId: 'cyc_b', toolName: 'y', agentId: B, parentAgentId: A, input: {} })
    markToolRunning('cyc_a')
    markToolRunning('cyc_b')
    expect(() => abortToolsInTree(A, 'cycle test')).not.toThrow()
    expect(getToolEntry('cyc_a')?.status).toBe('aborted')
    expect(getToolEntry('cyc_b')?.status).toBe('aborted')
  })
})

describe('破坏性: rateLimitRing', () => {
  it('R1 时钟回拨被钳制为单调（保守计入最近时刻），且仍能正常老化', () => {
    recordToolInvocationForRateLimit('t', 100_000)
    recordToolInvocationForRateLimit('t', 50_000) // 回拨 → 钳制为 100_000
    // 两个事件都按"最近已知时刻"保守计入（限流方向安全）
    expect(countToolInvocationsSince('t', 60_000)).toBe(2)
    // 时间推进后两条都老化掉 —— 修复前回拨条目可能卡死在 deque 中
    expect(countToolInvocationsSince('t', 150_000)).toBe(0)
  })
})

describe('破坏性: PolicyEngine', () => {
  const baseEval = {
    toolInput: {},
    toolUseId: 'p_1',
    isReadOnly: true,
    priority: 50,
    skipQuota: true,
    skipHistory: true,
  }

  it('P1 allowlist 含通配模式（mcp__srv__*）时能放行匹配的工具', () => {
    const engine = getPolicyEngine()
    const d = engine.evaluate({
      ...baseEval,
      toolName: 'mcp__srv__do_thing',
      context: { agentId: A, toolAllowlist: ['mcp__srv__*'] },
    })
    expect(d.allowed).toBe(true)
  })

  it('P2 allowlist 用别名（Write）时对 registry 名（write_file）的判定', () => {
    const engine = getPolicyEngine()
    const d = engine.evaluate({
      ...baseEval,
      toolName: 'write_file',
      context: { agentId: A, toolAllowlist: ['Write'] },
    })
    // 记录现状：别名是否被拒（发现项，不一定是 bug —— 取决于调用方是否已 canonical 化）
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('allowlist')
  })

  it('P3 空字符串 allowlist 项不放行一切', () => {
    const engine = getPolicyEngine()
    const d = engine.evaluate({
      ...baseEval,
      toolName: 'bash',
      context: { agentId: A, toolAllowlist: [''] },
    })
    expect(d.allowed).toBe(false)
  })

  it('P4 chatMode=ask 在 bypassPermissions 下仍然拒绝（最高优先级）', () => {
    const engine = getPolicyEngine()
    const d = engine.evaluate({
      ...baseEval,
      toolName: 'read_file',
      context: { agentId: A, chatMode: 'ask', permissionMode: 'bypassPermissions' },
    })
    expect(d.allowed).toBe(false)
    expect(d.matchedRules).toContain('chat_mode:ask')
  })
})
