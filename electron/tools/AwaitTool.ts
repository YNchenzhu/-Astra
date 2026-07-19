/**
 * Await tool — block until background shell commands / sub-agents finish, or
 * until their output matches a pattern (e.g. "Ready" / "Error").
 *
 * Cursor 3 parity: the new `Await` tool lets an agent monitor long-running
 * jobs instead of busy-polling `TaskOutput`. We back it with the existing
 * event-driven {@link taskRuntimeStore.waitForChange} so there is no polling
 * loop — the wait wakes exactly when the writer side appends output or the
 * task reaches a terminal state.
 *
 * It is also the fan-IN primitive for best-of-N: after spawning N background
 * attempts, `Await` on their task ids blocks until they all settle.
 */

import { buildTool } from './buildTool'
import { awaitToolInputZod } from './toolInputZod'
import { taskRuntimeStore, type TaskRuntimeStatus } from './TaskRuntimeStore'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** Per-iteration cap so an overall long wait still re-evaluates pattern matches periodically. */
const WAIT_SLICE_MS = 5_000
const TAIL_CHARS = 1_500

type SettleStatus = TaskRuntimeStatus | 'not_found' | 'running_timeout'

interface TaskOutcome {
  taskId: string
  status: SettleStatus
  matched?: boolean
  exitCode?: number
  error?: string
  tail: string
}

function isTerminal(status: TaskRuntimeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

/** Compile `wait_for` as a regex; fall back to a literal-substring matcher on invalid syntax. */
function compileMatcher(pattern: string | undefined): ((text: string) => boolean) | null {
  if (pattern === undefined || pattern === '') return null
  try {
    const re = new RegExp(pattern)
    return (text: string) => re.test(text)
  } catch {
    return (text: string) => text.includes(pattern)
  }
}

function readText(taskId: string): { text: string; rec: ReturnType<typeof taskRuntimeStore.get> } {
  const rec = taskRuntimeStore.get(taskId)
  if (!rec) return { text: '', rec: undefined }
  return { text: rec.chunks.map((c) => c.text).join(''), rec }
}

function currentOffset(taskId: string): number {
  const rec = taskRuntimeStore.get(taskId)
  return rec ? rec.droppedBefore + rec.chunks.length : 0
}

export const awaitTool = buildTool({
  name: 'Await',
  searchHint: 'wait await background task shell subagent finish complete ready error monitor long-running job',
  description:
    'Block until one or more background tasks (shell commands started with run_in_background, or sub-agents) ' +
    'either finish or print output matching a pattern. Use this to monitor long-running jobs instead of ' +
    'repeatedly polling TaskOutput.\n' +
    '- `task_ids`: the background task id(s) to await (from the tool that started them).\n' +
    '- `wait_for` (optional): a regex matched against each task\'s accumulated output — resolves as soon as it ' +
    'matches (e.g. `Ready|Listening on` to wait for server startup, or `Error|FAILED` to catch failure early). ' +
    'Invalid regex falls back to a literal substring match.\n' +
    '- `mode` (optional): `all` (default) waits for every task to settle; `any` returns on the first.\n' +
    '- `timeout_ms` (optional): max wait in MILLISECONDS (default 120000, max 600000).\n' +
    'Returns each task\'s final status, exit code, whether the pattern matched, and a tail of recent output.',
  inputSchema: [
    {
      name: 'task_ids',
      type: 'array',
      description: 'Background task id(s) to wait for. At least one required.',
      required: true,
    },
    {
      name: 'wait_for',
      type: 'string',
      description:
        'Optional regex matched against accumulated task output. Resolves a task as soon as it matches ' +
        '(e.g. "Ready", "Listening on", "Error"). Invalid regex is treated as a literal substring.',
      required: false,
    },
    {
      name: 'mode',
      type: 'string',
      description: '"all" (default) waits for every task to settle; "any" returns after the first settles.',
      required: false,
    },
    {
      name: 'timeout_ms',
      type: 'number',
      description: 'Max wait in milliseconds. Default 120000, capped at 600000.',
      required: false,
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  zInputSchema: awaitToolInputZod,

  async call(input, ctx) {
    const taskIds = [...new Set(input.task_ids.map((s) => s.trim()).filter(Boolean))]
    if (taskIds.length === 0) {
      return { success: false, error: 'Await: no valid task_ids supplied.' }
    }
    const mode = input.mode ?? 'all'
    const match = compileMatcher(input.wait_for)
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, input.timeout_ms ?? DEFAULT_TIMEOUT_MS)
    const deadline = Date.now() + timeoutMs

    const settled = new Map<string, TaskOutcome>()

    const evaluate = (taskId: string): TaskOutcome | null => {
      const { text, rec } = readText(taskId)
      if (!rec) {
        return { taskId, status: 'not_found', tail: '' }
      }
      const tail = text.slice(-TAIL_CHARS)
      const matched = match ? match(text) : undefined
      if (match && matched) {
        return {
          taskId,
          status: rec.status,
          matched: true,
          ...(typeof rec.exitCode === 'number' ? { exitCode: rec.exitCode } : {}),
          ...(rec.error ? { error: rec.error } : {}),
          tail,
        }
      }
      if (isTerminal(rec.status)) {
        return {
          taskId,
          status: rec.status,
          ...(match ? { matched: !!matched } : {}),
          ...(typeof rec.exitCode === 'number' ? { exitCode: rec.exitCode } : {}),
          ...(rec.error ? { error: rec.error } : {}),
          tail,
        }
      }
      return null
    }

    // Audit M4: register the abort listener ONCE and reuse the promise across
    // iterations, instead of attaching a fresh {once:true} listener every loop
    // turn (which accumulated ~one-per-slice over a long wait).
    const sig = ctx?.abortSignal
    const abortWait: Promise<'abort'> | null =
      sig && !sig.aborted
        ? new Promise<'abort'>((resolve) =>
            sig.addEventListener('abort', () => resolve('abort'), { once: true }),
          )
        : null

    while (true) {
      if (sig?.aborted) break

      for (const id of taskIds) {
        if (settled.has(id)) continue
        const outcome = evaluate(id)
        if (outcome) settled.set(id, outcome)
      }

      // Audit L1: a lone `not_found` must NOT end an `any` wait — keep waiting
      // for the real tasks. `any` returns on the first task that actually
      // reached a terminal / pattern-match state.
      if (mode === 'any' && [...settled.values()].some((o) => o.status !== 'not_found')) break
      if (settled.size >= taskIds.length) break
      if (Date.now() >= deadline) break

      const pending = taskIds.filter((id) => !settled.has(id))
      const remaining = deadline - Date.now()
      const sliceMs = Math.max(1, Math.min(remaining, WAIT_SLICE_MS))

      const waits: Array<Promise<unknown>> = pending.map((id) =>
        // With a pattern, wake on EITHER new output (to re-test the regex) OR a
        // terminal transition — that's the `undefined` waitForStatus behaviour.
        // Without a pattern we only care about completion, so wait for terminal.
        taskRuntimeStore.waitForChange(
          id,
          match
            ? { sinceOffset: currentOffset(id), timeoutMs: sliceMs }
            : { sinceOffset: currentOffset(id), waitForStatus: 'any_terminal', timeoutMs: sliceMs },
        ),
      )
      if (abortWait) waits.push(abortWait)
      await Promise.race(waits)
    }

    // Anything still pending timed out (or we aborted) while running.
    for (const id of taskIds) {
      if (settled.has(id)) continue
      const { rec } = readText(id)
      settled.set(id, {
        taskId: id,
        status: rec ? 'running_timeout' : 'not_found',
        tail: rec ? rec.chunks.map((c) => c.text).join('').slice(-TAIL_CHARS) : '',
      })
    }

    const outcomes = taskIds.map((id) => settled.get(id)!)
    // Audit L1: a task "succeeded" only if its pattern matched OR it completed
    // with a zero/absent exit code (a `completed` shell can still carry a
    // non-zero exit). `any` succeeds when ANY awaited task is ok; `all` requires
    // every task ok. Un-awaited tasks left as `running_timeout` by an `any`
    // early-return therefore no longer force overall failure.
    const isOk = (o: TaskOutcome): boolean =>
      o.matched === true || (o.status === 'completed' && (o.exitCode ?? 0) === 0)
    const succeeded = mode === 'any' ? outcomes.some(isOk) : outcomes.every(isOk)

    const lines = outcomes.map((o) => {
      const bits = [`- ${o.taskId}: ${o.status}`]
      if (typeof o.exitCode === 'number') bits.push(`exit=${o.exitCode}`)
      if (o.matched !== undefined) bits.push(`matched=${o.matched}`)
      if (o.error) bits.push(`error=${o.error}`)
      let line = bits.join(' ')
      if (o.tail.trim()) {
        line += `\n  --- tail ---\n${o.tail.split('\n').map((l) => `  ${l}`).join('\n')}`
      }
      return line
    })

    const header = ctx?.abortSignal?.aborted
      ? 'Await interrupted before all tasks settled.'
      : `Await finished (mode=${mode}${match ? `, wait_for=/${input.wait_for}/` : ''}).`

    return {
      // The per-task statuses in `output` tell the model what actually
      // happened; `success` reflects the awaited condition (see `isOk` + mode).
      success: succeeded,
      output: `${header}\n${lines.join('\n')}`,
      ...(succeeded
        ? {}
        : { error: 'Awaited condition not met (a task failed, timed out, or was not found — see output).' }),
    }
  },
})
