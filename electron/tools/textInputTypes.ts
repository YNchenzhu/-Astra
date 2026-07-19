/**
 * Text input and command queue types.
 *
 * Re-exports canonical types from src/types/queue.ts.
 */

export type {
  InlineGhostText,
  VimMode,
  ImageDimensions,
  TextHighlight,
  PastedContent,
  PromptInputMode,
  EditablePromptInputMode,
  QueuePriority,
  OrphanedPermission,
  QueuedCommand,
  BaseTextInputProps,
  VimTextInputProps,
  BaseInputState,
  TextInputState,
  VimInputState,
} from '../../src/types/queue'
export { isValidImagePaste, getImagePasteIds } from '../../src/types/queue'
