import React, { useState } from 'react'
import { assistantAvatarUrl } from '../../../brandingAssets'
import { SparklesIcon } from './icons'

export const ChatEmptyStateAvatar: React.FC = () => {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <SparklesIcon />
  }
  return (
    <img
      src={assistantAvatarUrl}
      alt=""
      className="chat-empty-avatar-img"
      onError={() => setFailed(true)}
    />
  )
}
