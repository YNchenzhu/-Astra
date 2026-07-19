/**
 * Custom `React.memo` comparators for `ToolUseCard` / `ToolBlockGroup`.
 *
 * Why these can't use the default shallow compare: `ChatMessage` builds the
 * `toolUse={{...}}` object (and the `tools` array) fresh on every render, so
 * the wrapper reference always differs. These comparators instead compare the
 * render-affecting FIELDS — primitives by value, objects/arrays by reference
 * (the chat store replaces them wholesale on change, so reference equality is
 * a faithful "did this change" signal).
 *
 * Kept in a standalone module (types only, no React) so they're unit-testable
 * without mounting the heavy card components.
 *
 * NOTE: `ToolUseCard` also reads live task output via `useTaskOutputSlice(taskId)`.
 * That is a hook subscription, not a prop — memoising props does NOT suppress
 * those updates, so streaming command output still flows while a card whose
 * props are unchanged is otherwise skipped.
 */
import type { SubAgentDisplay, ToolUseDisplay } from '../../types'

type ToolCallback = (id: string) => void | Promise<void>

export interface ToolUseCardPropsLike {
  toolUse: ToolUseDisplay
  taskId?: string
  subAgents?: SubAgentDisplay[]
  compact?: boolean
  onStop?: ToolCallback
  onRetry?: ToolCallback
}

/** Compare the render-affecting fields of a single ToolUseDisplay. */
function toolViewEqual(a: ToolUseDisplay, b: ToolUseDisplay): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.result === b.result &&
    a.error === b.error &&
    a.toolErrorClass === b.toolErrorClass &&
    a.errorWhat === b.errorWhat &&
    // Objects / arrays: the store swaps the whole `toolUse` on any change,
    // so reference equality faithfully tracks "did this field change".
    a.input === b.input &&
    a.streamingProgress === b.streamingProgress &&
    a.streamingInput === b.streamingInput &&
    a.errorNext === b.errorNext &&
    a.errorTried === b.errorTried &&
    a.errorContext === b.errorContext
  )
}

export function toolUseCardPropsEqual(
  prev: ToolUseCardPropsLike,
  next: ToolUseCardPropsLike,
): boolean {
  if (prev.taskId !== next.taskId) return false
  if (prev.compact !== next.compact) return false
  if (prev.subAgents !== next.subAgents) return false
  if (prev.onStop !== next.onStop) return false
  if (prev.onRetry !== next.onRetry) return false
  return toolViewEqual(prev.toolUse, next.toolUse)
}

export interface ToolBlockGroupToolLike {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
  result?: string
  error?: string
  toolErrorClass?: string
  errorWhat?: string
  errorTried?: string[]
  errorContext?: Record<string, string | number | null | undefined>
  errorNext?: string[]
  taskId?: string
  subAgents?: SubAgentDisplay[]
  streamingProgress?: ToolUseDisplay['streamingProgress']
  streamingInput?: ToolUseDisplay['streamingInput']
}

export interface ToolBlockGroupPropsLike {
  tools: ToolBlockGroupToolLike[]
  onStop: ToolCallback
  onRetry: ToolCallback
}

export function toolBlockGroupPropsEqual(
  prev: ToolBlockGroupPropsLike,
  next: ToolBlockGroupPropsLike,
): boolean {
  if (prev.onStop !== next.onStop) return false
  if (prev.onRetry !== next.onRetry) return false
  const a = prev.tools
  const b = next.tools
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.status !== y.status ||
      x.result !== y.result ||
      x.error !== y.error ||
      x.toolErrorClass !== y.toolErrorClass ||
      x.errorWhat !== y.errorWhat ||
      x.taskId !== y.taskId ||
      x.input !== y.input ||
      x.streamingProgress !== y.streamingProgress ||
      x.streamingInput !== y.streamingInput ||
      x.errorTried !== y.errorTried ||
      x.errorContext !== y.errorContext ||
      x.errorNext !== y.errorNext ||
      x.subAgents !== y.subAgents
    ) {
      return false
    }
  }
  return true
}
