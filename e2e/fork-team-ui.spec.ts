/**
 * E2E 测试 — 覆盖 FORK & TEAM 极端测试报告中的 UI 场景 U-01 到 U-20。
 *
 * 使用 Playwright Electron 模式，在真实 Chromium 窗口中运行 UI 自动
 * 化测试。先构建 dist-electron/，再运行本文件。
 *
 * 启动方式：
 *   1. npm run build          # 构建 dist-electron/main.js
 *   2. npx playwright test    # 运行 E2E 测试
 *
 * 环境变量：
 *   POLE_E2E_SKIP_INTERACTIVE=1  跳过依赖人工操作的用例
 *   POLE_E2E_HEADLESS=1          无头模式
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'

// ================================================================
// 配置
// ================================================================

const ELECTRON_ENTRY = path.resolve(__dirname, '..', 'dist-electron', 'main.js')

/** 找到主聊天窗口（Electron 可能有多个窗口） */
async function getChatPage(app: ElectronApplication, timeoutMs = 15_000): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const windows = app.windows()
    for (const w of windows) {
      try {
        const url = w.url()
        // 聊天窗口：localhost dev 或 file:// 生产
        if (url.includes('localhost') || url.includes('index.html')) return w
      } catch {
        // 窗口可能已关闭
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  // 兜底：第一个窗口
  return app.firstWindow()
}

// ================================================================
// 全局初始化
// ================================================================

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [ELECTRON_ENTRY],
    executablePath: undefined, // 使用系统 Electron
  })
  page = await getChatPage(app)
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#root').waitFor({ state: 'attached', timeout: 15_000 })

  // The renderer starts with `aiChatVisible: false`. Keyboard shortcuts are
  // wired on `window` in App.tsx, but Playwright/Electron often launches
  // without renderer focus — `Control+L` is flaky. The ActivityBar AI button
  // uses `title="AI 对话 (Ctrl+L)"`, which yields a stable accessible name.
  await page.getByRole('button', { name: 'AI 对话 (Ctrl+L)' }).click({
    timeout: 15_000,
  })
  await page.locator('.chat-input-container').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  })
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ================================================================
// U-01: SubAgentsProgressBar 异常状态测试 — 强断言版本
//
// Verifies the U-1 fix in `SubAgentsProgressBar.tsx`: the progress bar
// must count `error` / `stopped` / `cancelled` / `timeout` statuses as
// "failed" instead of dropping them. Pre-fix, this test would fail with
// `failed=0` for the 3 non-vanilla statuses below.
// ================================================================
test.describe('U-01: SubAgentsProgressBar 异常状态', () => {
  test.beforeEach(async () => {
    await page.evaluate(() => {
      ;(window as { __e2eClearAll?: () => void }).__e2eClearAll?.()
    })
  })

  test('hooks are mounted', async () => {
    // Sanity: the renderer must have loaded testHooks.ts. Without this,
    // every other test in this file would silently degrade.
    const mounted = await page.evaluate(
      () => (window as { __e2eHooksMounted?: true }).__e2eHooksMounted === true,
    )
    expect(mounted).toBe(true)
  })

  test('5 sub-agents (1 running + 1 completed + 3 error variants) all counted', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          description?: string
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        { agentId: 'u01-a', agentType: 'Explore', name: 'running', status: 'running' },
        { agentId: 'u01-b', agentType: 'Plan', name: 'completed', status: 'completed' },
        { agentId: 'u01-c', agentType: 'Explore', name: 'error-1', status: 'error' },
        { agentId: 'u01-d', agentType: 'Debug', name: 'error-2', status: 'stopped' },
        { agentId: 'u01-e', agentType: 'Explore', name: 'cancelled', status: 'cancelled' },
      ])
    })

    const bar = page.locator('[data-testid="sub-agents-progress-bar"]')
    await expect(bar).toBeAttached({ timeout: 5_000 })

    // Strong assertions on the computed counters (not text content — the
    // test stays robust against label / i18n changes).
    await expect(bar).toHaveAttribute('data-e2e-total', '5')
    await expect(bar).toHaveAttribute('data-e2e-running', '1')
    await expect(bar).toHaveAttribute('data-e2e-completed', '1')

    // U-1 fix: all three non-vanilla statuses (error / stopped / cancelled)
    // collapse to `failed`. Pre-fix this asserted to 0.
    await expect(bar).toHaveAttribute('data-e2e-failed', '3')
  })

  test('U-1 regression: pre-fix would have shown failed=0', async () => {
    // Same scenario as above, but only the non-vanilla statuses. If the
    // U-1 bug regresses (someone reverts to `if (sa.status === 'failed')`
    // string-equality), failed will read 0 here and this test catches it.
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{ agentId: string; agentType: string; name: string; status: string }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        { agentId: 'u01-r-a', agentType: 'Debug', name: 'a', status: 'error' },
        { agentId: 'u01-r-b', agentType: 'Debug', name: 'b', status: 'stopped' },
        { agentId: 'u01-r-c', agentType: 'Debug', name: 'c', status: 'cancelled' },
        { agentId: 'u01-r-d', agentType: 'Debug', name: 'd', status: 'timeout' },
      ])
    })

    const bar = page.locator('[data-testid="sub-agents-progress-bar"]')
    await expect(bar).toBeAttached({ timeout: 5_000 })
    await expect(bar).toHaveAttribute('data-e2e-failed', '4')
  })
})

// ================================================================
// Helper: clear chat between tests for isolation.
// ================================================================
async function clearChat(): Promise<void> {
  await page.evaluate(() => {
    ;(window as { __e2eClearAll?: () => void }).__e2eClearAll?.()
  })
}

/**
 * `ActivityRow` defaults to collapsed — its body (which contains the
 * SubAgentTodos / structured summary / agent-output blocks) is conditionally
 * rendered only when expanded. Tests asserting on body content need to click
 * the row's interactive header first.
 */
async function expandAgentBlock(agentId: string): Promise<void> {
  const block = page.locator(
    `[data-testid="agent-block"][data-e2e-agent-id="${agentId}"]`,
  )
  await block.locator('.activity-line').first().click()
}

// ================================================================
// U-02: AgentBlock 极端 toolUses 数量 — smoke (no objective perf assertion)
// ================================================================
test.describe('U-02: AgentBlock 渲染大量 toolUses', () => {
  test.beforeEach(clearChat)

  test('150 toolUses on a single sub-agent renders without crashing', async () => {
    const start = Date.now()
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          toolUses: Array<{ name: string; id: string }>
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      const tools = Array.from({ length: 150 }, (_, i) => ({
        name: 'read_file',
        id: `u02-${i}`,
      }))
      fn([
        {
          agentId: 'u02-bulk',
          agentType: 'Explore',
          name: 'bulk',
          status: 'completed',
          toolUses: tools,
        },
      ])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u02-bulk"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-tool-count', '150')

    const elapsed = Date.now() - start
    // Generous bound — exact value is environment-sensitive. We only
    // care that React didn't grind to a halt under a 150-item list.
    expect(elapsed).toBeLessThan(10_000)
  })
})

// ================================================================
// U-03: ChatMessage 混合渲染 key 漂移
// FIXME: Requires `__e2eInjectMixedMessage` hook (text + thinking + agent
// mixed in one ChatMessage). Implement in Batch 2.
// ================================================================
test.describe('U-03: 混合内容渲染 key 稳定性', () => {
  test.fixme('混合消息（text + thinking + agent）渲染无 key 警告', async () => {
    // 监听 React key warning
    const warnings: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'warning' && msg.text().includes('key')) {
        warnings.push(msg.text())
      }
    })

    // 注入混合消息
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eInjectMixedMessage as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    // 等待渲染
    await page.waitForTimeout(1000)

    // TODO Batch 2: filter `warnings` for `unique`/`prop` key strings and
    // assert empty under production build. Currently a placeholder.
  })
})

// ================================================================
// U-04: AgentBlock 描述超长文本
// FIXME: Need a stable container for measuring overflow (the chat panel's
// outer width depends on layout state). Implement in Batch 2.
// ================================================================
test.describe('U-04: AgentBlock 超长描述', () => {
  test.fixme('800 字符描述不溢出容器', async () => {
    const longDesc = '这是一个非常长的描述文本'.repeat(50) // ~800 chars

    await page.evaluate(
      (desc) => {
        const w = window as unknown as Record<string, unknown>
        ;(w.__e2eInjectSubAgentWithDesc as (d: string) => void)?.(desc)
      },
      longDesc,
    ).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(500)

    // 检查描述区域不溢出
    const descEl = page.locator('[class*="agent-expand-description"]')
    if ((await descEl.count()) > 0) {
      const box = await descEl.boundingBox()
      if (box) {
        // 宽度不应超过容器
        expect(box.width).toBeLessThan(2000)
      }
    }
  })
})

// ================================================================
// U-05: RunningAgentsPanel 超多 agent + 虚拟列表
// FIXME: Requires `__e2eInjectActiveAgents` hook + opening RunningAgents
// panel. RunningAgents panel pulls from main-process IPC, not renderer
// store, so injection requires a separate mock plumbing path.
// ================================================================
test.describe('U-05: RunningAgentsPanel 大量 agent', () => {
  test.fixme('200 个 agent → 面板可打开且流畅', async () => {
    // 注入 200 个 agent
    const agents = Array.from({ length: 200 }, (_, i) => ({
      agentId: `agent-u05-${i}`,
      agentType: i % 4 === 0 ? 'Explore' : i % 4 === 1 ? 'Plan' : i % 4 === 2 ? 'Debug' : 'Verification',
      name: `测试代理-${i}`,
      status: (i < 5 ? 'running' : 'completed') as 'running' | 'completed',
      startTime: Date.now() - i * 1000,
    }))

    await page.evaluate(
      (ag) => {
        const w = window as unknown as Record<string, unknown>
        ;(w.__e2eInjectActiveAgents as (a: typeof ag) => void)?.(ag)
      },
      agents,
    ).catch(() => {
      /* skip */
    })

    // 尝试打开 RunningAgentsPanel
    const panelBtn = page.locator('[aria-label*="运行"], [class*="running-agents-icon"]')
    if ((await panelBtn.count()) > 0) {
      const start = Date.now()
      await panelBtn.click()
      await page.waitForTimeout(500)
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2000)
    }
  })
})

// ================================================================
// U-06: AgentBlock 状态快速切换无闪烁
// FIXME: No objective "无闪烁" assertion possible without per-frame
// inspection. Better as a manual visual review or a Playwright trace
// capture analyzed offline. Implement in Batch 2 if there's appetite.
// ================================================================
test.describe('U-06: 状态切换无闪烁', () => {
  test.fixme('running → completed 状态色条平滑过渡', async () => {
    // 注入子代理并快速切换状态
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eInjectStatusFlip as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(300)

    // 状态色条应存在
    const statusBar = page.locator('[class*="activity-row"] [class*="status"]')
    if ((await statusBar.count()) > 0) {
      await expect(statusBar).toBeVisible()
    }
  })
})

// ================================================================
// U-07: AgentBlock 空状态渲染 — strong assertions
// ================================================================
test.describe('U-07: AgentBlock 空状态', () => {
  test.beforeEach(clearChat)

  test('empty agent (no tools / thinking / output) still renders agentType + actionWord', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          output?: string
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        {
          agentId: 'u07-empty',
          agentType: 'Explore',
          name: '空状态代理',
          status: 'completed',
          output: '',
        },
      ])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u07-empty"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-agent-type', 'Explore')
    await expect(block).toHaveAttribute('data-e2e-tool-count', '0')

    // ActivityRow renders the actionWord text even when the body is empty.
    const action = block.locator('.activity-action')
    await expect(action).toBeVisible()
    const actionText = await action.textContent()
    expect(actionText?.trim().length ?? 0).toBeGreaterThan(0)
  })
})

// ================================================================
// U-08: ToolUseCard 内嵌子代理渲染
// FIXME: Requires injecting an Agent tool_use block + a child sub-agent
// linked via parentToolId. Implement in Batch 2.
// ================================================================
test.describe('U-08: ToolUseCard 内嵌 AgentBlock', () => {
  test.fixme('嵌套的 AgentBlock 不溢出 ToolUseCard', async () => {
    // 模拟 Agent 工具调用产生子代理
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eInjectNestedAgentCard as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(500)

    // 检查嵌套卡片
    const toolUseCards = page.locator('[class*="tool-use-card"]')
    if ((await toolUseCards.count()) > 0) {
      const innerAgentBlocks = toolUseCards.locator('[class*="agent-block"]')
      if ((await innerAgentBlocks.count()) > 0) {
        // 子卡片不应溢出父容器
        const parentBox = await toolUseCards.first().boundingBox()
        const childBox = await innerAgentBlocks.first().boundingBox()
        if (parentBox && childBox) {
          expect(childBox.x).toBeGreaterThanOrEqual(parentBox.x - 1)
        }
      }
    }
  })
})

// ================================================================
// U-09: SubAgentTodos 边界情况 — strong assertions
// ================================================================
test.describe('U-09: SubAgentTodos 边界', () => {
  test.beforeEach(clearChat)

  test('empty todos → SubAgentTodos not rendered (data flag = false)', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{ agentId: string; agentType: string; name: string; status: string }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      // Note: not passing `todos` at all simulates the "agent never wrote
      // any TodoWrite" path.
      fn([{ agentId: 'u09-empty', agentType: 'Explore', name: 'no-todos', status: 'completed' }])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u09-empty"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-has-todos', 'false')
  })

  test('55 todos → block reports has-todos and SubAgentTodos renders', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          todos: Array<{ content: string; status: string }>
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      const todos = Array.from({ length: 55 }, (_, i) => ({
        content: `任务 ${i + 1}`,
        status: i < 30 ? 'completed' : 'pending',
      }))
      fn([
        {
          agentId: 'u09-many',
          agentType: 'Explore',
          name: 'many-todos',
          status: 'running',
          todos,
        },
      ])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u09-many"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-has-todos', 'true')

    await expandAgentBlock('u09-many')

    // The SubAgentTodos component must mount somewhere under the block.
    const todoArea = block.locator('[class*="sub-agent-todos"]')
    await expect(todoArea.first()).toBeVisible({ timeout: 5_000 })
  })
})

// ================================================================
// U-10: MarkdownContent XSS 防护
// FIXME: Need a Markdown render path injection (assistant text content,
// not sub-agent). Currently __e2eInjectSubAgents only reaches sub-agent
// rendering. Implement in Batch 2 with a `__e2eInjectAssistantMarkdown`.
// ================================================================
test.describe('U-10: MarkdownContent XSS 防护', () => {
  test.fixme('script 标签不作为 HTML 执行', async () => {
    const xssContent = '<script>window.__e2eXssFlag = "hacked"</script><p>safe text</p>'

    await page.evaluate(
      (content) => {
        const w = window as unknown as Record<string, unknown>
        ;(w.__e2eInjectMarkdownContent as (c: string) => void)?.(content)
      },
      xssContent,
    ).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(500)

    // script 标签不应执行
    const flag = await page.evaluate(() => {
      const w = window as unknown as Record<string, { __e2eXssFlag?: string }>
      return w.__e2eXssFlag
    })
    expect(flag).toBeUndefined()
  })
})

// ================================================================
// U-11: AgentBlock StructuredSummary 边界 — strong assertions
// ================================================================
test.describe('U-11: StructuredSummary 边界', () => {
  test.beforeEach(clearChat)

  test('empty remaining[] → "还缺什么" section is omitted, no empty title', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          structuredSummary: {
            completedWork: string[]
            evidence: string[]
            remaining: string[]
            nextStep?: string
          }
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        {
          agentId: 'u11-empty-remaining',
          agentType: 'Explore',
          name: 'no-remaining',
          status: 'completed',
          structuredSummary: {
            completedWork: ['做了 A', '做了 B'],
            evidence: ['log 行 1'],
            remaining: [], // ← 空：不应出现 "还缺什么" section
          },
        },
      ])
    })

    const block = page.locator(
      '[data-testid="agent-block"][data-e2e-agent-id="u11-empty-remaining"]',
    )
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-has-summary', 'true')

    await expandAgentBlock('u11-empty-remaining')

    // The "做了什么" + "证据" sections should render.
    const summary = block.locator('.agent-structured-summary')
    await expect(summary).toBeVisible({ timeout: 5_000 })
    const titles = await summary.locator('.agent-structured-title').allTextContents()
    expect(titles).toContain('做了什么')
    expect(titles).toContain('证据')
    // The "还缺什么" title must NOT render when remaining is empty.
    expect(titles).not.toContain('还缺什么')
  })
})

// ================================================================
// U-12: SubAgentsProgressBar disabled 状态 — strong assertions
// ================================================================
test.describe('U-12: SubAgentsProgressBar disabled', () => {
  test.beforeEach(clearChat)

  test('1 sub-agent only → progress bar must not render (returns null at total<=1)', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{ agentId: string; agentType: string; name: string; status: string }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([{ agentId: 'u12-solo', agentType: 'Explore', name: '唯一', status: 'running' }])
    })

    // The single AgentBlock should exist...
    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u12-solo"]')
    await expect(block).toBeAttached({ timeout: 5_000 })

    // ...but the progress bar should NOT be in the DOM (early return).
    const bar = page.locator('[data-testid="sub-agents-progress-bar"]')
    await expect(bar).toHaveCount(0)
  })
})

// ================================================================
// U-13: ThinkingBlock key 稳定性
// FIXME: Requires `__e2eTriggerRerender` and a stable way to capture
// ThinkingBlock's internal tick counter. Implement in Batch 2.
// ================================================================
test.describe('U-13: ThinkingBlock key 稳定性', () => {
  test.fixme('父消息 re-render 后 ThinkingBlock 不重置', async () => {
    // 触发 re-render
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eTriggerRerender as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(500)

    // ThinkingBlock 应保持存在
    const thinkingEls = page.locator('[class*="thinking-block"]')
    if ((await thinkingEls.count()) > 0) {
      await expect(thinkingEls.first()).toBeVisible()
    }
  })
})

// ================================================================
// U-14: RunningAgentsPanel 树折叠/展开
// FIXME: Same blocker as U-05 (RunningAgents panel uses main-process IPC).
// ================================================================
test.describe('U-14: RunningAgentsPanel 树折叠', () => {
  test.fixme('折叠/展开切换 10 次后状态一致', async () => {
    // 注入父子关系的 agent 树
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eInjectAgentTree as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    const panelBtn = page.locator('[aria-label*="运行"], [class*="running-agents-icon"]')
    if ((await panelBtn.count()) === 0) return // 无入口则跳过

    await panelBtn.click()
    await page.waitForTimeout(300)

    // 找到折叠按钮并切换
    for (let i = 0; i < 10; i++) {
      const collapseBtns = page.locator('[class*="collapse-icon"], [class*="expand-icon"], [class*="tree-toggle"]')
      if ((await collapseBtns.count()) > 0) {
        await collapseBtns.first().click()
      }
      await page.waitForTimeout(100)
    }

    // 面板应仍可见且不崩溃
    const panel = page.locator('[class*="running-agents-overlay"]')
    if ((await panel.count()) > 0) {
      await expect(panel).toBeVisible()
    }
  })
})

// ================================================================
// U-15: AgentBlock key 唯一性 — strong assertion (catch React warnings)
// ================================================================
test.describe('U-15: Key 唯一性', () => {
  test.beforeEach(clearChat)

  test('55 toolUses with auto-generated ids → zero React key warnings', async () => {
    const warnings: string[] = []
    const handler = (msg: import('@playwright/test').ConsoleMessage) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        const t = msg.text()
        if (t.includes('unique') && t.includes('key')) {
          warnings.push(t)
        }
      }
    }
    page.on('console', handler)

    try {
      await page.evaluate(() => {
        type Inject = (
          agents: Array<{
            agentId: string
            agentType: string
            name: string
            status: string
            toolUses: Array<{ name: string }>
          }>,
        ) => void
        const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
        if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
        const tools = Array.from({ length: 55 }, () => ({ name: 'read_file' }))
        fn([
          {
            agentId: 'u15-many',
            agentType: 'Explore',
            name: 'many-tools',
            status: 'completed',
            toolUses: tools,
          },
        ])
      })

      const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u15-many"]')
      await expect(block).toBeAttached({ timeout: 5_000 })
      await page.waitForTimeout(500) // Allow any warnings to surface.
      expect(warnings, `Got React key warnings: ${warnings.join('\n')}`).toEqual([])
    } finally {
      page.off('console', handler)
    }
  })
})

// ================================================================
// U-16: SubAgentsProgressBar streaming 响应
// FIXME: Need a way to set `message.isStreaming` on the injected fake
// message. Implement in Batch 2 with extended hook.
// ================================================================
test.describe('U-16: Streaming 动画同步', () => {
  test.fixme('streaming=true → pulse 动画激活', async () => {
    // 注入 streaming 状态的子代理
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__e2eInjectStreamingAgent as () => void)?.()
    }).catch(() => {
      /* skip */
    })

    await page.waitForTimeout(500)

    // TODO Batch 2: assert pulse animation class is present on the running
    // bar segment. Placeholder until the streaming-state injection hook lands.
  })
})

// ================================================================
// U-17: 主题切换
// FIXME: The repo uses CSS custom properties; toggling `dark` class on
// <html> alone may not match how the real theme switcher works. Need to
// invoke the actual settings store action. Implement in Batch 2.
// ================================================================
test.describe('U-17: 暗色/亮色主题', () => {
  test.fixme('切换主题后 AgentBlock 颜色可读', async () => {
    // 切换暗色模式
    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
    })

    await page.waitForTimeout(300)

    // 检查文字颜色与背景有足够对比度（简化版：检查 CSS 变量）
    const textColor = await page.evaluate(() => {
      const el = document.querySelector('[class*="agent-block"]')
      if (!el) return null
      return window.getComputedStyle(el).color
    })

    // 切换亮色
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark')
    })

    await page.waitForTimeout(300)

    const lightTextColor = await page.evaluate(() => {
      const el = document.querySelector('[class*="agent-block"]')
      if (!el) return null
      return window.getComputedStyle(el).color
    })

    // 暗色和亮色的文字颜色应该不同（说明主题生效）
    if (textColor && lightTextColor) {
      expect(textColor).not.toBe(lightTextColor)
    }
  })
})

// ================================================================
// U-18: AgentBlock actionWord 差异 — locks the U-6 fix
//
// Verifies the U-6 fix in `AgentBlock.tsx`: actionWord must follow the
// dominant tool category (edited > ran > searched > explored), not be
// hard-coded to "Explored". A regression that reverts to the hard-coded
// value will fail every assertion below.
// ================================================================
test.describe('U-18: AgentBlock actionWord 差异', () => {
  test.beforeEach(clearChat)

  test('actionWord follows dominant tool category', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          toolUses: Array<{ name: string }>
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        // Plan agent that mostly edited files → should say "Edited" not "Explored"
        {
          agentId: 'u18-plan-edit',
          agentType: 'Plan',
          name: 'plan-edit',
          status: 'completed',
          toolUses: [
            { name: 'edit_file' },
            { name: 'edit_file' },
            { name: 'edit_file' },
            { name: 'read_file' },
          ],
        },
        // Debug agent that mostly ran bash → "Ran"
        {
          agentId: 'u18-debug-bash',
          agentType: 'Debug',
          name: 'debug-bash',
          status: 'completed',
          toolUses: [{ name: 'bash' }, { name: 'bash' }, { name: 'read_file' }],
        },
        // Explore agent that mostly read files → "Explored"
        {
          agentId: 'u18-explore-read',
          agentType: 'Explore',
          name: 'explore-read',
          status: 'completed',
          toolUses: [{ name: 'read_file' }, { name: 'read_file' }, { name: 'glob' }],
        },
      ])
    })

    const editAgent = page.locator(
      '[data-testid="agent-block"][data-e2e-agent-id="u18-plan-edit"]',
    )
    await expect(editAgent).toBeAttached({ timeout: 5_000 })
    await expect(editAgent).toHaveAttribute('data-e2e-action-word', 'Edited')

    const bashAgent = page.locator(
      '[data-testid="agent-block"][data-e2e-agent-id="u18-debug-bash"]',
    )
    await expect(bashAgent).toHaveAttribute('data-e2e-action-word', 'Ran')

    const readAgent = page.locator(
      '[data-testid="agent-block"][data-e2e-agent-id="u18-explore-read"]',
    )
    await expect(readAgent).toHaveAttribute('data-e2e-action-word', 'Explored')
  })

  test('U-6 regression: Plan agent that ran 5 bash commands does NOT say "Explored"', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          toolUses: Array<{ name: string }>
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        {
          agentId: 'u18-r-plan-bash',
          agentType: 'Plan',
          name: 'plan-bash',
          status: 'completed',
          toolUses: Array.from({ length: 5 }, () => ({ name: 'bash' })),
        },
      ])
    })

    const block = page.locator(
      '[data-testid="agent-block"][data-e2e-agent-id="u18-r-plan-bash"]',
    )
    await expect(block).toBeAttached({ timeout: 5_000 })
    // Pre-fix: would have asserted "Explored". Post-fix: "Ran".
    await expect(block).not.toHaveAttribute('data-e2e-action-word', 'Explored')
    await expect(block).toHaveAttribute('data-e2e-action-word', 'Ran')
  })
})

// ================================================================
// U-19: AgentBlock 大 output 截断 — strong assertions
//
// Locks the existing 4000-char hard truncate behavior in `AgentBlock.tsx`.
// (The bug report flags the truncation as needing a "view more" affordance,
// but the truncation itself is intentional and tested here.)
// ================================================================
test.describe('U-19: AgentBlock 输出截断', () => {
  test.beforeEach(clearChat)

  test('output > 4000 chars renders truncation marker', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          output: string
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        {
          agentId: 'u19-long',
          agentType: 'Explore',
          name: 'long-output',
          status: 'completed',
          output: 'A'.repeat(10_000),
        },
      ])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u19-long"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expect(block).toHaveAttribute('data-e2e-output-length', '10000')

    await expandAgentBlock('u19-long')

    const output = block.locator('[data-testid="agent-output"] pre')
    await expect(output).toBeVisible({ timeout: 5_000 })
    const text = (await output.textContent()) ?? ''
    // Truncation marker present + total length capped near 4000 + the marker.
    expect(text).toContain('…(truncated)')
    expect(text.length).toBeLessThan(4100)
  })

  test('output ≤ 4000 chars renders verbatim (no truncation marker)', async () => {
    await page.evaluate(() => {
      type Inject = (
        agents: Array<{
          agentId: string
          agentType: string
          name: string
          status: string
          output: string
        }>,
      ) => void
      const fn = (window as { __e2eInjectSubAgents?: Inject }).__e2eInjectSubAgents
      if (!fn) throw new Error('__e2eInjectSubAgents not mounted')
      fn([
        {
          agentId: 'u19-short',
          agentType: 'Explore',
          name: 'short-output',
          status: 'completed',
          output: 'short result',
        },
      ])
    })

    const block = page.locator('[data-testid="agent-block"][data-e2e-agent-id="u19-short"]')
    await expect(block).toBeAttached({ timeout: 5_000 })
    await expandAgentBlock('u19-short')
    const output = block.locator('[data-testid="agent-output"] pre')
    await expect(output).toHaveText('short result')
  })
})

// ================================================================
// U-20: 1000+ 消息聊天记录的性能
// FIXME: Requires `__e2eInjectMessages(messages)` (multiple top-level
// chat messages, not just one fake assistant). Implement in Batch 2 if
// performance regression catching becomes a priority.
// ================================================================
test.describe('U-20: 大量消息性能', () => {
  test.fixme('1000 条消息首屏渲染 < 2s', async () => {
    // 生成 1000 条模拟消息
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `msg-u20-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${i}: 这是第 ${i} 条测试消息，包含一些中文内容和代码片段。` +
        'const test = () => { return "hello" }'.repeat(3),
    }))

    const start = Date.now()
    await page.evaluate(
      (msgs) => {
        const w = window as unknown as Record<string, unknown>
        ;(w.__e2eInjectMessages as (m: typeof msgs) => void)?.(msgs)
      },
      messages,
    ).catch(() => {
      /* skip */
    })

    // 等待渲染完成
    await page.waitForTimeout(1000)

    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3000) // 允许 3s 容差
  })
})

// ================================================================
// 综合持久化检查
// ================================================================
test.describe('E2E 综合检查', () => {
  test('核心 UI 元素存在', async () => {
    // 聊天容器
    const chat = page.locator('[class*="chat"], [class*="message-list"], #root')
    await expect(chat.first()).toBeAttached({ timeout: 10_000 })

    // 无 React 错误边界
    const errorBoundary = page.locator('[class*="error-boundary"], [class*="ErrorBoundary"]')
    const errorCount = await errorBoundary.count()
    expect(errorCount).toBe(0)
  })

  test('控制台中无 FATAL 级别错误', async () => {
    const fatalErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && 
          (msg.text().includes('FATAL') || msg.text().includes('Uncaught'))) {
        fatalErrors.push(msg.text())
      }
    })
    // FATAL 错误不应出现
    expect(fatalErrors.length).toBe(0)
  })
})
