import type { Worker } from 'node:worker_threads'

const activeWorkers = new Set<Worker>()

export function trackActiveSubAgentWorker(worker: Worker): () => void {
  activeWorkers.add(worker)
  return () => {
    activeWorkers.delete(worker)
  }
}

export function terminateAllActiveSubAgentWorkers(): number {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  for (const worker of workers) {
    worker.terminate().catch(() => { /* noop */ })
  }
  return workers.length
}

export function getActiveSubAgentWorkerCountForTests(): number {
  return activeWorkers.size
}
