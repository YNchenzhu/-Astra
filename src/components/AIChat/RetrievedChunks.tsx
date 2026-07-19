import React, { useState } from 'react'
import {
  FileText, FileSpreadsheet, FileImage, ScanLine, File as FileIcon,
  Quote,
} from 'lucide-react'
import type { RetrievedChunkDisplay, AttachmentKind } from '../../types'
import { RetrievedChunkPreview } from './RetrievedChunkPreview'
import './RetrievedChunks.css'

interface RetrievedChunksProps {
  chunks: RetrievedChunkDisplay[]
}

function pickIcon(kind?: AttachmentKind) {
  if (kind === 'xlsx' || kind === 'xls' || kind === 'csv' || kind === 'tsv') return FileSpreadsheet
  if (kind === 'pdf') return ScanLine
  if (kind === 'image') return FileImage
  if (kind === 'text' || kind === 'markdown' || kind === 'docx' || kind === 'doc' ||
      kind === 'pptx' || kind === 'ppt' || kind === 'ipynb' || kind === 'rtf' ||
      kind === 'json' || kind === 'yaml' || kind === 'xml' || kind === 'html' ||
      kind === 'code') return FileText
  return FileIcon
}

/**
 * Inline bubble strip rendered under the user message when the retrieval
 * pipeline surfaced relevant attachment chunks. Each pill is clickable and
 * opens a modal with the full chunk + a link back to the source attachment.
 *
 * Design notes:
 *   - Compact single-line pill (matches chat-attachment-item chip style).
 *   - Shows rank + filename + score only; full chunk text is revealed in the
 *     modal on click or on hover via the native tooltip.
 *   - Faint by default so they don't distract from the conversation.
 */
export const RetrievedChunks: React.FC<RetrievedChunksProps> = ({ chunks }) => {
  const [activeChunk, setActiveChunk] = useState<RetrievedChunkDisplay | null>(null)

  if (!chunks || chunks.length === 0) return null

  return (
    <>
      <div className="retrieved-chunks">
        <div className="retrieved-chunks-header">
          <Quote size={11} />
          <span>相关片段 · {chunks.length} 条</span>
        </div>
        <div className="retrieved-chunks-list">
          {chunks.map((c) => {
            const Icon = pickIcon(c.attachmentKind)
            // Preview is surfaced as a hover tooltip only — the full text still
            // opens in the modal on click. Keep the tooltip bounded so very
            // long chunks don't overflow the OS tooltip shell.
            const preview = c.text.length > 200 ? c.text.slice(0, 200).trim() + '…' : c.text
            const tip = [
              `#${c.rank} · ${c.attachmentName} · ${(c.score * 100).toFixed(0)}%`,
              c.headingPath ? `§ ${c.headingPath}` : null,
              '',
              preview,
              '',
              '点击查看完整片段',
            ]
              .filter((line) => line !== null)
              .join('\n')
            return (
              <button
                key={c.id}
                className="retrieved-chunk-pill"
                onClick={() => setActiveChunk(c)}
                title={tip}
              >
                <span className="retrieved-chunk-icon">
                  <Icon size={11} />
                </span>
                <span className="retrieved-chunk-rank">#{c.rank}</span>
                <span className="retrieved-chunk-name">{c.attachmentName}</span>
                <span
                  className="retrieved-chunk-score"
                  aria-label={`相关度 ${(c.score * 100).toFixed(1)}%`}
                >
                  {Math.round(c.score * 100)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {activeChunk && (
        <RetrievedChunkPreview
          chunk={activeChunk}
          onClose={() => setActiveChunk(null)}
        />
      )}
    </>
  )
}
