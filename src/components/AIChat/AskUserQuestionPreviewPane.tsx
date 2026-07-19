import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { sanitizeAskUserPreviewHtml } from '../../utils/sanitizeAskPreviewHtml'
import type { AskPreviewFormat } from './askUserQuestionPreviewLayout'

export type { AskPreviewFormat }

export const AskUserQuestionPreviewPane: React.FC<{
  format: AskPreviewFormat
  previewText: string
}> = ({ format, previewText }) => {
  const t = previewText.trim()
  if (!t) {
    return <div className="ask-preview-empty">该选项暂无预览内容</div>
  }

  if (format === 'markdown') {
    return (
      <div className="ask-preview-markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              const lang = match ? match[1] : ''
              if (/\n/.test(String(children))) {
                return <CodeBlock language={lang} code={String(children)} />
              }
              return (
                <code className="ask-preview-inline-code" {...props}>
                  {children}
                </code>
              )
            },
            a({ href, children }) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="ask-preview-link">
                  {children}
                </a>
              )
            },
          }}
        >
          {t}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <div
      className="ask-preview-html-body"
      dangerouslySetInnerHTML={{ __html: sanitizeAskUserPreviewHtml(t) }}
    />
  )
}
