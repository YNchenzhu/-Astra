/**
 * CodeWorkspaceLayout —— 程序员工作布局 (Sprint 9.0)。
 *
 * 对应 plan 中的 `layout.type = 'code-workspace'`。完整复刻原 App.tsx
 * 里 `.app-main > .app-center > ...` 的内层结构,把 Activity Bar /
 * Sidebar / Editor / Terminal / ChatPanel 按老方式组合。
 *
 * 这一层的剥离是**纯机械搬运** —— 不改任何子组件行为、不重命名
 * CSS 类。目的仅是让 LayoutShell 能在不同 bundle 之间切 layout 时
 * 把 IDE 能力完整保留给 code-dev / 其它开发类 bundle。
 */

import React from 'react'
import { ActivityBar } from '../ActivityBar/ActivityBar'
import { Sidebar } from '../Sidebar/Sidebar'
// Use the EditorShell entry — it short-circuits to <EditorWelcome /> when no
// tab is open and only `React.lazy` imports the heavy EditorArea (Monaco +
// @monaco-editor/react, ~2 MB) on first file open. Importing EditorArea
// directly forces Monaco into the cold-start bundle even on the welcome
// screen, which adds visible "加载编辑器…" delay before the user does
// anything that needs an editor.
import { EditorShell } from '../Editor/EditorShell'
import { ChatPanel } from '../AIChat/ChatPanel'
import { TerminalPanel } from '../Terminal/TerminalPanel'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { isBrowserMode } from '../../services/h5/h5Connection'

export const CodeWorkspaceLayout: React.FC = () => {
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const terminalVisible = useLayoutStore((s) => s.terminalVisible)
  const aiChatVisible = useLayoutStore((s) => s.aiChatVisible)

  // Browser / H5 mode: the editor, terminal, sidebar and activity bar have no
  // working backend over the wire (filesystem / PTY / LSP are all IPC-only) and
  // would otherwise render the full IDE chrome in a phone browser — which both
  // looks wrong and is a needless crash surface. Mount ONLY the chat panel.
  if (isBrowserMode()) {
    return (
      <div className="app-main">
        <ChatPanel />
      </div>
    )
  }

  return (
    <div className="app-main">
      <ActivityBar />
      {sidebarVisible && <Sidebar />}
      <div className="app-center">
        <div className="app-editor-area">
          <EditorShell />
        </div>
        {terminalVisible && <TerminalPanel />}
      </div>
      {aiChatVisible && <ChatPanel />}
    </div>
  )
}
