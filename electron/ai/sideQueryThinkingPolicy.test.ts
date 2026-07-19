/**
 * Side-query thinking policy 防回归测试。
 *
 * 这个测试的目的不是验证常量值（一行代码不会出 bug），而是确保它的引用
 * 不被未来重构悄悄删除 — 任何把 `SIDE_QUERY_ALWAYS_THINKING` 改回 `true`
 * 或把它从某个旁路调用点移除的 PR 都会让其它防回归测试挂。
 *
 * 配套位置：
 *   - electron/context/compact.ts — autoCompact 摘要器
 *   - electron/memory/findRelevantMemories.ts — runSideQueryAttempt
 *   - electron/memory/autoExtract.ts — auto-extract 草稿器
 *   - electron/agents/agentExperienceMemory.ts — agent 经验笔记
 *   - electron/ai/toolUseSummary.ts — 工具结果汇总
 *   - electron/autocomplete/handler.ts — Tab 自动补全
 *   - electron/context/contextCollapseAuto.ts — 自动折叠摘要
 */

import { describe, expect, it } from 'vitest'
import { SIDE_QUERY_ALWAYS_THINKING } from './sideQueryThinkingPolicy'

describe('sideQueryThinkingPolicy', () => {
  it('SIDE_QUERY_ALWAYS_THINKING is always false', () => {
    expect(SIDE_QUERY_ALWAYS_THINKING).toBe(false)
  })

  it('SIDE_QUERY_ALWAYS_THINKING is typed as literal false', () => {
    // 类型层面也保护：常量类型是 `false`，不是 `boolean`。
    // 如果有人改成 `let SIDE_QUERY_ALWAYS_THINKING = false`，
    // 类型就会拓宽到 `boolean`，下面这个 narrowing 比较会失败。
    const v: false = SIDE_QUERY_ALWAYS_THINKING
    expect(v).toBe(false)
  })
})
