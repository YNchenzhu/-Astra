import React from 'react'
import { FileEdit } from 'lucide-react'
import { useFileStore, findTabForWorkspacePath } from '../../../stores/useFileStore'
import { useWorkspaceStore } from '../../../stores/useWorkspaceStore'
import { toRelativePath } from '../../../services/pathUtils'

export const FileChangeList: React.FC = () => {
  const pendingChanges = useFileStore((s) => s.pendingChanges)
  const rootPath = useWorkspaceStore((s) => s.rootPath)

  if (pendingChanges.size === 0) return null

  const changes = Array.from(pendingChanges.values())

  const handleClick = (filePath: string) => {
    const fileState = useFileStore.getState()
    const ws = useWorkspaceStore.getState().rootPath
    const tab = findTabForWorkspacePath(fileState.tabs, filePath, ws)
    if (tab) {
      fileState.setActiveTab(tab.id)
    }
  }

  return (
    <div className="chat-change-list">
      <div className="chat-change-list-header">
        <FileEdit size={13} />
        <span>变更文件 ({changes.length})</span>
      </div>
      <div className="chat-change-list-items">
        {changes.map((c) => {
          const name = toRelativePath(c.filePath, rootPath).split('/').pop() || c.filePath
          return (
            <button
              key={c.id}
              className="chat-change-list-item"
              onClick={() => handleClick(c.filePath)}
              title={toRelativePath(c.filePath, rootPath)}
            >
              <span className="chat-change-list-name">{name}</span>
              <span className="chat-change-list-badge">
                {c.toolName === 'edit_file' ? '编辑' : '写入'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
