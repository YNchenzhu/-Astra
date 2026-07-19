import { describe, expect, it } from 'vitest'
import { createQueryLoopChannel } from './queryLoopAsyncGenerator'

describe('createQueryLoopChannel (OpenClaude §1.2 AsyncGenerator contract)', () => {
  it('yields pushed events then completes on end()', async () => {
    const { push, end, iterable } = createQueryLoopChannel()
    push({ type: 'message_start' })
    push({ type: 'text_delta', text: 'hi' })
    end()

    const out: { type: string; text?: string }[] = []
    for await (const e of iterable) {
      out.push(e)
    }
    expect(out).toEqual([
      { type: 'message_start' },
      { type: 'text_delta', text: 'hi' },
    ])
  })

  it('propagates fail() as rejection', async () => {
    const { push, fail, iterable } = createQueryLoopChannel()
    push({ type: 'message_start' })
    const err = new Error('boom')
    fail(err)

    const it = iterable[Symbol.asyncIterator]()
    expect((await it.next()).value).toMatchObject({ type: 'message_start' })
    await expect(it.next()).rejects.toThrow('boom')
  })
})
