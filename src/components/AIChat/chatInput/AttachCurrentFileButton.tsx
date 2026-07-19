import React from 'react'
import { Paperclip } from 'lucide-react'
import { useChatStore } from '../../../stores/useChatStore'
import { useFileStore } from '../../../stores/useFileStore'

export const AttachCurrentFileButton: React.FC = () => {
  const activeTabId = useFileStore((s) => s.activeTabId)
  const tabs = useFileStore((s) => s.tabs)
  const referencedFiles = useChatStore((s) => s.referencedFiles)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!activeTab) return null

  const isReferenced = referencedFiles.includes(activeTab.path)

  return (
    <button
      className={`chat-attach-btn ${isReferenced ? 'active' : ''}`}
      onClick={() => useChatStore.getState().toggleReferencedFile(activeTab.path)}
      title={isReferenced ? `取消引用 ${activeTab.name}` : `引用当前文件 ${activeTab.name}`}
    >
      <Paperclip size={13} />
    </button>
  )
}
