/**
 * Tiny in-memory failed-token rate limiter for the H5 server.
 *
 * The H5 token is 256-bit random (practically un-bruteforceable), so this is
 * defense-in-depth, not the primary control: it just blocks a peer that fires a
 * burst of bad tokens, keeping logs/CPU sane and making online guessing futile.
 * Keyed by remote address; a successful auth clears that peer's counter.
 */
const WINDOW_MS = 60_000
const MAX_FAILURES = 20

const attempts = new Map<string, { count: number; first: number }>()

export function isRateLimited(ip: string | null | undefined): boolean {
  if (!ip) return false
  const rec = attempts.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip)
    return false
  }
  return rec.count >= MAX_FAILURES
}

export function recordTokenFailure(ip: string | null | undefined): void {
  if (!ip) return
  const rec = attempts.get(ip)
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() })
  } else {
    rec.count += 1
  }
}

export function recordTokenSuccess(ip: string | null | undefined): void {
  if (ip) attempts.delete(ip)
}

export function resetH5RateLimit(): void {
  attempts.clear()
}
