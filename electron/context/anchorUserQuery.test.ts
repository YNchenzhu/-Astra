import { describe, expect, it } from 'vitest'
import {
  anchorCurrentUserQuery,
  extractCurrentUserQueryText,
  findLastOrdinaryUserIndex,
  USER_QUERY_CLOSE_TAG,
  USER_QUERY_OPEN_TAG,
} from './anchorUserQuery'

const OPEN = USER_QUERY_OPEN_TAG
const CLOSE = USER_QUERY_CLOSE_TAG

describe('anchorCurrentUserQuery — 基本包裹', () => {
  it('wraps the last ordinary user message (string content)', () => {
    const out = anchorCurrentUserQuery([
      { role: 'user', content: '<system-reminder type="user-meta-context">\nbg\n</system-reminder>' },
      { role: 'user', content: '测试30种工具' },
    ])
    expect(out[0]!.content).toContain('<system-reminder')
    expect(out[0]!.content).not.toContain(OPEN)
    expect(out[1]!.content).toBe(`${OPEN}\n测试30种工具\n${CLOSE}`)
  })

  it('wraps the LAST user turn, not earlier history turns', () => {
    const out = anchorCurrentUserQuery([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second turn' },
    ])
    expect(out[0]!.content).toBe('first turn')
    expect(out[2]!.content).toBe(`${OPEN}\nsecond turn\n${CLOSE}`)
  })

  it('skips trailing host-envelope user messages (<system-reminder>)', () => {
    const out = anchorCurrentUserQuery([
      { role: 'user', content: 'real query' },
      { role: 'user', content: '<system-reminder>\n[Sub-agent update]\n</system-reminder>' },
    ])
    expect(out[0]!.content).toBe(`${OPEN}\nreal query\n${CLOSE}`)
    expect(out[1]!.content).not.toContain(OPEN)
  })

  it('skips user messages that only carry tool_result blocks', () => {
    const out = anchorCurrentUserQuery([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'glob', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
    expect(out[0]!.content).toBe(`${OPEN}\ndo the thing\n${CLOSE}`)
    expect(JSON.stringify(out[2]!.content)).not.toContain(OPEN)
  })
})

describe('anchorCurrentUserQuery — 合并消息（envelope 感知 span）', () => {
  it('首轮形态：reminder 前缀与用户文本被 merge 成单条字符串 → 只包用户文本', () => {
    // `mergeConsecutiveUserMessages` 在 anchor 之前运行：首轮 renderer 的
    // 上下文 reminder 消息与用户真实消息相邻，被合并成一条字符串。
    const merged =
      '<system-reminder>\nAs you answer... # workspace\nG:/demo\n</system-reminder>\n\n测试30种工具'
    const out = anchorCurrentUserQuery([{ role: 'user', content: merged }])
    expect(out[0]!.content).toBe(
      `<system-reminder>\nAs you answer... # workspace\nG:/demo\n</system-reminder>\n\n${OPEN}\n测试30种工具\n${CLOSE}`,
    )
  })

  it('首轮形态可幂等往返（strip 还原 → 再 wrap 一致）', () => {
    const merged = '<system-reminder>\nbg\n</system-reminder>\n\nreal ask'
    const once = anchorCurrentUserQuery([{ role: 'user', content: merged }])
    const twice = anchorCurrentUserQuery(once)
    expect(twice).toEqual(once)
  })

  it('envelope 在文本之后（尾随 reminder）→ 闭合标签落在用户文本末尾、envelope 之外', () => {
    const text = 'do the task\n\n<system-reminder>\ntrailing note\n</system-reminder>'
    const out = anchorCurrentUserQuery([{ role: 'user', content: text }])
    expect(out[0]!.content).toBe(
      `${OPEN}\ndo the task\n${CLOSE}\n\n<system-reminder>\ntrailing note\n</system-reminder>`,
    )
  })

  it('未闭合的 envelope 延伸到结尾 → 整条视为非普通文本，不包', () => {
    const input = [{ role: 'user', content: '<system-reminder>\nunclosed...' }]
    expect(anchorCurrentUserQuery(input)).toEqual(input)
  })
})

describe('anchorCurrentUserQuery — 块数组内容', () => {
  it('opens at the first ordinary text block and closes at the last', () => {
    const out = anchorCurrentUserQuery([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看下这张图' },
          { type: 'image', source: { data: 'x' } },
          { type: 'text', text: '按它改样式' },
        ],
      },
    ])
    const blocks = out[0]!.content as Array<{ type: string; text?: string }>
    expect(blocks[0]!.text).toBe(`${OPEN}\n看下这张图`)
    expect(blocks[1]!.type).toBe('image')
    expect(blocks[2]!.text).toBe(`按它改样式\n${CLOSE}`)
  })

  it('single ordinary text block gets both tags', () => {
    const out = anchorCurrentUserQuery([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nbg\n</system-reminder>' },
          { type: 'text', text: 'real ask' },
        ],
      },
    ])
    const blocks = out[0]!.content as Array<{ text?: string }>
    expect(blocks[0]!.text).not.toContain(OPEN)
    expect(blocks[1]!.text).toBe(`${OPEN}\nreal ask\n${CLOSE}`)
  })
})

describe('anchorCurrentUserQuery — 幂等与自愈', () => {
  it('is idempotent (double application yields identical payload)', () => {
    const input = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ]
    const once = anchorCurrentUserQuery(input)
    const twice = anchorCurrentUserQuery(once)
    expect(twice).toEqual(once)
  })

  it('strips a stale anchor from an older replayed turn before re-anchoring', () => {
    // Simulates persisted history that accidentally retained a wire wrap.
    const out = anchorCurrentUserQuery([
      { role: 'user', content: `${OPEN}\nold turn\n${CLOSE}` },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'new turn' },
    ])
    expect(out[0]!.content).toBe('old turn')
    expect(out[2]!.content).toBe(`${OPEN}\nnew turn\n${CLOSE}`)
  })

  it('does not mutate the input messages', () => {
    const input = [{ role: 'user', content: 'q' }]
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input
    anchorCurrentUserQuery(input)
    expect(input).toEqual(snapshot)
  })

  it('leaves user-typed tag text mid-message alone when stripping', () => {
    const body = `请解释 ${OPEN} 这个标签的作用`
    const out = anchorCurrentUserQuery([{ role: 'user', content: body }])
    expect(out[0]!.content).toBe(`${OPEN}\n${body}\n${CLOSE}`)
    // Round-trip: re-anchoring restores the same payload (inner tag intact).
    const again = anchorCurrentUserQuery(out)
    expect(again).toEqual(out)
  })
})

describe('anchorCurrentUserQuery — 边界', () => {
  it('returns messages unchanged when no ordinary user text exists', () => {
    const input = [
      { role: 'user', content: '<system-reminder>\nonly bg\n</system-reminder>' },
      { role: 'assistant', content: 'a' },
    ]
    const out = anchorCurrentUserQuery(input)
    expect(out).toEqual(input)
  })

  it('handles an empty message list', () => {
    expect(anchorCurrentUserQuery([])).toEqual([])
  })
})

// ─── F1 (2026-07 会话审计) — kernel_user_input 提取层特例 ───────────────

describe('extractCurrentUserQueryText / findLastOrdinaryUserIndex — kernel_user_input (F1)', () => {
  const kernelInputMsg = {
    role: 'user',
    content:
      '<system-reminder>\n[User message (mid-turn)]\n改成先修登录 bug，退款之后再说\n</system-reminder>',
    _convertedFromSystem: true,
    _sideChannelKind: 'kernel_user_input',
  }

  it('extractCurrentUserQueryText returns the unwrapped mid-turn user body as the current query', () => {
    const text = extractCurrentUserQueryText([
      { role: 'user', content: '重构退款逻辑' },
      { role: 'assistant', content: 'working' },
      kernelInputMsg,
    ])
    expect(text).toBe('改成先修登录 bug，退款之后再说')
  })

  it('detects the kind from the body marker when the typed flag was stripped (disk resume)', () => {
    const stripped = { role: 'user', content: kernelInputMsg.content }
    const text = extractCurrentUserQueryText([
      { role: 'user', content: '重构退款逻辑' },
      stripped,
    ])
    expect(text).toBe('改成先修登录 bug，退款之后再说')
  })

  it('findLastOrdinaryUserIndex treats the mid-turn input as the newest user-turn boundary', () => {
    const messages = [
      { role: 'user', content: '重构退款逻辑' },
      { role: 'assistant', content: 'working' },
      kernelInputMsg,
      { role: 'assistant', content: 'ok' },
    ]
    expect(findLastOrdinaryUserIndex(messages)).toBe(2)
  })

  it('generic host reminders are still NOT a user-turn boundary (unchanged)', () => {
    const messages = [
      { role: 'user', content: '重构退款逻辑' },
      {
        role: 'user',
        content: '<system-reminder>\n[Stale todo reminder]\nkeep list current\n</system-reminder>',
        _convertedFromSystem: true,
        _sideChannelKind: 'stale_todo_nudge',
      },
    ]
    expect(findLastOrdinaryUserIndex(messages)).toBe(0)
    expect(extractCurrentUserQueryText(messages)).toBe('重构退款逻辑')
  })

  it('anchorCurrentUserQuery still never wraps inside the envelope (anchor semantics unchanged)', () => {
    const out = anchorCurrentUserQuery([
      { role: 'user', content: 'original ask' },
      { ...kernelInputMsg },
    ])
    expect(out[1]!.content).not.toContain(OPEN)
    expect(out[0]!.content).toBe(`${OPEN}\noriginal ask\n${CLOSE}`)
  })
})
