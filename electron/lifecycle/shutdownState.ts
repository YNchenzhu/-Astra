let shutdownInProgress = false

export function beginAppShutdown(): boolean {
  if (shutdownInProgress) return false
  shutdownInProgress = true
  return true
}

export function isAppShutdownInProgress(): boolean {
  return shutdownInProgress
}

export function requestAppQuitFromWindowClose(
  event: { preventDefault(): void },
  quit: () => void,
): void {
  if (shutdownInProgress) return
  event.preventDefault()
  quit()
}

export function resetAppShutdownStateForTests(): void {
  shutdownInProgress = false
}
