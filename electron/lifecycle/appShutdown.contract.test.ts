import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('app shutdown contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'appShutdown.ts'), 'utf8')

  it('quits when the final window closes on every platform', () => {
    const handler = source.match(/app\.on\('window-all-closed',[\s\S]*?\n\s{2}\}\)/)?.[0] ?? ''
    expect(handler).toContain('app.quit()')
    expect(handler).not.toContain("process.platform !== 'darwin'")
  })

  it.each([
    'killAllTasks',
    'killAllSessions',
    'killAllShellTasks',
    'terminateAllActiveSubAgentWorkers',
    'forceKillAllAppOwnedChildProcesses',
    'shutdownAppOwnedTmuxResources',
    'disposeToolWorkerHostIfCreated',
    'terminateMemoryWorker',
    'fileWatcherManager.dispose',
    'shutdownCronScheduler',
    'shutdownLspServerManager',
    'disconnectAll',
    'stopH5Server',
    'shutdownAsrtIfRunning',
  ])('owns cleanup for %s', (symbol) => {
    expect(source).toContain(symbol)
  })
})
