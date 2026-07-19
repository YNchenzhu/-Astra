/**
 * Cross-platform process-tree kill, shared by every shell-task kill path.
 *
 * Leaf module — depends only on `node:child_process` so it can be imported
 * from `shellRunner`, `ShellTaskManager`, and the sandbox spawner without
 * import cycles.
 *
 * Why a plain `child.kill()` is not enough:
 * - On Windows, `child.kill()` sends a generic signal that typically does NOT
 *   propagate to grandchildren; a spawned bash / pwsh that launches
 *   `node foo.js` leaves the node orphan running. We fall back to
 *   `taskkill /T /F /PID <pid>` which walks the whole tree.
 * - On POSIX, we send SIGTERM first, then SIGKILL after a 2s grace period if
 *   the process is still alive — the two-phase kill lets cleanup hooks run but
 *   guarantees termination.
 */

import { spawnSync, type ChildProcess } from 'node:child_process'

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    try {
      // `taskkill` runs on the Electron main thread via spawnSync — without a
      // hard timeout a stuck taskkill (rare but real: large process trees,
      // AV interception, zombie descendants) will freeze the entire main
      // process event loop, which in turn blocks all IPC from the renderer
      // and makes the whole UI appear hung. 5s is more than enough for a
      // normal kill; anything longer is pathological and we fall through
      // to `child.kill()` below as a best-effort backstop.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 5000,
      })
    } catch {
      /* best-effort: fall back to kill() below */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    return
  }
  // POSIX (audit A-P1-1): `child.kill()` signals only the direct child —
  // grandchildren spawned by a bash/pwsh wrapper (e.g. `node foo.js`)
  // survived. Enumerate the descendant tree via `pgrep -P` (portable across
  // Linux + macOS, unlike `ps --ppid`) and signal every pid, then escalate
  // to SIGKILL after the grace period.
  const descendants = collectDescendantPidsPosix(pid)
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  for (const dpid of descendants) {
    try {
      process.kill(dpid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  // Hard-kill escalation after a grace period, guarded by `exitCode`.
  const escalation = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    // Re-collect: the tree may have re-parented or spawned since SIGTERM.
    const survivors = new Set([...descendants, ...collectDescendantPidsPosix(pid)])
    for (const dpid of survivors) {
      try {
        process.kill(dpid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, 2000)
  if (typeof escalation.unref === 'function') escalation.unref()
}

export function forceKillProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid == null) return
  forceKillPidTree(pid)
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

export function forceKillPidTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 5000,
      })
    } catch {
      /* ignore */
    }
    return
  }
  const descendants = collectDescendantPidsPosix(pid)
  for (const descendantPid of descendants.reverse()) {
    try {
      process.kill(descendantPid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** BFS the descendant pids of `rootPid` via `pgrep -P` (bounded, best-effort). */
function collectDescendantPidsPosix(rootPid: number): number[] {
  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0 && out.length < 256) {
    const p = queue.shift()!
    let stdout = ''
    try {
      const res = spawnSync('pgrep', ['-P', String(p)], {
        timeout: 2000,
        encoding: 'utf8',
      })
      stdout = typeof res.stdout === 'string' ? res.stdout : ''
    } catch {
      continue
    }
    for (const line of stdout.split('\n')) {
      const childPid = Number.parseInt(line.trim(), 10)
      if (!Number.isFinite(childPid) || childPid <= 0 || seen.has(childPid)) continue
      seen.add(childPid)
      out.push(childPid)
      queue.push(childPid)
    }
  }
  return out
}
