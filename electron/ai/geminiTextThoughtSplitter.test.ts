import { describe, it, expect, vi } from 'vitest'
import {
  createGeminiTextThoughtSplitter,
  findGeminiInlineThoughtSplit,
} from './geminiTextThoughtSplitter'

describe('findGeminiInlineThoughtSplit', () => {
  it('detects Latin-heavy thinking then CJK answer after blank lines', () => {
    const s = `Crafting the Response

I'm now formulating the reply.

你好！有什么我可以帮你的吗？`
    const sp = findGeminiInlineThoughtSplit(s)
    expect(sp).not.toBeNull()
    expect(s.slice(sp!.answerStart).startsWith('你好')).toBe(true)
  })

  it('returns null for short buffer', () => {
    expect(findGeminiInlineThoughtSplit('short')).toBeNull()
  })
})

describe('createGeminiTextThoughtSplitter', () => {
  it('streams thinking then text when split appears across chunks', () => {
    const think = vi.fn()
    const text = vi.fn()
    const s = createGeminiTextThoughtSplitter({
      onThinkingDelta: think,
      onTextDelta: text,
    })
    const prefix =
      'Crafting the Response\n\nI am formulating words in English only here for the test buffer length.\n\n'
    s.pushTextChunk(prefix)
    s.pushTextChunk('你好')
    expect(think).toHaveBeenCalled()
    expect(text).toHaveBeenCalledWith('你好')
    s.pushTextChunk('！')
    expect(text).toHaveBeenLastCalledWith('！')
  })

  it('flush sends buffered content as text when no split', () => {
    const think = vi.fn()
    const text = vi.fn()
    const s = createGeminiTextThoughtSplitter({
      onThinkingDelta: think,
      onTextDelta: text,
    })
    s.pushTextChunk('Just English reply.')
    expect(think).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    s.flush()
    expect(text).toHaveBeenCalledWith('Just English reply.')
  })

  it('passthroughs long single-line English without waiting for split', () => {
    const think = vi.fn()
    const text = vi.fn()
    const s = createGeminiTextThoughtSplitter({
      onThinkingDelta: think,
      onTextDelta: text,
    })
    const line = 'x'.repeat(400)
    s.pushTextChunk(line)
    expect(think).not.toHaveBeenCalled()
    expect(text).toHaveBeenCalledWith(line)
  })
})
