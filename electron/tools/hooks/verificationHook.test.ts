import { describe, it, expect } from 'vitest'
import { isResearchPhaseTodoSubject } from './verificationHook'

describe('isResearchPhaseTodoSubject', () => {
  it('matches exploration / architecture style Chinese todos', () => {
    expect(
      isResearchPhaseTodoSubject(
        '探索项目关键模块：入口点、SDK协议、Direct Connect、Agent系统、工具系统',
      ),
    ).toBe(true)
    expect(isResearchPhaseTodoSubject('调研 auth 流程')).toBe(true)
    expect(isResearchPhaseTodoSubject('只读分析 package.json')).toBe(true)
  })

  it('matches simple-fix / config / doc subjects (per stated low-risk policy)', () => {
    // The regex INTENTIONALLY exempts simple fixes / config / docs from the
    // verification gate — see the docstring above `RESEARCH_PHASE_SUBJECT_RE`
    // ("覆盖：纯研究探索、简单修复（单文件/Bug fix）、配置变更、文档更新等低风险任务").
    // These previously failed the gate; that was the whole point of the
    // policy expansion.
    expect(isResearchPhaseTodoSubject('修复登录 500 错误')).toBe(true)
    expect(isResearchPhaseTodoSubject('更新 README 文档')).toBe(true)
    expect(isResearchPhaseTodoSubject('调整 tsconfig 配置')).toBe(true)
  })

  it('does not match heavy implementation-style todos that require verification', () => {
    // "实现"（implement）, "重构"（refactor）, feature work — these still
    // demand test/Verification evidence before the gate lets them complete.
    expect(isResearchPhaseTodoSubject('实现用户设置页')).toBe(false)
    expect(isResearchPhaseTodoSubject('开发支付审批流')).toBe(false)
    expect(isResearchPhaseTodoSubject('重构订单中心服务')).toBe(false)
  })
})

// Audit 2026-05: `evaluateTodoWriteCompletionGate` was deleted as
// dead code (it pass-through'd for every input because no path
// created the `source: 'todo_sync'` TaskManager rows it checked).
// `isResearchPhaseTodoSubject` is retained because it has
// independent consumers (verifier-after-N nudge, custom hooks).
