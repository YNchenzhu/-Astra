/**
 * Autosave conflict decision (pure, unit-testable).
 *
 * The renderer autosaves a dirty buffer ~1.5 s after the last edit. When a
 * file is open with unsaved edits AND an external writer (most commonly an
 * AI `edit_file`/`write_file` tool call, but also git / format-on-save) lands
 * different bytes on disk in the meantime, blindly writing the buffer back
 * silently destroys the external write. Worse, the backend's read-before-edit
 * gate then rejects the AI's NEXT edit with
 *   "File has been modified on disk since it was read (mtime changed).
 *    Call read_file again before editing or writing."
 * because the on-disk bytes no longer match the receipt it just stamped.
 *
 * This helper decides what the autosave should do, given the buffer, the
 * CURRENT on-disk content, and the tab's last-known disk baseline:
 *
 *   - `in-sync`  — disk already equals the buffer; nothing to write (just
 *                  clear the dirty flag).
 *   - `conflict` — disk diverged from the baseline (someone else wrote it);
 *                  preserve the on-disk bytes, do NOT clobber.
 *   - `write`    — only the user's buffer changed since the baseline; safe to
 *                  persist it.
 */
export type AutoSaveDecision = 'in-sync' | 'conflict' | 'write'

export function decideAutoSave(params: {
  /** The buffer the autosave is about to persist. */
  bufferContent: string
  /** The bytes currently on disk (read immediately before writing). */
  diskContent: string
  /**
   * The tab's last-known disk baseline (the bytes the buffer was synced from /
   * last saved to). Undefined when unknown — in that case we cannot prove a
   * conflict, so we fall back to writing (preserving legacy behaviour).
   */
  baselineContent: string | undefined
}): AutoSaveDecision {
  const { bufferContent, diskContent, baselineContent } = params
  if (diskContent === bufferContent) return 'in-sync'
  if (baselineContent !== undefined && diskContent !== baselineContent) {
    return 'conflict'
  }
  return 'write'
}
