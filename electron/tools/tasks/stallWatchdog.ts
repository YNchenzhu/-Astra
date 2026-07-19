/**
 * Stall watchdog for shell tasks.
 *
 * Mirrors upstream's stall detection: periodically checks output file size.
 * If output hasn't grown beyond a threshold and the tail matches an interactive
 * prompt pattern, notifies the LLM that the command is waiting for input.
 */

import type { AgentId } from '../ids'
import { enqueueTaskNotification } from './notificationSystem'

/** Check interval in milliseconds */
export const STALL_CHECK_INTERVAL_MS = 5_000
/** Stall threshold in milliseconds */
export const STALL_THRESHOLD_MS = 45_000
/** Bytes to read from tail for prompt detection */
export const STALL_TAIL_BYTES = 1_024

/** Regex patterns that look like interactive prompts */
const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\[yes\/no\]/i,
  /\? \[y\/n\]/i,
  /\? \(y\/n\)/i,
  /continue\?/i,
  /overwrite\?/i,
  /proceed\?/i,
  /press any key/i,
  /press enter/i,
  /type (yes|no)/i,
  /are you sure/i,
  /do you want to/i,
  /confirm/i,
]

export interface StallWatchdogHandle {
  /** Stop the watchdog */
  stop: () => void
  /** Update the last seen output size */
  updateSize: (size: number) => void
}

export function startStallWatchdog(
  taskId: string,
  command: string,
  getOutputSize: () => number,
  getOutputTail: () => string,
  agentId?: AgentId,
): StallWatchdogHandle {
  let lastSize = getOutputSize()
  let lastChangeAt = Date.now()
  let notified = false
  let interval: ReturnType<typeof setInterval> | null = null

  const check = () => {
    if (notified) return
    const currentSize = getOutputSize()

    if (currentSize > lastSize) {
      lastSize = currentSize
      lastChangeAt = Date.now()
      return
    }

    const elapsed = Date.now() - lastChangeAt
    if (elapsed < STALL_THRESHOLD_MS) return

    // Output hasn't grown in 45s — check for interactive prompt
    const tail = getOutputTail()
    const isPrompt = PROMPT_PATTERNS.some((re) => re.test(tail))

    if (isPrompt) {
      notified = true
      enqueueTaskNotification({
        taskId,
        taskType: 'shell',
        status: 'stalled',
        command,
        summary:
          'The shell command appears to be waiting for interactive input. ' +
          'It has not produced output for 45 seconds and the tail matches a prompt pattern. ' +
          'Consider providing input via the next command or killing this task and using a non-interactive flag.',
        agentId,
      })
    }
  }

  interval = setInterval(check, STALL_CHECK_INTERVAL_MS)

  return {
    stop: () => {
      if (interval) clearInterval(interval)
      interval = null
    },
    updateSize: (size: number) => {
      lastSize = size
      lastChangeAt = Date.now()
    },
  }
}

/** Detect if a string looks like an interactive prompt (used by stall watchdog + UI). */
export function looksLikePrompt(text: string): boolean {
  return PROMPT_PATTERNS.some((re) => re.test(text))
}
