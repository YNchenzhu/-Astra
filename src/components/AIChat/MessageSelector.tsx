import React, { useMemo, useState } from 'react'
import { ListTree } from 'lucide-react'
import type { ChatMessage } from '../../types'

interface MessageSelectorProps {
  messages: ChatMessage[]
  onSelectMessage: (messageId: string) => void
}

export const MessageSelector: React.FC<MessageSelectorProps> = ({ messages, onSelectMessage }) => {
  const [open, setOpen] = useState(false)

  const selectableMessages = useMemo(
    () =>
      messages
        .map((message, index) => ({ message, index }))
        // Exclude host-inserted compact_boundary rows — they have role
        // 'assistant' but empty content; jumping to one would scroll to
        // a meaningless divider.
        .filter(
          ({ message }) =>
            (message.role === 'user' || message.role === 'assistant') &&
            message.kind !== 'compact_boundary',
        )
        .reverse(),
    [messages]
  )

  if (messages.length === 0) {
    return null
  }

  return (
    <div className="chat-message-selector">
      <button
        className="chat-message-selector-trigger"
        onClick={() => setOpen((value) => !value)}
        title="跳转到消息"
      >
        <ListTree size={12} />
        <span>消息</span>
      </button>

      {open && (
        <div className="chat-message-selector-menu">
          {selectableMessages.map(({ message, index }) => {
            const preview = message.content.trim().replace(/\s+/g, ' ').slice(0, 64)
            const displayText = preview.length > 0 ? preview : '(空消息)'
            return (
              <button
                key={message.id}
                className="chat-message-selector-item"
                onClick={() => {
                  onSelectMessage(message.id)
                  setOpen(false)
                }}
              >
                <span className="chat-message-selector-index">#{index + 1}</span>
                <span className="chat-message-selector-role">
                  {message.role === 'user' ? '你' : '太初'}
                </span>
                <span className="chat-message-selector-text">{displayText}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
