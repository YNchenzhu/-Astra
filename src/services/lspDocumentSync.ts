/**
 * Push editor buffer lifecycle to main-process language servers (didOpen / didChange / didSave / didClose).
 */

type SyncDocumentAction = 'open' | 'change' | 'close' | 'save'

const debounceByPath = new Map<string, ReturnType<typeof setTimeout>>()
const DEBOUNCE_MS = 450

function cancelPendingChangeSync(absolutePath: string): void {
  const pending = debounceByPath.get(absolutePath)
  if (pending) {
    clearTimeout(pending)
    debounceByPath.delete(absolutePath)
  }
}

function getSyncApi():
  | ((p: {
      filePath: string
      action: SyncDocumentAction
      content?: string
    }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>)
  | undefined {
  return typeof window !== 'undefined' ? window.electronAPI?.lsp?.syncDocument : undefined
}

/** Debounced full-buffer sync after edits (maps to didChange). */
export function scheduleLspDocumentChange(absolutePath: string, content: string): void {
  const sync = getSyncApi()
  if (!sync || !absolutePath.trim()) return

  const key = absolutePath
  cancelPendingChangeSync(key)

  debounceByPath.set(
    key,
    setTimeout(() => {
      debounceByPath.delete(key)
      void sync({ filePath: absolutePath, content, action: 'change' })
    }, DEBOUNCE_MS),
  )
}

export function notifyLspDocumentOpen(absolutePath: string, content: string): void {
  const sync = getSyncApi()
  if (!sync || !absolutePath.trim()) return
  void sync({ filePath: absolutePath, content, action: 'open' })
}

export function notifyLspDocumentClose(absolutePath: string): void {
  const sync = getSyncApi()
  if (!sync || !absolutePath.trim()) return
  cancelPendingChangeSync(absolutePath)
  void sync({ filePath: absolutePath, action: 'close' })
}

export function notifyLspDocumentSave(absolutePath: string): void {
  const sync = getSyncApi()
  if (!sync || !absolutePath.trim()) return
  cancelPendingChangeSync(absolutePath)
  void sync({ filePath: absolutePath, action: 'save' })
}
