/**
 * Workspace / filesystem / terminal / git / workspace-trust bridges + tasks
 * status pill.
 *
 * Grouped because every channel here is rooted on a workspace path and
 * feeds the same left-rail surface (Explorer + Terminal + Git panel).
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { joinWorkspacePath } from './helpers'

export interface FsApi {
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; encoding?: string; error?: string }>
  readFileBinary: (filePath: string) => Promise<{ success: boolean; bytes?: Uint8Array; error?: string }>
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; warning?: string; error?: string }>
  copyFile: (srcPath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
  fileTree: (dirPath: string, maxDepth?: number) => Promise<{ success: boolean; tree?: unknown[]; error?: string }>
  search: (params: { dirPath: string; query: string; maxResults?: number; maxMatchesPerFile?: number }) => Promise<{ success: boolean; results?: unknown[]; truncated?: boolean; error?: string }>
  stat: (filePath: string) => Promise<{ success: boolean; isFile?: boolean; isDirectory?: boolean; size?: number; mtime?: string; error?: string }>
  exists: (filePath: string) => Promise<{ success: boolean; exists: boolean }>
  delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
  createDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  openDialog: (options?: { title?: string; properties?: string[]; defaultPath?: string }) => Promise<{ success: boolean; canceled: boolean; paths: string[] }>
  saveDialog: (options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; canceled: boolean; path?: string }>
  startWorkspaceWatcher: (workspacePath: string) => Promise<{ success: boolean; error?: string }>
  stopWorkspaceWatcher: () => Promise<{ success: boolean; error?: string }>
  onWorkspaceFileChanged: (
    callback: (payload: {
      workspacePath: string
      filePath: string
      relativePath: string
      changeType: 'add' | 'change' | 'unlink'
    }) => void,
  ) => () => void
  showItemInFolder: (fullPath: string) => Promise<{ success: boolean; error?: string }>
  openPath: (fullPath: string) => Promise<{ success: boolean; error?: string }>
  renameInWorkspace: (
    workspaceRoot: string,
    fromRelative: string,
    toRelative: string,
  ) => Promise<{ success: boolean; error?: string }>
}

export function buildFsApi(): FsApi {
  return {
    readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
    readFileBinary: (filePath) => ipcRenderer.invoke('fs:read-file-binary', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
    copyFile: (srcPath, destPath) => ipcRenderer.invoke('fs:copy-file', srcPath, destPath),
    fileTree: (dirPath, maxDepth) => ipcRenderer.invoke('fs:file-tree', dirPath, maxDepth),
    search: (params) => ipcRenderer.invoke('fs:search', params),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
    delete: (filePath) => ipcRenderer.invoke('fs:delete', filePath),
    createDir: (dirPath) => ipcRenderer.invoke('fs:create-dir', dirPath),
    openDialog: (options) => ipcRenderer.invoke('fs:open-dialog', options),
    saveDialog: (options) => ipcRenderer.invoke('fs:save-dialog', options),
    startWorkspaceWatcher: (workspacePath) =>
      ipcRenderer.invoke('fs:start-workspace-watcher', workspacePath),
    stopWorkspaceWatcher: () => ipcRenderer.invoke('fs:stop-workspace-watcher'),
    onWorkspaceFileChanged: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: {
          workspacePath: string
          filePath: string
          relativePath: string
          changeType: 'add' | 'change' | 'unlink'
        },
      ) => callback(payload)
      ipcRenderer.on('workspace:file-changed', handler)
      return () => ipcRenderer.removeListener('workspace:file-changed', handler)
    },
    showItemInFolder: (fullPath) => ipcRenderer.invoke('fs:show-item-in-folder', fullPath),
    openPath: (fullPath) => ipcRenderer.invoke('fs:open-path', fullPath),
    renameInWorkspace: (workspaceRoot, fromRelative, toRelative) =>
      ipcRenderer.invoke(
        'fs:rename',
        joinWorkspacePath(workspaceRoot, fromRelative),
        joinWorkspacePath(workspaceRoot, toRelative),
      ),
  }
}

export interface TerminalApi {
  create: (cwd?: string) => Promise<{ sessionId: number; fallback?: boolean }>
  write: (sessionId: number, data: string) => Promise<void>
  resize: (sessionId: number, cols: number, rows: number) => Promise<void>
  close: (sessionId: number) => Promise<void>
  onData: (sessionId: number, callback: (data: string) => void) => () => void
  onExit: (sessionId: number, callback: (exitCode: number) => void) => () => void
  exec: (command: string, cwd?: string) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>
}

export function buildTerminalApi(): TerminalApi {
  return {
    create: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
    write: (sessionId, data) => ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.invoke('terminal:close', sessionId),
    exec: (command, cwd) => ipcRenderer.invoke('terminal:exec', command, cwd),
    onData: (sessionId, callback) => {
      const handler = (_event: IpcRendererEvent, data: { sessionId: number; data: string }) => {
        if (data.sessionId === sessionId) callback(data.data)
      }
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (sessionId, callback) => {
      const handler = (_event: IpcRendererEvent, data: { sessionId: number; exitCode: number }) => {
        if (data.sessionId === sessionId) callback(data.exitCode)
      }
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
  }
}

export interface WorkspaceTrustApi {
  check: (payload: { path: string }) => Promise<{ trusted: boolean }>
  list: () => Promise<{ roots: string[] }>
  add: (payload: { path: string }) => Promise<{ success: boolean; error?: string }>
  remove: (payload: { path: string }) => Promise<{ success: boolean; error?: string }>
}

export function buildWorkspaceTrustApi(): WorkspaceTrustApi {
  return {
    check: (payload) => ipcRenderer.invoke('workspace-trust:check', payload),
    list: () => ipcRenderer.invoke('workspace-trust:list'),
    add: (payload) => ipcRenderer.invoke('workspace-trust:add', payload),
    remove: (payload) => ipcRenderer.invoke('workspace-trust:remove', payload),
  }
}

export interface GitApi {
  status: (workspaceRoot: string) => Promise<{ success: boolean; status?: unknown; error?: string }>
  init: (workspaceRoot: string) => Promise<{ success: boolean; error?: string }>
  add: (
    workspaceRoot: string,
    paths: string[] | 'all' | 'tracked',
  ) => Promise<{ success: boolean; error?: string }>
  unstage: (
    workspaceRoot: string,
    paths: string[],
  ) => Promise<{ success: boolean; error?: string }>
  commit: (
    workspaceRoot: string,
    message: string,
  ) => Promise<{
    success: boolean
    error?: string
    commit?: string
    branch?: string
    changes?: number
    insertions?: number
    deletions?: number
  }>
  commitFiles: (
    workspaceRoot: string,
    hash: string,
  ) => Promise<{ success: boolean; files?: unknown[]; error?: string }>
  log: (
    workspaceRoot: string,
    limit?: number,
  ) => Promise<{ success: boolean; entries?: unknown[]; error?: string }>
  getIdentity: (
    workspaceRoot: string,
  ) => Promise<{
    success: boolean
    globalName?: string
    globalEmail?: string
    localName?: string
    localEmail?: string
    error?: string
  }>
  setIdentity: (
    workspaceRoot: string,
    name: string,
    email: string,
    scope: 'global' | 'local',
  ) => Promise<{ success: boolean; error?: string }>
  restore: (
    workspaceRoot: string,
    paths: string[],
    mode: 'worktree' | 'head' | 'untracked',
  ) => Promise<{ success: boolean; error?: string }>
  checkoutCommitPaths: (
    workspaceRoot: string,
    hash: string,
    paths: string[],
  ) => Promise<{ success: boolean; error?: string }>
}

export function buildGitApi(): GitApi {
  return {
    status: (workspaceRoot) => ipcRenderer.invoke('git:status', workspaceRoot),
    init: (workspaceRoot) => ipcRenderer.invoke('git:init', workspaceRoot),
    add: (workspaceRoot, paths) => ipcRenderer.invoke('git:add', workspaceRoot, paths),
    unstage: (workspaceRoot, paths) => ipcRenderer.invoke('git:unstage', workspaceRoot, paths),
    commit: (workspaceRoot, message) => ipcRenderer.invoke('git:commit', workspaceRoot, message),
    commitFiles: (workspaceRoot, hash) =>
      ipcRenderer.invoke('git:commit-files', workspaceRoot, hash),
    log: (workspaceRoot, limit) => ipcRenderer.invoke('git:log', workspaceRoot, limit),
    getIdentity: (workspaceRoot) => ipcRenderer.invoke('git:get-identity', workspaceRoot),
    setIdentity: (workspaceRoot, name, email, scope) =>
      ipcRenderer.invoke('git:set-identity', workspaceRoot, name, email, scope),
    restore: (workspaceRoot, paths, mode) =>
      ipcRenderer.invoke('git:restore', workspaceRoot, paths, mode),
    checkoutCommitPaths: (workspaceRoot, hash, paths) =>
      ipcRenderer.invoke('git:checkout-commit-paths', workspaceRoot, hash, paths),
  }
}

/**
 * Renderer-side mirror of `electron/tools/TaskManager.ts#Task`. Only
 * JSON-safe fields are forwarded; the full shape (output chunks,
 * stop handlers, etc.) stays main-process-only.
 */
export interface TaskV2Snapshot {
  taskId: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  owner?: string
  source?: string
  blockedBy: string[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  summary?: string
  runtimeKind?: string
  agentId?: string
  conversationId?: string
  parentTaskId?: string
}

export interface TasksApi {
  drainNotifications: () => Promise<{ hasNotifications: boolean; xml: string | null }>
  getPillLabel: () => Promise<{
    pill: { label: string; needsCta: boolean; needsInput: boolean }
    backgroundCount: number
    foregroundCount: number
  }>
  /**
   * Snapshot the V2 TaskManager (`TaskCreate` / `TaskUpdate` family)
   * task list. Optional `conversationId` filter scopes the result to
   * the current chat, matching upstream's `getTaskListId()` chain.
   * Lifecycle deltas after the snapshot flow over `ai:stream-event`
   * with `type: 'task-v2:lifecycle'`.
   */
  listV2: (params?: { conversationId?: string }) => Promise<{ tasks: TaskV2Snapshot[] }>
}

export function buildTasksApi(): TasksApi {
  return {
    drainNotifications: () => ipcRenderer.invoke('tasks:drain-notifications'),
    getPillLabel: () => ipcRenderer.invoke('tasks:get-pill-label'),
    listV2: (params) => ipcRenderer.invoke('tasks-v2:list', params ?? {}),
  }
}
