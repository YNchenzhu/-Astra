/**
 * 已发送用户消息的附件区(2026-07 富文件审计修复)。
 *
 * 此前文件附件只是一个纯文本 `<span>`:不可点击预览、不显示解析失败/
 * 解析中状态 —— 解析失败的附件模型根本没收到,气泡却照常显示文件名,
 * 用户误以为 AI 看到了文件。现在:
 *   - 文件 chip 可点击,复用 AttachmentPreview 模态(与输入区一致,
 *     "AI 收到了什么"可验证);
 *   - error 态显示红色警示 + "未送达" 徽标,hover 给出失败原因;
 *   - 图片缩略图点击放大(同一模态)。
 *
 * 独立组件而非内联在 ChatMessageInner:预览 state 只影响本区域,
 * 也避免向巨型 ChatMessageInner 再添 hook。
 */

import React, { useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { Attachment } from '../../../types'
import { AttachmentPreview } from '../AttachmentPreview'

export const UserMessageAttachments: React.FC<{ attachments: Attachment[] }> = ({
  attachments,
}) => {
  const [preview, setPreview] = useState<Attachment | null>(null)

  return (
    <div className="chat-msg-attachments">
      {attachments.map((att, idx) => (
        <div key={idx} className="chat-msg-attachment-item">
          {att.type === 'image' ? (
            <img
              src={`data:${att.mediaType};base64,${att.base64}`}
              alt={att.name}
              className="chat-msg-attachment-img"
              style={{ cursor: 'zoom-in' }}
              onClick={() => setPreview(att)}
            />
          ) : (
            <button
              type="button"
              className={`chat-msg-attachment-file${att.status === 'error' ? ' is-error' : ''}`}
              title={
                att.status === 'error'
                  ? `解析失败,AI 未收到此文件${att.error ? `:${att.error}` : ''}`
                  : att.path
              }
              onClick={() => setPreview(att)}
            >
              {att.status === 'error' ? (
                <AlertCircle size={11} />
              ) : att.status === 'processing' ? (
                <Loader2 size={11} className="chat-msg-attachment-spin" />
              ) : null}
              <span>{att.name}</span>
              {att.status === 'error' && (
                <span className="chat-msg-attachment-err">未送达</span>
              )}
            </button>
          )}
        </div>
      ))}
      {preview && <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
