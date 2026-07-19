import { describe, expect, it, vi } from 'vitest'
import { releaseAnthropicMessageStream, releaseFetchResponseBody } from './releaseStreamResources'

describe('releaseStreamResources', () => {
  it('releaseFetchResponseBody calls cancel on body when present', () => {
    const cancel = vi.fn()
    const response = { body: { cancel } } as unknown as Response
    releaseFetchResponseBody(response)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('releaseAnthropicMessageStream invokes abort and cancels response body', () => {
    const abort = vi.fn()
    const cancel = vi.fn()
    const stream = {
      abort,
      response: { body: { cancel } } as unknown as Response,
    }
    releaseAnthropicMessageStream(stream)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('tolerates missing methods', () => {
    expect(() => releaseFetchResponseBody(undefined)).not.toThrow()
    expect(() => releaseAnthropicMessageStream(null)).not.toThrow()
    expect(() =>
      releaseAnthropicMessageStream({
        abort: () => {
          throw new Error('x')
        },
      }),
    ).not.toThrow()
  })
})
