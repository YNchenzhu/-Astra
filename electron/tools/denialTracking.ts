/**
 * Track repeated permission denials to avoid tight loops in auto-style flows.
 */

const denialStreakByTool = new Map<string, number>()
const DENIAL_THRESHOLD = 4

export function recordDenial(toolName: string): void {
  const n = (denialStreakByTool.get(toolName) ?? 0) + 1
  denialStreakByTool.set(toolName, n)
}

export function recordSuccess(toolName: string): void {
  denialStreakByTool.delete(toolName)
}

export function getDenialStreak(toolName: string): number {
  return denialStreakByTool.get(toolName) ?? 0
}

/**
 * When true, caller should force interactive approval / avoid auto-approve shortcuts.
 */
export function shouldEscalateAfterDenials(toolName: string): boolean {
  return getDenialStreak(toolName) >= DENIAL_THRESHOLD
}

export function resetDenialTracking(): void {
  denialStreakByTool.clear()
}
