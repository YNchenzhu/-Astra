/**
 * Contract tests for the declared-intent guard (2026-06 multi-turn degradation fix).
 *
 * Covers Symptom 2 ("AI declares intent but stops without acting"):
 *   - Pattern matching: Chinese and English intent phrasings
 *   - Exemption patterns: questions, completion statements
 *   - One-shot nudge budget: second occurrence on same turn is suppressed
 *   - Multi-round behavior: nudgeCount reset on next user turn
 *
 * And Symptom 3 interaction:
 *   - Thinking blocks are NOT scanned (only accumulatedText is checked)
 *   - So a model that declares intent ONLY in thinking will NOT trigger the guard
 */

import { describe, expect, it } from 'vitest'
import {
  detectDeclaredIntentTail,
  hasExemptDeclaredIntentTail,
  isDeclaredIntentGuardEnabled,
  buildDeclaredIntentDirective,
  DECLARED_INTENT_MARKER,
} from './declaredIntentGuard'

// ─────────────────────────────────────────────────────────────────────
// Pattern matching: Chinese intent phrasings
// ─────────────────────────────────────────────────────────────────────

describe('detectDeclaredIntentTail — Chinese patterns', () => {
  it('detects "我现在开始修改" as intent', () => {
    expect(detectDeclaredIntentTail('好，我现在开始修改 src/main.ts 这个文件')).toBe(true)
  })

  it('detects "我马上执行" as intent', () => {
    expect(detectDeclaredIntentTail('了解，我马上执行修复')).toBe(true)
  })

  it('detects "我来修改" as intent', () => {
    expect(detectDeclaredIntentTail('好的，让我来修改配置文件')).toBe(true)
  })

  it('detects "我将运行" as intent', () => {
    expect(detectDeclaredIntentTail('现在我将运行测试来验证修改')).toBe(true)
  })

  it('does NOT detect "下一步进行" (verb "进行" not in direction-verb list)', () => {
    // Regex /下一步(?:我)?(?:将|会|是|要)/ — "进行" doesn't match 将|会|是|要
    expect(detectDeclaredIntentTail('分析完毕，下一步进行代码修复')).toBe(false)
  })

  it('does NOT detect "随后处理" without "我" prefix', () => {
    // Regex /我(?:现在|马上|这就|立刻|接下来|随后)/ — requires "我" prefix
    expect(detectDeclaredIntentTail('已读取文件，随后处理错误日志')).toBe(false)
  })

  it('does NOT detect "接下来我实现" (verb "实现" not in direction-verb list)', () => {
    // Regex /接下来(?:我)?(?:将|会|是|要)/ — "实现" doesn't match 将|会|是|要
    expect(detectDeclaredIntentTail('设计方案已确定，接下来我实现这个功能')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2026-07 screenshot fix — "现在修正：" family + dangling-colon tail
// ─────────────────────────────────────────────────────────────────────

describe('detectDeclaredIntentTail — 现在/马上+动词直连 (2026-07 fix)', () => {
  it('detects "现在修正：" (the screenshot case)', () => {
    expect(
      detectDeclaredIntentTail('直接违反了这条铁律。项目背景应为三段递进式连续段落，不需要任何子标题。现在修正：'),
    ).toBe(true)
  })

  it('detects 现在实施 / 马上修改 / 马上实施 / 马上补充', () => {
    expect(detectDeclaredIntentTail('方案确定。现在实施：')).toBe(true)
    expect(detectDeclaredIntentTail('问题已定位，马上修改：')).toBe(true)
    expect(detectDeclaredIntentTail('按此方案马上实施')).toBe(true)
    expect(detectDeclaredIntentTail('遗漏了两处，马上补充')).toBe(true)
  })

  it('detects the new verbs without colon too (现在调整 / 立刻完善 / 这就优化)', () => {
    expect(detectDeclaredIntentTail('样式不对，现在调整')).toBe(true)
    expect(detectDeclaredIntentTail('文档缺章节，立刻完善')).toBe(true)
    expect(detectDeclaredIntentTail('性能太差，这就优化')).toBe(true)
  })
})

describe('detectDeclaredIntentTail — dangling-colon tail (language-agnostic)', () => {
  it('a visible reply ending on a colon fires regardless of verb', () => {
    expect(detectDeclaredIntentTail('修改如下：')).toBe(true)
    expect(detectDeclaredIntentTail('下面开始修改：')).toBe(true)
    expect(detectDeclaredIntentTail('The corrected version:')).toBe(true)
    expect(detectDeclaredIntentTail('修正方案：**')).toBe(true) // markdown closer after colon
  })

  it('exemptions still run first (question / confirmation tails end the turn)', () => {
    expect(detectDeclaredIntentTail('请确认以下事项：')).toBe(false)
    expect(detectDeclaredIntentTail('需要我继续处理下一个文件吗？')).toBe(false)
  })

  it("the colon rule does NOT apply to the 'thinking' source", () => {
    // Thinking routinely ends with a colon right before composing the
    // visible reply — that is reply composition, not a dangling commitment.
    expect(detectDeclaredIntentTail('接下来的回复结构：', 'thinking')).toBe(false)
  })

  it('a colon in the middle of the tail does not fire', () => {
    expect(detectDeclaredIntentTail('注意：所有修改均已验证通过，无需进一步操作')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pattern matching: English intent phrasings
// ─────────────────────────────────────────────────────────────────────

describe('detectDeclaredIntentTail — English patterns', () => {
  it("detects \"I'll now start\" as intent", () => {
    expect(detectDeclaredIntentTail("Alright, I'll now start modifying the file.")).toBe(true)
  })

  it("detects \"Let me now run\" as intent", () => {
    expect(detectDeclaredIntentTail("Let me now run the test suite to verify.")).toBe(true)
  })

  it("detects \"I'm going to edit\" as intent", () => {
    expect(detectDeclaredIntentTail("I'm going to edit the configuration now.")).toBe(true)
  })

  it("detects \"Next, I will update\" as intent", () => {
    expect(detectDeclaredIntentTail("Next, I will update the dependencies.")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Exemption patterns: these should NOT trigger the guard
// ─────────────────────────────────────────────────────────────────────

describe('detectDeclaredIntentTail — exemption patterns', () => {
  it('does NOT trigger on questions ending with ?', () => {
    expect(detectDeclaredIntentTail('需要我修改这个文件吗？')).toBe(false)
  })

  it('does NOT trigger on questions ending with ？', () => {
    expect(detectDeclaredIntentTail('是否需要运行测试？')).toBe(false)
  })

  it('does NOT trigger on completion statement "已完成"', () => {
    expect(detectDeclaredIntentTail('所有修改已完成')).toBe(false)
  })

  it('does NOT trigger on "已处理"', () => {
    expect(detectDeclaredIntentTail('异常已处理')).toBe(false)
  })

  it('does NOT trigger on "all done"', () => {
    expect(detectDeclaredIntentTail("That's all done, everything is fixed.")).toBe(false)
  })

  it('does NOT trigger on "completed"', () => {
    expect(detectDeclaredIntentTail('The task is completed successfully.')).toBe(false)
  })

  it('does NOT trigger on "finished"', () => {
    expect(detectDeclaredIntentTail('All changes finished and verified.')).toBe(false)
  })

  it('does NOT trigger on asking the user "should I"', () => {
    expect(detectDeclaredIntentTail('Should I proceed with the migration?')).toBe(false)
  })

  it('does NOT trigger on "请告诉我"', () => {
    expect(detectDeclaredIntentTail('请告诉我是否需要继续')).toBe(false)
  })

  it('does NOT trigger on "需要我继续吗"', () => {
    expect(detectDeclaredIntentTail('需要我继续处理下一个文件吗')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────

describe('detectDeclaredIntentTail — edge cases', () => {
  it('returns false for empty text', () => {
    expect(detectDeclaredIntentTail('')).toBe(false)
  })

  it('returns false for whitespace-only text', () => {
    expect(detectDeclaredIntentTail('   \n  ')).toBe(false)
  })

  it('only scans the tail window (last INTENT_TAIL_WINDOW_CHARS chars)', () => {
    // Build a long text where the intent phrase is in the MIDDLE, not the tail
    const prefix = '已完成所有修改，文件已更新，测试已通过。'.repeat(20)
    const middle = '我现在开始修改文件 X' // This is in the middle, beyond the tail window
    const suffix = '所有任务已完成，没有需要继续的操作。' // benign tail
    const longText = prefix + middle + suffix
    // The tail should be the benign suffix, so no intent detected
    expect(detectDeclaredIntentTail(longText)).toBe(false)
  })

  it('detects intent when it IS in the tail window (with correct pattern)', () => {
    // Intent phrase at end using a pattern that the regex actually matches
    // Pattern: /让我(?:[^，。！？\n]{0,12})?(?:开始|进行|执行|修改|创建|...)/ — "让我来修改" matches
    const prefix = 'x'.repeat(500) // push the intent to the tail
    const suffix = '让我来修改配置文件' // this matches the second pattern
    const text = prefix + suffix
    // The tail (last 240 chars) contains the intent phrase
    expect(detectDeclaredIntentTail(text)).toBe(true)
  })

  it('intent phrase with question mark is exempt even if pattern matches', () => {
    // Intent pattern matches "我马上修改" but there's also a question
    expect(detectDeclaredIntentTail('文件已分析，我马上修改可以吗？')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Guard enable/disable
// ─────────────────────────────────────────────────────────────────────

describe('isDeclaredIntentGuardEnabled', () => {
  it('is ENABLED by default', () => {
    // No env var set → default enabled
    // We can't easily test this in-process without mocking process.env
    // but we trust the default
    const enabled = isDeclaredIntentGuardEnabled()
    expect(enabled).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Directive body content
// ─────────────────────────────────────────────────────────────────────

describe('buildDeclaredIntentDirective', () => {
  it('contains the marker string for test/telemetry grep', () => {
    const directive = buildDeclaredIntentDirective()
    expect(directive).toContain(DECLARED_INTENT_MARKER)
  })

  it('mentions executing tools or explaining why not', () => {
    const directive = buildDeclaredIntentDirective()
    expect(directive).toMatch(/execute|tool|tell the user/i)
  })

  it('warns against describing work without tool evidence', () => {
    const directive = buildDeclaredIntentDirective()
    expect(directive).toContain('without tool evidence')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Multi-turn behavior: one-shot budget simulation
// ─────────────────────────────────────────────────────────────────────

describe('declared intent guard — one-shot budget simulation', () => {
  it('first detection fires guard, second detection on same turn is suppressed', () => {
    // Simulate state.declaredIntentNudgeCount
    let nudgeCount = 0

    // First occurrence: guard should fire
    const firstIntent = detectDeclaredIntentTail('我现在开始修改文件')
    const firstGuard =
      isDeclaredIntentGuardEnabled() &&
      nudgeCount === 0 &&
      firstIntent
        ? { directiveBody: buildDeclaredIntentDirective() }
        : undefined
    expect(firstGuard).toBeDefined()
    nudgeCount += 1 // budget spent

    // Second occurrence: guard should NOT fire
    const secondIntent = detectDeclaredIntentTail('我接下来运行测试')
    const secondGuard =
      isDeclaredIntentGuardEnabled() &&
      nudgeCount === 0 && // false! budget exhausted
      secondIntent
        ? { directiveBody: buildDeclaredIntentDirective() }
        : undefined
    expect(secondGuard).toBeUndefined()
  })

  it('exempt phrase bypasses guard without consuming budget', () => {
    const nudgeCount = 0

    // Completion statement: exempt, no guard, no budget spend
    const exempt = detectDeclaredIntentTail('所有修改已完成')
    const guard =
      isDeclaredIntentGuardEnabled() &&
      nudgeCount === 0 &&
      exempt
        ? { directiveBody: buildDeclaredIntentDirective() }
        : undefined
    expect(guard).toBeUndefined()
    // Budget NOT spent (exempt)
    expect(nudgeCount).toBe(0)
  })

  it('question tail exempts guard without consuming budget', () => {
    const nudgeCount = 0

    const question = detectDeclaredIntentTail('需要我修改这个文件吗？')
    const guard =
      isDeclaredIntentGuardEnabled() &&
      nudgeCount === 0 &&
      question
        ? { directiveBody: buildDeclaredIntentDirective() }
        : undefined
    expect(guard).toBeUndefined()
    expect(nudgeCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Symptom 3 interaction: thinking-only intent IS now caught at the call
// site (2026-06 fix — noTools.ts scans the LAST thinking block's tail
// when accumulatedText is empty; the detector itself stays a pure
// string-tail scan)
// ─────────────────────────────────────────────────────────────────────

describe('Symptom 3 interaction: thinking-tail fallback at the noTools call site', () => {
  it('detector is a pure string scan — empty input never fires', () => {
    expect(detectDeclaredIntentTail('')).toBe(false)
  })

  it('thinking tail with declared intent fires when used as the scan source', () => {
    // noTools.ts now selects the scan source as:
    //   accumulatedText.trim() ? accumulatedText : lastThinkingBlock.thinking
    // so a thinking-only turn ending in a declaration is caught.
    const lastThinkingTail = '…分析完成。我现在开始修改文件 X'
    expect(detectDeclaredIntentTail(lastThinkingTail)).toBe(true)
  })

  it('mirror of the noTools scan logic (2026-07 uplift #16 — thinking tail is ALWAYS scanned unless the visible tail ends the turn)', () => {
    const wouldFire = (accumulatedText: string, lastThinking: string | undefined) =>
      detectDeclaredIntentTail(accumulatedText) ||
      (!hasExemptDeclaredIntentTail(accumulatedText) &&
        detectDeclaredIntentTail(lastThinking ?? '', 'thinking'))

    // thinking-only turn → thinking tail is scanned → guard fires
    expect(wouldFire('', '我接下来将运行测试验证')).toBe(true)
    // visible tail is a completion claim → turn ends legitimately; a
    // leftover thinking commitment must NOT override it
    expect(wouldFire('已完成所有修改。', '我现在开始修改文件')).toBe(false)
    // visible tail is a question to the user → same exemption
    expect(wouldFire('需要我继续处理其他文件吗？', '我接下来将运行测试')).toBe(false)
    // NEW (#16): visible text present but non-exempt (plan narration) +
    // thinking ends with a commitment → fires now (used to be missed)
    expect(wouldFire('整体方案如上，分三步进行。', '好，我接下来将运行测试验证')).toBe(true)
    // nothing at all → no fire
    expect(wouldFire('', undefined)).toBe(false)
  })

  it('completion claim in text stays exempt (P3 is handled by claim downgrade, not this guard)', () => {
    expect(detectDeclaredIntentTail('已完成所有修改')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2026-07 uplift #16 — thinking-source scanning semantics
// ─────────────────────────────────────────────────────────────────────

describe("detectDeclaredIntentTail(source: 'thinking') — reply-composition exemption", () => {
  it('reply-composition phrasings in thinking are exempt (row 12e territory)', () => {
    expect(detectDeclaredIntentTail('分析完毕，让我组织一下回答', 'thinking')).toBe(false)
    expect(detectDeclaredIntentTail('好，我现在写出最终回答', 'thinking')).toBe(false)
    expect(
      detectDeclaredIntentTail("All checks passed. Now I'll write the final answer", 'thinking'),
    ).toBe(false)
    expect(
      detectDeclaredIntentTail('Let me draft the response for the user', 'thinking'),
    ).toBe(false)
  })

  it('genuine tool commitments in thinking still fire', () => {
    expect(detectDeclaredIntentTail('分析完毕，我现在开始修改 src/main.ts', 'thinking')).toBe(true)
    expect(
      detectDeclaredIntentTail("The root cause is clear. I'll now run the tests", 'thinking'),
    ).toBe(true)
  })

  it("the 'text' source does NOT apply the composition exemption (visible commitments stay caught)", () => {
    // Announcing "I'll write the summary" in the VISIBLE reply and stopping
    // IS a dangling commitment — behaviour unchanged from pre-#16.
    expect(detectDeclaredIntentTail("I'll now write the summary of changes")).toBe(true)
  })

  it('question / completion exemptions apply to thinking too', () => {
    expect(detectDeclaredIntentTail('我接下来要修改文件，但需要用户确认吗？', 'thinking')).toBe(false)
    expect(detectDeclaredIntentTail('已完成所有修改', 'thinking')).toBe(false)
  })
})

describe('hasExemptDeclaredIntentTail', () => {
  it('true for question and completion tails, false for plain narration', () => {
    expect(hasExemptDeclaredIntentTail('需要我继续吗？')).toBe(true)
    expect(hasExemptDeclaredIntentTail('已完成所有修改')).toBe(true)
    expect(hasExemptDeclaredIntentTail('整体方案分三步。')).toBe(false)
    expect(hasExemptDeclaredIntentTail('')).toBe(false)
  })
})
