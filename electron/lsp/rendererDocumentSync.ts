/**
 * Apply editor (renderer) document lifecycle to subprocess language servers.
 */

import { getLspServerManager, waitForInitialization } from './manager'

export type RendererDocumentSyncAction = 'open' | 'change' | 'close' | 'save'

export async function handleRendererDocumentSync(params: {
  filePath: string
  action: RendererDocumentSyncAction
  content?: string
}): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const filePath = typeof params.filePath === 'string' ? params.filePath.trim() : ''
  if (!filePath) {
    return { success: false, error: 'filePath required' }
  }

  try {
    await waitForInitialization().catch(() => {})
    const mgr = getLspServerManager()
    if (!mgr) {
      return { success: true, skipped: true }
    }
    if (!mgr.getServerForFile(filePath)) {
      return { success: true, skipped: true }
    }

    switch (params.action) {
      case 'open':
        if (typeof params.content !== 'string') {
          return { success: false, error: 'content required for open' }
        }
        await mgr.openFile(filePath, params.content)
        break
      case 'change':
        if (typeof params.content !== 'string') {
          return { success: false, error: 'content required for change' }
        }
        await mgr.changeFile(filePath, params.content)
        break
      case 'save':
        await mgr.saveFile(filePath)
        break
      case 'close':
        await mgr.closeFile(filePath)
        break
      default:
        return { success: false, error: 'unknown action' }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}
