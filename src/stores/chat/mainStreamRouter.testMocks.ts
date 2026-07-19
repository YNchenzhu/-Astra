/**
 * Shared module-mock factories for the `handleMainStreamEvent` spec family.
 *
 * `vi.mock(...)` factories are hoisted per-file, so every spec re-registers
 * the same mocks. To avoid copy-pasting ~80 lines of stub objects into each
 * spec, the factory bodies live here and each spec does:
 *
 *   vi.mock('../../services/electronAPI', async () => {
 *     const m = await import('./mainStreamRouter.testMocks')
 *     return m.electronApiMock()
 *   })
 *
 * The exported spies (`notifyDesktopSpy`, `stopTaskSpy`) are module singletons
 * within each test file's isolated module graph, so test bodies can import and
 * assert on the exact same instance the mock returns.
 */
import { vi } from 'vitest'

export const notifyDesktopSpy = vi.fn().mockResolvedValue(undefined)
export const stopTaskSpy = vi.fn().mockResolvedValue({ success: true })

export function electronApiMock() {
  return {
    notifyDesktop: notifyDesktopSpy,
    onStreamEvent: vi.fn(() => () => {}),
    sendMessage: vi.fn(),
    cancelMessage: vi.fn(),
    // `sendSlice.cancelMessage` (the store action) invokes the renderer-side
    // `cancelStream` IPC wrapper. The mock has to expose it as a resolved
    // promise so awaiting it doesn't throw under tests.
    cancelStream: vi.fn().mockResolvedValue(undefined),
    cancelAllMainStreams: vi.fn().mockResolvedValue(undefined),
    resetContext: vi.fn().mockResolvedValue(undefined),
    respondPermissionRequest: vi.fn(),
    respondTeamPermissionRequest: vi.fn(),
    respondAskUserQuestion: vi.fn(),
    stopToolTask: vi.fn(),
    retryToolTask: vi.fn(),
    // `toolSlice.stopToolTask` calls `stopTask(toolUseId)` from electronAPI.
    stopTask: stopTaskSpy,
    retryTask: vi.fn().mockResolvedValue({ success: true }),
    prepareToolUseRetry: vi.fn(),
    listConversations: vi.fn().mockResolvedValue([]),
    loadConversation: vi.fn().mockResolvedValue(null),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    getMemoryConfig: vi.fn().mockResolvedValue({}),
    onContextDisplayUpdated: vi.fn(() => () => {}),
    cancelPermissionRequest: vi.fn(),
    cancelAskUserQuestion: vi.fn(),
    debugSessionLog: vi.fn(),
  }
}

// Keep the settings store stub minimal — the handler only reads
// `notifyOnSubagentCompleted` and `desktopNotificationMode`.
export function settingsStoreMock() {
  const settings = {
    notifyOnSubagentCompleted: true,
    notifyOnAskUserQuestion: true,
    notifyOnSubagentStopped: true,
    notifyOnSubagentFailed: true,
    desktopNotificationMode: 'always',
  }
  return {
    useSettingsStore: Object.assign(vi.fn(() => settings), {
      getState: () => settings,
      setState: () => {},
      subscribe: () => () => {},
    }),
  }
}

// The file / workspace / buddy stores are touched by unrelated actions in the
// store composition; stub them so the module loads.
export function fileStoreMock() {
  return {
    useFileStore: Object.assign(vi.fn(() => ({})), {
      getState: () => ({ pendingChanges: new Map(), tabs: [], activeTabId: null }),
      setState: () => {},
      subscribe: () => () => {},
    }),
  }
}

export function workspaceStoreMock(rootPath = '') {
  return {
    useWorkspaceStore: Object.assign(vi.fn(() => ({})), {
      getState: () => ({ rootPath }),
      setState: () => {},
      subscribe: () => () => {},
    }),
  }
}

export function buddyStoreMock() {
  return {
    useBuddyStore: Object.assign(vi.fn(() => ({})), {
      getState: () => ({}),
      setState: () => {},
      subscribe: () => () => {},
    }),
  }
}
