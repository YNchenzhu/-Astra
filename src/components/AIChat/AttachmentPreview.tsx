import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import type { Attachment } from '../../types/tool'
import { AttachmentBody, pickAttachmentIcon, renderAttachmentSubtitle } from './AttachmentBody'
import './AttachmentPreview.css'

interface AttachmentPreviewProps {
  attachment: Attachment
  onClose: () => void
}

/**
 * Modal preview of a pending attachment so the user can see exactly what the
 * AI will receive. The body rendering is shared with the editor-area
 * `FilePreview` via {@link AttachmentBody}.
 */
export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ attachment, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const title = attachment.name
  const subtitle = renderAttachmentSubtitle(attachment)
  const Icon = pickAttachmentIcon(attachment)

  return (
    <div className="attachment-preview-overlay" onClick={onClose}>
      <div className="attachment-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="attachment-preview-header">
          <div className="attachment-preview-title">
            {/* `Icon` is looked up from a small static pool by
                `pickAttachmentIcon` — not dynamically *created*. The
                rule flags the capitalised local as if it were a fresh
                component; silencing just this line keeps the rule's
                signal for real cases elsewhere. */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Icon size={16} />
            <div className="attachment-preview-title-text">
              <span className="attachment-preview-name" title={title}>{title}</span>
              {subtitle && <span className="attachment-preview-subtitle">{subtitle}</span>}
            </div>
          </div>
          <button className="attachment-preview-close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="attachment-preview-body">
          <AttachmentBody attachment={attachment} />
        </div>
      </div>
    </div>
  )
}
