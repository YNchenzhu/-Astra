/**
 * Broadcast helpers for bundle IPC events.
 */

import type { BrowserWindow } from 'electron'
import type { Bundle } from '../agents/bundles/types'
import { BUNDLE_IPC_CHANNELS } from './bundleHandlersChannels'

export function broadcastActivated(
  getMainWindow: () => BrowserWindow | null | undefined,
  bundle: Bundle | undefined,
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(BUNDLE_IPC_CHANNELS.activated, {
      activeId: bundle?.meta.id ?? null,
      bundle: bundle ?? null,
    })
  } catch (err) {
    console.warn('[bundleHandlers] broadcast failed:', err)
  }
}

export function broadcastBundleChanged(
  getMainWindow: () => BrowserWindow | null | undefined,
  bundle: Bundle,
  reason: string,
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(BUNDLE_IPC_CHANNELS.changed, {
      bundle,
      reason,
    })
  } catch (err) {
    console.warn('[bundleHandlers] broadcast changed failed:', err)
  }
}

export function broadcastBundleDeleted(
  getMainWindow: () => BrowserWindow | null | undefined,
  deletedId: string,
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(BUNDLE_IPC_CHANNELS.deleted, { deletedId })
  } catch (err) {
    console.warn('[bundleHandlers] broadcast deleted failed:', err)
  }
}
