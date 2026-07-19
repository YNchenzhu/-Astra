import type { ChildProcess } from 'node:child_process'
import { forceKillProcessTree } from '../tools/tasks/killProcessTree'

const activeChildren = new Set<ChildProcess>()

export function trackAppOwnedChildProcess(child: ChildProcess): () => void {
  activeChildren.add(child)
  const remove = (): void => {
    activeChildren.delete(child)
    child.off('close', remove)
    child.off('error', remove)
  }
  child.once('close', remove)
  child.once('error', remove)
  return remove
}

export function forceKillAllAppOwnedChildProcesses(): number {
  const children = [...activeChildren]
  activeChildren.clear()
  for (const child of children) {
    forceKillProcessTree(child)
  }
  return children.length
}

export function getAppOwnedChildProcessCountForTests(): number {
  return activeChildren.size
}
