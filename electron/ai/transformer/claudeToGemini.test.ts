import { describe, expect, it } from 'vitest'
import { claudeToGemini } from './claudeToGemini'
import { createTransformContext } from './index'
import type { ClaudeRequest } from './types'

describe('claudeToGemini', () => {
  it('separates functionResponse parts from trailing user text', () => {
    const req: ClaudeRequest = {
      model: 'gemini-compatible',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_a', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'note first' },
            { type: 'tool_result', tool_use_id: 'call_a', content: 'result A' },
          ],
        },
      ],
    }

    const out = claudeToGemini(req, createTransformContext())

    expect(out.contents.map((c) => c.role)).toEqual(['model', 'user', 'user'])
    expect(out.contents[1].parts[0]).toMatchObject({
      functionResponse: { name: 'Read', response: { result: 'result A' } },
    })
    expect(out.contents[2]).toEqual({ role: 'user', parts: [{ text: 'note first' }] })
  })

  it('drops orphan functionResponse parts and inserts synthetic missing responses', () => {
    const orphanReq: ClaudeRequest = {
      model: 'gemini-compatible',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'missing', content: 'orphan' },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
    }

    expect(claudeToGemini(orphanReq, createTransformContext()).contents).toEqual([
      { role: 'user', parts: [{ text: 'continue' }] },
    ])

    const missingReq: ClaudeRequest = {
      model: 'gemini-compatible',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_missing', name: 'Read', input: {} }],
        },
        { role: 'user', content: 'next' },
      ],
    }

    const out = claudeToGemini(missingReq, createTransformContext())
    expect(out.contents.map((c) => c.role)).toEqual(['model', 'user', 'user'])
    expect(out.contents[1].parts[0]).toMatchObject({ functionResponse: { name: 'Read' } })
    expect(JSON.stringify(out.contents[1].parts[0])).toContain('synthetic functionResponse')
  })

  // 防回归 — 历史 thinking 块不得作为 text part 回灌给 Gemini。
  //
  // 旧实现把 `<think>${block.thinking}</think>` 塞进 parts，等同于把上一轮
  // 模型自己的内部推理作为下一轮输入。Gemini 不一定按"思考标签"对待这
  // 段文本——更常见的是把它当作权威内容继续推演，引入"被自己上轮带偏"
  // 的幻觉路径。对齐 upstream-main `anthropicToOpenaiChat.ts:167` 的全局
  // 原则：reasoning 不进下一轮历史。
  it('drops historical thinking blocks instead of injecting <think> text parts', () => {
    const req: ClaudeRequest = {
      model: 'gemini-compatible',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal scratchpad — should not leak' },
            { type: 'text', text: '最终答复' },
          ],
        },
        { role: 'user', content: '下一轮' },
      ],
    }

    const out = claudeToGemini(req, createTransformContext())

    const modelTurn = out.contents.find((c) => c.role === 'model')
    expect(modelTurn).toBeDefined()
    // 没有 thinking part：既不是 `<think>` 标签包裹的 text，也不是其它任何
    // 形式的 thinking payload。
    expect(modelTurn!.parts).toEqual([{ text: '最终答复' }])
    // 整个请求 wire 上不能出现任何 <think> 标签或思考原文。
    const wire = JSON.stringify(out)
    expect(wire).not.toContain('<think>')
    expect(wire).not.toContain('internal scratchpad')
  })

  // 防回归 — 仅含 thinking 的 assistant 历史回合不应残留空的 model 回合。
  // 如果整条 assistant 只有 thinking（例如上一轮被取消、清空了 text 仍留
  // 了块），Gemini 通路应当把这条 model 回合一并丢弃，而不是发出一个
  // parts:[] 的空回合（部分网关会 400）。
  it('omits an assistant turn that only had thinking content', () => {
    const req: ClaudeRequest = {
      model: 'gemini-compatible',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'lone thought' }],
        },
        { role: 'user', content: 'follow up' },
      ],
    }

    const out = claudeToGemini(req, createTransformContext())

    // 实现的兜底逻辑可能保留一条 `parts: []` 的空 model 回合，也可能直接
    // 跳过。任何一种都不应让 thinking 内容泄漏，所以这里只断言"没有
    // text/任何包含 thinking 字样的 part"。
    const wire = JSON.stringify(out)
    expect(wire).not.toContain('<think>')
    expect(wire).not.toContain('lone thought')
  })
})
