export function getNextMultiEditVisibleCount(
  currentCount: number,
  targetCount: number,
  progressivelyReveal: boolean,
): number {
  if (targetCount <= currentCount || !progressivelyReveal) return targetCount
  return Math.min(targetCount, currentCount + 1)
}
