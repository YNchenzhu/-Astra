/**
 * Fetch / streams often reject with `DOMException { name: 'AbortError' }`, which is not always
 * `instanceof Error` in Node — use this instead of `error instanceof Error && error.name === 'AbortError'`.
 */
export function isAbortLikeError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  return (error as { name?: unknown }).name === 'AbortError'
}
