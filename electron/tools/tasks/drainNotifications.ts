/**
 * Notification drainage helper.
 *
 * Call this at the end of each tool round to check for pending task
 * notifications and inject them as a system message into the conversation.
 *
 * Usage: call drainPendingNotifications() in your conversation handler
 * after each tool execution round.
 */

import { drainNotificationsXml, hasPendingNotifications } from './notificationSystem'

/**
 * Check for and drain pending task notifications.
 * Returns XML notification string or null.
 *
 * Integrate this into your AI chat loop — call after each tool round.
 * The returned XML should be appended as a system message to the next LLM call.
 */
export function drainPendingTaskNotifications(): string | null {
  if (!hasPendingNotifications()) return null
  return drainNotificationsXml()
}

/**
 * Check if there are pending notifications (for IPC broadcast to renderer).
 */
export function hasPendingTaskNotifications(): boolean {
  return hasPendingNotifications()
}
