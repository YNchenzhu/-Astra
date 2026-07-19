/**
 * Composer-bar / input-side slice.
 *
 * Owns every state field the user directly interacts with in the composer
 * (text buffer, referenced files, attachments, mode chips, recalled memories)
 * plus the "my referenced files are now stale" helpers fired by the file
 * tree when the user renames or deletes paths.
 *
 * `setDiffPermissionMode` also fires a main-process IPC so a mode flip takes
 * effect on the *next* tool-use of an already-running AI turn without
 * needing to cancel and restart.
 */
import type { StateCreator } from 'zustand'
import { normalizePath } from '../../../services/pathUtils'
import type { ChatState } from '../types'

export type InputSlice = Pick<ChatState,
  | 'inputText' | 'referencedFiles' | 'enableTools'
  | 'permissionMode' | 'diffPermissionMode' | 'chatInteractionMode'
  | 'pendingAttachments' | 'recalledMemories'
  | 'recalledWorkspaceHits' | 'recalledAttachmentHits' | 'autoApproveRemainingDiffs'
  | 'setInputText' | 'setDiffPermissionMode' | 'setChatInteractionMode'
  | 'addAttachment' | 'removeAttachment' | 'updateAttachment'
  | 'toggleReferencedFile' | 'clearReferencedFiles'
  | 'setEnableTools' | 'setPermissionMode'
  | 'setAutoApproveRemainingDiffs'
  | 'syncReferencedAfterDelete' | 'syncReferencedAfterRename'
>

export const createInputSlice: StateCreator<
  ChatState, [], [], InputSlice
> = (set, get) => ({
  inputText: '',
  referencedFiles: [],
  enableTools: true,
  permissionMode: 'default',
  diffPermissionMode: 'default',
  chatInteractionMode: 'agent',
  pendingAttachments: [],
  recalledMemories: [],
  recalledWorkspaceHits: [],
  recalledAttachmentHits: [],
  autoApproveRemainingDiffs: false,

  setInputText: (text) => set({ inputText: text }),

  setDiffPermissionMode: (mode) => {
    set({ diffPermissionMode: mode })
    // 立即通知主进程,让正在跑的 AI turn 也能热切换 —— 不必等任务结束重开。
    // 下一个 tool-use 会从 interactionState 读到新值。忽略返回值,IPC 失败
    // 仅影响"当前 turn 是否即时生效",下一个 turn 会在 `handleSendMessage`
    // 里再次同步。
    // P1-30: 把当前会话 id 一起发给主进程,这样并行的别的对话不会被这次切换牵连。
    const api = typeof window !== 'undefined' ? window.electronAPI?.ai : undefined
    if (api?.setDiffPermissionMode) {
      const convId = get().currentConversationId ?? undefined
      void api.setDiffPermissionMode(mode, convId).catch(() => {
        /* silent */
      })
    }
  },

  setChatInteractionMode: (mode) =>
    set((s) => {
      let permissionMode = s.permissionMode
      if (mode === 'plan') permissionMode = 'plan'
      else if (mode === 'ask') permissionMode = 'default'
      else if (s.permissionMode === 'plan') permissionMode = 'default'
      return { chatInteractionMode: mode, permissionMode }
    }),

  addAttachment: (attachment) =>
    set((s) => {
      // 2026-07 审计修复:图片按 sha256(或 base64 完全一致)去重 ——
      // 同一截图重复粘贴不再堆叠多个相同 chip。文件类在 ingest 完成时
      // 由 updateAttachment 按 sha256 去重(添加时还只是 placeholder)。
      if (attachment.type === 'image') {
        const dup = s.pendingAttachments.some(
          (a) =>
            a.type === 'image' &&
            ((attachment.sha256 && a.sha256 === attachment.sha256) ||
              a.base64 === attachment.base64),
        )
        if (dup) return s
      }
      return { pendingAttachments: [...s.pendingAttachments, attachment] }
    }),

  removeAttachment: (index) =>
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((_, i) => i !== index) })),

  /**
   * Patch a `type:'file'` attachment that was added as a `processing` placeholder
   * by the file picker, drag-drop, or paste path — matched by `path` so the
   * async ingest IPC in the main process can fill in kind/mimeType/text/pdf
   * /pageImages/sheets/inlineImages once parsing completes.
   */
  updateAttachment: (matchPath, patch) =>
    set((s) => {
      // 记录被更新条目的位置(按 placeholder path,map 之前定位,map 之后
      // path 可能已被 patch 改写为真实路径)。
      const selfIdx = s.pendingAttachments.findIndex(
        (a) => a.type === 'file' && a.path === matchPath,
      )
      const next = s.pendingAttachments.map((a) => {
        if (a.type !== 'file' || a.path !== matchPath) return a
        return { ...a, ...patch }
      })
      // 2026-07 审计修复:同一文件重复拖入的去重。ingest 完成(ready +
      // sha256)时,若其他位置已有相同 sha256 的 ready 文件,丢弃本条 ——
      // 与 FilePreview「附加到聊天」的 sha256 判重行为对齐。
      if (patch.status === 'ready' && patch.sha256 && selfIdx >= 0) {
        const dupExists = next.some(
          (a, i) =>
            i !== selfIdx &&
            a.type === 'file' &&
            a.status === 'ready' &&
            a.sha256 === patch.sha256,
        )
        if (dupExists) {
          return { pendingAttachments: next.filter((_, i) => i !== selfIdx) }
        }
      }
      return { pendingAttachments: next }
    }),

  toggleReferencedFile: (file) =>
    set((s) => ({
      referencedFiles: s.referencedFiles.includes(file)
        ? s.referencedFiles.filter((f) => f !== file)
        : [...s.referencedFiles, file],
    })),

  clearReferencedFiles: () => set({ referencedFiles: [] }),

  setEnableTools: (enabled) => set({ enableTools: enabled }),

  setPermissionMode: (mode) => set({ permissionMode: mode }),

  setAutoApproveRemainingDiffs: (value) => set({ autoApproveRemainingDiffs: value }),

  syncReferencedAfterDelete: (targetPath, isFolder) => {
    const norm = normalizePath(targetPath)
    set((s) => ({
      referencedFiles: s.referencedFiles.filter((f) => {
        const nf = normalizePath(f)
        if (isFolder) {
          return !(nf === norm || nf.startsWith(`${norm}/`))
        }
        return nf !== norm
      }),
    }))
  },

  syncReferencedAfterRename: (oldPath, newPath, isFolder) => {
    const o = normalizePath(oldPath)
    const n = normalizePath(newPath)
    set((s) => ({
      referencedFiles: s.referencedFiles.map((f) => {
        const nf = normalizePath(f)
        if (isFolder) {
          if (nf === o || nf.startsWith(`${o}/`)) {
            return nf === o ? newPath : `${n}${nf.slice(o.length)}`
          }
        } else if (nf === o) {
          return newPath
        }
        return f
      }),
    }))
  },
})
