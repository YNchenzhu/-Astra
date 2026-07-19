/**
 * 编排层破坏性审计·二期（2026-06）—— kernel 生命周期（中断/暂停/持久化故障注入）、
 * inbox 磁盘损坏 blob、checkpoint 分支树、quota 抢占边界、HITL 中断恢复。
 * 断言写的是「期望的正确行为」：失败的用例即审计发现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationKernel } from './kernel'
import { createInitialKernelLoopState } from './kernelTypes'
import { createTransportAdapter } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import {
  loadInboxFromDisk,
  saveInboxToDisk,
} from './inboxPersistence'
import type { KernelInboxItem } from './kernelTypes'
import { createInMemoryCheckpointPort } from './checkpoint'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from './toolRuntime/quota'
import {
  clearToolRuntimeStateForTests,
  getToolEntry,
  markToolCompleted,
  markToolRunning,
  registerToolInvocation,
} from './toolRuntime/state'
import { asAgentId } from '../tools/ids'
import {
  findPendingHumanResume,
  isInterruptForHITL,
  InterruptForHITL,
  canUseDurableHITL,
} from './hitl'

const A = asAgentId('agent-a')

function makeKernel(opts?: {
  emit?: (e: unknown) => void
  adapter?: { save: (b: unknown) => void; load?: () => undefined; delete?: () => void }
  convId?: string
}) {
  const ports = {
    tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
    permission: { noteToolInvocation: vi.fn() },
    session: { onTranscriptCommitted: vi.fn() },
    transport: createTransportAdapter(opts?.emit ?? vi.fn()),
    hooks: {
      onSessionStart: vi.fn(),
      onPromptSubmit: vi.fn(),
      onSessionEnd: vi.fn(),
    },
  }
  return new OrchestrationKernel(
    // 端口集合按 kernel.test.ts 的合法夹具构造
    ports as ConstructorParameters<typeof OrchestrationKernel>[0],
    undefined, // observer
    createInitialKernelLoopState([]),
    opts?.convId ?? 'conv-destructive',
    opts?.adapter
      ? {
          persistenceAdapter:
            opts.adapter as unknown as NonNullable<
              ConstructorParameters<typeof OrchestrationKernel>[4]
            >['persistenceAdapter'],
        }
      : undefined,
  )
}

afterEach(() => {
  clearToolRuntimeStateForTests()
  resetResourceQuotaManagerForTests()
})

describe('破坏性: kernel 中断升级', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('K1 软中断在宽限期后自动升级为硬中断', () => {
    const kernel = makeKernel()
    kernel.setSoftInterruptGraceMs(1_000)
    kernel.interrupt('user')
    expect(kernel.getAbortSignal().aborted).toBe(true)
    expect(kernel.getHardAbortSignal().aborted).toBe(false)
    vi.advanceTimersByTime(1_100)
    expect(kernel.getHardAbortSignal().aborted).toBe(true)
  })

  it('K1b dispose 取消宽限定时器，不产生幽灵硬中断', () => {
    const kernel = makeKernel()
    kernel.setSoftInterruptGraceMs(1_000)
    kernel.interrupt('user')
    kernel.dispose()
    vi.advanceTimersByTime(5_000)
    expect(kernel.getHardAbortSignal().aborted).toBe(false)
  })

  it('K2 重复软中断幂等：保留首个 reason，只发一次中断事件', () => {
    const events: unknown[] = []
    const kernel = makeKernel({ emit: (e) => events.push(e) })
    kernel.setSoftInterruptGraceMs(0)
    kernel.interrupt('user')
    kernel.interrupt('watchdog' as Parameters<OrchestrationKernel['interrupt']>[0])
    expect(kernel.getInterruptReason()).toBe('user')
    const interruptEvents = events.filter((e) =>
      JSON.stringify(e).includes('interrupt'),
    )
    expect(interruptEvents.length).toBe(1)
  })

  it('K3 软中断后立即硬升级：宽限定时器被取消，不再二次触发', () => {
    const events: unknown[] = []
    const kernel = makeKernel({ emit: (e) => events.push(e) })
    kernel.setSoftInterruptGraceMs(1_000)
    kernel.interrupt('user')
    kernel.interrupt('user', { hard: true })
    expect(kernel.getHardAbortSignal().aborted).toBe(true)
    const countAfterEscalation = events.length
    vi.advanceTimersByTime(5_000)
    // 宽限定时器若未取消，会在这里多发一条 grace_expired 事件
    expect(events.length).toBe(countAfterEscalation)
  })
})

describe('破坏性: kernel 持久化故障注入', () => {
  it('K4 适配器持续抛错：persist 重试后优雅返回 undefined，不向上抛', async () => {
    const save = vi.fn(() => {
      throw new Error('EBUSY: locked')
    })
    const kernel = makeKernel({ adapter: { save } })
    const blob = await kernel.persist()
    expect(blob).toBeUndefined()
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(2) // 至少重试一次
  })

  it('K4b 第一次抛错第二次成功：persist 经重试成功返回 blob', async () => {
    let calls = 0
    const save = vi.fn(() => {
      calls++
      if (calls === 1) throw new Error('EBUSY: transient')
    })
    const kernel = makeKernel({ adapter: { save } })
    const blob = await kernel.persist()
    expect(blob).toBeDefined()
    expect(calls).toBe(2)
  })

  it('K5 节流：throttleMs 内的第二次持久化被跳过，强制保存不受影响', async () => {
    const save = vi.fn()
    const kernel = makeKernel({ adapter: { save } })
    expect(await kernel.persist()).toBeDefined()
    expect(await kernel.persist({ throttleMs: 60_000 })).toBeUndefined()
    expect(await kernel.persist()).toBeDefined() // 无参强制保存
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('K7 restoreFrom 带 paused 标记的 blob → 内核处于暂停态', async () => {
    const save = vi.fn()
    const k1 = makeKernel({ adapter: { save } })
    const blob = await k1.persist()
    expect(blob).toBeDefined()
    const k2 = makeKernel()
    k2.restoreFrom({ ...blob!, paused: true })
    expect(k2.isPaused()).toBe(true)
  })

  it('K6 pause/resume 翻转本会话运行中工具的状态，terminal 工具不被复活', () => {
    const conv = 'conv-k6'
    const kernel = makeKernel({ convId: conv })
    registerToolInvocation({
      toolUseId: 'k6_run', toolName: 'grep', agentId: A, conversationId: conv, input: {},
    })
    markToolRunning('k6_run')
    registerToolInvocation({
      toolUseId: 'k6_done', toolName: 'grep', agentId: A, conversationId: conv, input: {},
    })
    markToolRunning('k6_done')
    markToolCompleted('k6_done')

    kernel.pause()
    expect(getToolEntry('k6_run')?.status).toBe('paused')
    expect(getToolEntry('k6_done')?.status).toBe('completed')
    kernel.pause() // 幂等
    kernel.resume()
    expect(getToolEntry('k6_run')?.status).toBe('running')
    expect(getToolEntry('k6_done')?.status).toBe('completed') // 不复活
    kernel.resume() // 幂等
  })
})

describe('破坏性: inbox 磁盘损坏 blob', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-inbox-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  const item = (text: string): KernelInboxItem =>
    ({ kind: 'synthetic_user_text', text }) as KernelInboxItem

  it('I1 损坏的 JSON 文件 → load 返回 undefined 不抛', () => {
    expect(saveInboxToDisk('c1', [item('hi')], dir).ok).toBe(true)
    const file = path.join(dir, 'orchestration-inbox', 'c1.json')
    fs.writeFileSync(file, '{"version":1,"conversationId":"c1","inbox":[truncated', 'utf-8')
    expect(loadInboxFromDisk('c1', dir)).toBeUndefined()
  })

  it('I2 版本不匹配 → undefined', () => {
    const file = path.join(dir, 'orchestration-inbox', 'c2.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 99, conversationId: 'c2', savedAt: 1, inbox: [] }), 'utf-8')
    expect(loadInboxFromDisk('c2', dir)).toBeUndefined()
  })

  it('I3 会话 id 不匹配（文件被复制/重命名）→ undefined', () => {
    expect(saveInboxToDisk('c3', [item('hi')], dir).ok).toBe(true)
    const src = path.join(dir, 'orchestration-inbox', 'c3.json')
    const dst = path.join(dir, 'orchestration-inbox', 'c4.json')
    fs.copyFileSync(src, dst)
    expect(loadInboxFromDisk('c4', dir)).toBeUndefined()
  })

  it('I4 信封合法但条目是垃圾 → 原样返回（记录在案：无逐条校验）', () => {
    const file = path.join(dir, 'orchestration-inbox', 'c5.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, conversationId: 'c5', savedAt: 1, inbox: [{ kind: 'no_such_kind', junk: 1 }] }),
      'utf-8',
    )
    const out = loadInboxFromDisk('c5', dir)
    expect(out).toHaveLength(1) // 垃圾条目穿透 —— 设计缺口，靠下游 switch 容错
  })

  it('I5 safeConvId 归一化碰撞：a/b 与 a_b 写同一文件，读侧由 id 校验兜底', () => {
    expect(saveInboxToDisk('a/b', [item('from a/b')], dir).ok).toBe(true)
    expect(saveInboxToDisk('a_b', [item('from a_b')], dir).ok).toBe(true)
    // 写侧互相覆盖（同一物理文件）—— 读 a/b 时 conversationId 不匹配 → undefined
    expect(loadInboxFromDisk('a/b', dir)).toBeUndefined()
    expect(loadInboxFromDisk('a_b', dir)).toHaveLength(1)
  })

  it('I6 空 inbox 保存即删除磁盘文件', () => {
    expect(saveInboxToDisk('c6', [item('x')], dir).ok).toBe(true)
    const file = path.join(dir, 'orchestration-inbox', 'c6.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(saveInboxToDisk('c6', [], dir).ok).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('破坏性: checkpoint 分支树', () => {
  const state = () => createInitialKernelLoopState([])

  it('C1 rewind 未知 id → null，历史不变', () => {
    const port = createInMemoryCheckpointPort()
    const id = port.snapshot('t1', state())
    expect(port.rewind('no-such-id')).toBeNull()
    expect(port.list()).toHaveLength(1)
    expect(port.getBranchHead()).toBe(id)
  })

  it('C2 rewind 非截断：旧分支保留，新 head 指向 rewind 锚点', () => {
    const port = createInMemoryCheckpointPort()
    const s1 = port.snapshot('base', state())
    const s2 = port.snapshot('attempt-1', state())
    const restored = port.rewind(s1)
    expect(restored).not.toBeNull()
    const head = port.getBranchHead()
    expect(head).not.toBe(s2)
    expect(port.peek(s2)).not.toBeNull() // 被放弃的分支仍可达
    const tree = port.listTree()
    expect(tree.map((e) => e.id)).toContain(s2)
    expect(tree.find((e) => e.id === head)?.parentId).toBe(s1)
  })

  it('C3 容量驱逐后 rewind 到被驱逐的 id → null（不崩溃）', () => {
    const port = createInMemoryCheckpointPort({ maxEntries: 2 })
    const s1 = port.snapshot('t1', state())
    port.snapshot('t2', state())
    port.snapshot('t3', state()) // 驱逐 s1
    expect(port.list()).toHaveLength(2)
    expect(port.rewind(s1)).toBeNull()
  })

  it('C4 深拷贝隔离：外部篡改返回的 state 不影响存档', () => {
    const port = createInMemoryCheckpointPort()
    const s = state()
    const id = port.snapshot('iso', s)
    const peeked = port.peek(id)!
    peeked.state.iteration = 999
    peeked.state.inbox.push({ kind: 'synthetic_user_text', text: 'inject' } as KernelInboxItem)
    const again = port.peek(id)!
    expect(again.state.iteration).not.toBe(999)
    expect(again.state.inbox).toHaveLength(0)
  })
})

describe('破坏性: quota 抢占边界', () => {
  it('Q1 shell 槽位满且无可抢占受害者 → 拒绝 shell_quota', () => {
    const q = getResourceQuotaManager({ maxGlobalShellChildren: 1, enablePreemption: true })
    registerToolInvocation({
      toolUseId: 'q1_v', toolName: 'bash', agentId: A, input: {}, priority: 70, preemptible: false,
    })
    markToolRunning('q1_v')
    const d = q.admit({ toolName: 'bash', toolUseId: 'q1_n', agentId: A, isReadOnly: false, priority: 50 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('shell_quota')
  })

  it('Q2 低优先级可抢占受害者存在 → 放行并指名 preemptionTarget', () => {
    const q = getResourceQuotaManager({ maxGlobalShellChildren: 1, enablePreemption: true })
    registerToolInvocation({
      toolUseId: 'q2_v', toolName: 'bash', agentId: A, input: {}, priority: 10, preemptible: true,
    })
    markToolRunning('q2_v')
    const d = q.admit({ toolName: 'bash', toolUseId: 'q2_n', agentId: A, isReadOnly: false, priority: 70 })
    expect(d.allowed).toBe(true)
    expect(d.preemptionTarget).toBe('q2_v')
  })

  it('Q3 受害者优先级不低于新来者 → 不抢占，拒绝', () => {
    const q = getResourceQuotaManager({ maxGlobalShellChildren: 1, enablePreemption: true })
    registerToolInvocation({
      toolUseId: 'q3_v', toolName: 'bash', agentId: A, input: {}, priority: 70, preemptible: true,
    })
    markToolRunning('q3_v')
    const d = q.admit({ toolName: 'bash', toolUseId: 'q3_n', agentId: A, isReadOnly: false, priority: 70 })
    expect(d.allowed).toBe(false)
  })

  it('Q4 TOCTOU 预约：同一 tick 两个 admit 第二个被预约计数拦下', () => {
    const q = getResourceQuotaManager({ maxGlobalMutationParallel: 1, enablePreemption: false })
    const d1 = q.admit({ toolName: 'edit_file', toolUseId: 'q4_a', agentId: A, isReadOnly: false, priority: 50 })
    const d2 = q.admit({ toolName: 'edit_file', toolUseId: 'q4_b', agentId: A, isReadOnly: false, priority: 50 })
    expect(d1.allowed).toBe(true)
    expect(d2.allowed).toBe(false)
    expect(d2.reason).toBe('mutation_concurrency')
  })

  it('Q5 同 id 重复 admit 幂等（背压重试不自我拒绝）', () => {
    const q = getResourceQuotaManager({ maxGlobalMutationParallel: 1, enablePreemption: false })
    const d1 = q.admit({ toolName: 'edit_file', toolUseId: 'q5_a', agentId: A, isReadOnly: false, priority: 50 })
    const d2 = q.admit({ toolName: 'edit_file', toolUseId: 'q5_a', agentId: A, isReadOnly: false, priority: 50 })
    expect(d1.allowed).toBe(true)
    expect(d2.allowed).toBe(true)
  })

  it('Q6 NaN / 负数 estimatedTokens 不会误拒（行为已定义）', () => {
    const q = getResourceQuotaManager({ maxTokenRatePerMinute: 100 })
    const dNaN = q.admit({ toolName: 'grep', toolUseId: 'q6_a', agentId: A, isReadOnly: true, priority: 50, estimatedTokens: Number.NaN })
    expect(dNaN.allowed).toBe(true)
    const dNeg = q.admit({ toolName: 'grep', toolUseId: 'q6_b', agentId: A, isReadOnly: true, priority: 50, estimatedTokens: -5 })
    expect(dNeg.allowed).toBe(true)
  })
})

describe('破坏性: HITL 中断恢复', () => {
  it('H1 多个同 toolUseId 的 resume：只消费第一个，其余保留', () => {
    const inbox: KernelInboxItem[] = [
      { kind: 'pending_human_resume', toolUseId: 'tu1', value: 'first' } as KernelInboxItem,
      { kind: 'pending_human_resume', toolUseId: 'tu1', value: 'second' } as KernelInboxItem,
      { kind: 'synthetic_user_text', text: 'keep' } as KernelInboxItem,
    ]
    const r = findPendingHumanResume({ inbox }, 'tu1')
    expect(r).not.toBeNull()
    expect(r!.value).toBe('first')
    expect(r!.remainingInbox).toHaveLength(2)
    // 二次消费拿到第二个 —— 不会丢
    const r2 = findPendingHumanResume({ inbox: r!.remainingInbox }, 'tu1')
    expect(r2!.value).toBe('second')
  })

  it('H2 isInterruptForHITL 跨边界识别：tag 形状对象 ✓，普通 Error ✗', () => {
    expect(isInterruptForHITL(new InterruptForHITL('tu1', { q: 1 }))).toBe(true)
    expect(isInterruptForHITL({ tag: 'orchestration:hitl', toolUseId: 'tu1' })).toBe(true)
    expect(isInterruptForHITL(new Error('orchestration:hitl'))).toBe(false)
    expect(isInterruptForHITL(null)).toBe(false)
    expect(isInterruptForHITL({ tag: 'orchestration:hitl' })).toBe(false) // 缺 toolUseId
  })

  it('H3 没有注册 kernel 的会话不能走 durable HITL（防泄漏 pending 项）', () => {
    expect(canUseDurableHITL('conv-without-kernel-xyz')).toBe(false)
    expect(canUseDurableHITL(undefined)).toBe(false)
    expect(canUseDurableHITL('  ')).toBe(false)
  })
})
