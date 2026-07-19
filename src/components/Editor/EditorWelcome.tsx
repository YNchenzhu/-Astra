import React, { useEffect, useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  RECENT_PROJECTS_CHANGED_EVENT,
  RECENT_PROJECTS_STORAGE_KEY,
} from '../../constants/recentProjects'
import { readRecentProjectsFromStorage } from '../../services/recentProjectsPersistence'
import { useT } from '../../i18n'
// Owns the `.editor-welcome` / `.welcome-content` / `.welcome-*` rules.
// Must be imported here (not pulled transitively from `EditorArea.css`),
// because `EditorArea` is lazy-loaded by `EditorShell` and the welcome
// screen appears BEFORE that chunk resolves on cold start.
import './EditorWelcome.css'

/**
 * 欢迎页独立成组件。**严禁 import 任何 Monaco / @monaco-editor/react /
 * DiffEditor 相关内容**：它是 shell 同步路径的一部分，与 `EditorArea` 的
 * Monaco 大 chunk 解耦，让"没打开文件"的冷启动彻底不触发 Monaco 下载与
 * language services 初始化。
 */
export const EditorWelcome: React.FC = () => {
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace)
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const t = useT()
  const [recentProjectsRev, setRecentProjectsRev] = useState(0)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === RECENT_PROJECTS_STORAGE_KEY || e.key === null) {
        setRecentProjectsRev((n) => n + 1)
      }
    }
    const onLocal = () => setRecentProjectsRev((n) => n + 1)
    window.addEventListener('storage', onStorage)
    window.addEventListener(RECENT_PROJECTS_CHANGED_EVENT, onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(RECENT_PROJECTS_CHANGED_EVENT, onLocal)
    }
  }, [])

  // Deps 是失效触发器（storage 读取无副作用）；linter 会警告但意图是每当
  // rootPath 或 recentProjectsRev 变化时重新读取最新的 recent projects。
  const recentProjectsList = useMemo(
    () => readRecentProjectsFromStorage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootPath, recentProjectsRev],
  )

  const handleOpenRecentProject = (project: string) => {
    setWorkspace(project)
  }

  return (
    <div className="editor-welcome">
      <div className="welcome-content">
        <h2 className="welcome-title">星构Astra</h2>
        <p className="welcome-subtitle">{t.editorWelcome.subtitle}</p>
        <div className="welcome-shortcuts">
          <div className="shortcut-item">
            <kbd>Ctrl</kbd>+<kbd>L</kbd>
            <span>{t.editorWelcome.openAiChat}</span>
          </div>
          <div className="shortcut-item">
            <kbd>Ctrl</kbd>+<kbd>B</kbd>
            <span>{t.editorWelcome.toggleSidebar}</span>
          </div>
          <div className="shortcut-item">
            <kbd>Ctrl</kbd>+<kbd>J</kbd>
            <span>{t.editorWelcome.toggleTerminal}</span>
          </div>
          <div className="shortcut-item">
            <kbd>Ctrl</kbd>+<kbd>K</kbd>
            <span>{t.editorWelcome.commandPalette}</span>
          </div>
        </div>
        <div className="welcome-recent">
          <div className="welcome-recent-header">
            <GitBranch size={14} />
            <span>{t.editorWelcome.recentProjects}</span>
          </div>
          {recentProjectsList.length > 0 ? (
            recentProjectsList.map((project) => (
              <div
                key={project}
                className="welcome-recent-item"
                onClick={() => handleOpenRecentProject(project)}
                title={project}
              >
                {project.split(/[/\\]/).pop() || project}
              </div>
            ))
          ) : (
            <div className="welcome-recent-item" style={{ opacity: 0.5 }}>
              {t.editorWelcome.noRecentProjects}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
