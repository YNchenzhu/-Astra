/**
 * §11.5 — Release streaming handles so native TLS/socket buffers can be reclaimed.
 * Call when abandoning a stream after errors or before fallback paths.
 */

export type AnthropicMessageStreamLike = {
  abort?: () => void
  response?: Response | null
}

/** Best-effort cancel of a `fetch` Response body (SSE / streaming HTTP).
 *
 * Subtle but critical: `ReadableStream.cancel()` RETURNS a Promise that
 * can (and routinely does) reject with an `AbortError` when the body is
 * cancelled while already in the middle of an aborted read — which is
 * exactly the common case here, since we only call this after the
 * stream has been abandoned. `void expr` is NOT a promise-rejection
 * swallower; it only discards the *return value*. Using `void` on a
 * rejecting promise produces an unhandled rejection at the microtask
 * boundary — observable as:
 *   `Unhandled promise rejection: DOMException [AbortError]: This operation was aborted`
 * pointing back at the caller's `AbortController.abort()` creation
 * site (e.g. `toolUseSummary.ts`'s 10 s timeout).
 *
 * The correct fix is to attach an actual `.catch` so the rejection is
 * handled. We ignore the reason — failure to release a body is
 * expected when the underlying connection was already torn down.
 */
export function releaseFetchResponseBody(response: Response | null | undefined): void {
  if (!response?.body) return
  try {
    response.body.cancel().catch(() => {
      /* expected: body was aborted before cancel() raced in — safe to ignore */
    })
  } catch {
    /* synchronous throw — equally fine to ignore */
  }
}

/** Anthropic SDK `MessageStream`: abort in-flight request and drop the response body. */
export function releaseAnthropicMessageStream(stream: AnthropicMessageStreamLike | null | undefined): void {
  if (!stream) return
  try {
    stream.abort?.()
  } catch {
    /* ignore */
  }
  releaseFetchResponseBody(stream.response ?? undefined)
}

/**
 * Combined release for §11.5 parity: Anthropic stream and/or a raw `Response`.
 */
export function releaseStreamResources(resources: {
  anthropicMessageStream?: AnthropicMessageStreamLike | null
  fetchResponse?: Response | null
}): void {
  if (resources.anthropicMessageStream) {
    releaseAnthropicMessageStream(resources.anthropicMessageStream)
  }
  if (resources.fetchResponse) {
    releaseFetchResponseBody(resources.fetchResponse)
  }
}
