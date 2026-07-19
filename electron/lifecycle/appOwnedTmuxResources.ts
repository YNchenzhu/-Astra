import { execFileSync } from 'node:child_process'

const panes = new Set<string>()
const sessions = new Set<string>()

export function trackAppOwnedTmuxPane(paneId: string): void {
  if (paneId.trim()) panes.add(paneId.trim())
}

export function trackAppOwnedTmuxSession(sessionName: string): void {
  if (sessionName.trim()) sessions.add(sessionName.trim())
}

export function shutdownAppOwnedTmuxResources(): number {
  const total = panes.size + sessions.size
  if (process.platform === 'win32') {
    panes.clear()
    sessions.clear()
    return total
  }
  for (const paneId of panes) {
    try {
      execFileSync('tmux', ['kill-pane', '-t', paneId], {
        stdio: 'ignore',
        timeout: 2000,
      })
    } catch {
      /* already gone */
    }
  }
  for (const sessionName of sessions) {
    try {
      execFileSync('tmux', ['kill-session', '-t', sessionName], {
        stdio: 'ignore',
        timeout: 2000,
      })
    } catch {
      /* already gone */
    }
  }
  panes.clear()
  sessions.clear()
  return total
}
