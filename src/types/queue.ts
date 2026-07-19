import type { AgentId } from './ids'
import type { ChatMessage } from './tool'

// ============================================================================
// Text Input & Queue Types
// ============================================================================

/**
 * Inline ghost text for mid-input command autocomplete.
 */
export interface InlineGhostText {
  readonly text: string
  readonly fullCommand: string
  readonly insertPosition: number
}

/**
 * Vim editor modes.
 */
export type VimMode = 'INSERT' | 'NORMAL'

/**
 * Image dimensions for paste handling.
 */
export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Text highlight range.
 */
export interface TextHighlight {
  start: number
  end: number
  className?: string
}

/**
 * Pasted content reference.
 */
export interface PastedContent {
  id: number
  type: 'text' | 'image'
  content: string
  mediaType?: string
  filename?: string
  dimensions?: ImageDimensions
  sourcePath?: string
}

/**
 * Input modes for the prompt.
 */
export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'orphaned-permission'
  | 'task-notification'

/**
 * Editable subset of PromptInputMode.
 */
export type EditablePromptInputMode = 'bash' | 'prompt'

/**
 * Queue priority levels.
 * - 'now': Interrupt and send immediately
 * - 'next': Let current tool call finish, then send
 * - 'later': Wait for current turn to finish, then process
 */
export type QueuePriority = 'now' | 'next' | 'later'

/**
 * Permission result paired with assistant message for orphaned permissions.
 */
export type OrphanedPermission = {
  permissionResult: Record<string, unknown>
  assistantMessage: ChatMessage
}

/**
 * Queued command with full metadata.
 */
export interface QueuedCommand {
  value: string | unknown[]
  mode: PromptInputMode
  priority?: QueuePriority
  uuid?: string
  orphanedPermission?: OrphanedPermission
  pastedContents?: Record<number, PastedContent>
  preExpansionValue?: string
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  isMeta?: boolean
  origin?: string
  workload?: string
  agentId?: AgentId
}

/**
 * Base props for text input components.
 */
export interface BaseTextInputProps {
  readonly onHistoryUp?: () => void
  readonly onHistoryDown?: () => void
  readonly placeholder?: string
  readonly multiline?: boolean
  readonly focus?: boolean
  readonly mask?: string
  readonly showCursor?: boolean
  readonly highlightPastedText?: boolean
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSubmit?: (value: string) => void
  readonly onExit?: () => void
  readonly onExitMessage?: (show: boolean, key?: string) => void
  readonly onHistoryReset?: () => void
  readonly onClearInput?: () => void
  readonly columns: number
  readonly maxVisibleLines?: number
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  readonly onPaste?: (text: string) => void
  readonly onIsPastingChange?: (isPasting: boolean) => void
  readonly disableCursorMovementForUpDownKeys?: boolean
  readonly disableEscapeDoublePress?: boolean
  readonly cursorOffset: number
  readonly onChangeCursorOffset: (offset: number) => void
  readonly argumentHint?: string
  readonly onUndo?: () => void
  readonly dimColor?: boolean
  readonly highlights?: TextHighlight[]
  readonly placeholderElement?: unknown
  readonly inlineGhostText?: InlineGhostText
  readonly inputFilter?: (input: string, key: string) => string
}

/**
 * Extended props for Vim text input.
 */
export interface VimTextInputProps extends BaseTextInputProps {
  readonly initialMode?: VimMode
  readonly onModeChange?: (mode: VimMode) => void
}

/**
 * Common properties for input hook results.
 */
export interface BaseInputState {
  onInput: (input: string, key: string) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  cursorLine: number
  cursorColumn: number
  viewportCharOffset: number
  viewportCharEnd: number
  isPasting?: boolean
  pasteState?: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
}

/**
 * State for text input.
 */
export type TextInputState = BaseInputState

/**
 * State for Vim input with mode.
 */
export interface VimInputState extends BaseInputState {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

/**
 * Type guard to check if a pasted content is a valid image.
 */
export function isValidImagePaste(c: PastedContent): boolean {
  return c.type === 'image' && c.content.length > 0
}

/**
 * Extract image paste IDs from pasted contents.
 */
export function getImagePasteIds(
  pastedContents: Record<number, PastedContent> | undefined,
): number[] | undefined {
  if (!pastedContents) {
    return undefined
  }
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map(c => c.id)
  return ids.length > 0 ? ids : undefined
}
