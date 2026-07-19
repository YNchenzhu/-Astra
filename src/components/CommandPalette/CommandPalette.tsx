import React, { useState, useRef, useEffect } from 'react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useFileStore } from '../../stores/useFileStore'
import { clearTerminalInstance } from '../Terminal/terminalClear'
import { dispatchEditorAction } from '../Editor/editorActions'
import { restartTypeScriptServer } from '../../services/electronAPI'
import { writeFile, openFileDialog as openFileDialogService } from '../../services/fileSystem'
import { readTabContent } from '../../services/openBehavior'
import { toRelativePath, toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { Sparkles, FileEdit, Terminal, Settings, Palette, GitBranch, Search, FolderOpen } from 'lucide-react'
import { useT } from '../../i18n'
import './CommandPalette.css'

interface CommandItem {
  id: string
  label: string
  shortcut?: string
  icon?: React.ElementType
  category?: string
}

// `filterCommands` and `COMMANDS` live next to the CommandPalette component
// because the canonical shape (icon refs, label phrasing, shortcut order) is
// owned by the palette UI; splitting into a constants module would force
// every visual tweak through two files. Fast-refresh disabled per-line.
/* eslint-disable react-refresh/only-export-components */
export function filterCommands(query: string, cmds: CommandItem[] = COMMANDS): CommandItem[] {
  return cmds.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase()),
  )
}

export const COMMANDS: CommandItem[] = [
  { id: 'ai-edit', label: '星构Astra: AI 编辑', shortcut: 'Cmd+K', icon: Sparkles, category: 'AI' },
  { id: 'ai-chat', label: '星构Astra: 打开 AI 对话', shortcut: 'Cmd+L', icon: Sparkles, category: 'AI' },
  { id: 'ai-generate', label: '星构Astra: 内联编辑 (Composer · 多文件 AI)', shortcut: 'Cmd+I', icon: Sparkles, category: 'AI' },
  { id: 'toggle-diff-view', label: 'Compare: 切换内联/并排差异', shortcut: '', icon: FileEdit, category: 'Diff' },
  { id: 'toggle-sidebar', label: '视图: 切换侧边栏', shortcut: 'Cmd+B', icon: FileEdit },
  { id: 'toggle-terminal', label: '视图: 切换终端', shortcut: 'Cmd+J', icon: Terminal },
  { id: 'toggle-ai-chat', label: '视图: 切换 AI 对话', shortcut: 'Cmd+L', icon: Sparkles },
  { id: 'command-palette', label: '视图: 命令面板', shortcut: 'Cmd+Shift+P', icon: Search },
  { id: 'git-commit', label: 'Git: 打开源代码管理', shortcut: '', icon: GitBranch },
  { id: 'settings', label: '首选项: 打开设置', shortcut: 'Cmd+,', icon: Settings },
  { id: 'theme', label: '首选项: 颜色主题', shortcut: '', icon: Palette },
  { id: 'new-file', label: '文件: 新建文件', shortcut: 'Cmd+N', icon: FileEdit },
  { id: 'open-file', label: '文件: 打开文件', shortcut: 'Cmd+O', icon: FolderOpen },
  { id: 'save', label: '文件: 保存', shortcut: 'Cmd+S' },
  { id: 'save-all', label: '文件: 全部保存', shortcut: 'Cmd+Shift+S' },
  { id: 'open-folder', label: '文件: 打开文件夹', shortcut: 'Ctrl+K Ctrl+O', icon: FolderOpen },
  { id: 'find', label: '查找: 在文件中查找', shortcut: 'Cmd+Shift+F', icon: Search },
  { id: 'go-to-line', label: '跳转到行...', shortcut: 'Ctrl+G' },
  { id: 'ts-restart-server', label: 'TypeScript: Restart TS Server', shortcut: '' },
  { id: 'clear-terminal', label: '终端: 清空终端', icon: Terminal },
  { id: 'zoom-in', label: '视图: 放大', shortcut: 'Ctrl+=' },
  { id: 'zoom-out', label: '视图: 缩小', shortcut: 'Ctrl+-' },
  { id: 'zoom-reset', label: '视图: 重置缩放', shortcut: 'Ctrl+0' },
]
/* eslint-enable react-refresh/only-export-components */

export const CommandPalette: React.FC = () => {
  const {
    commandPaletteVisible,
    setCommandPaletteVisible,
    toggleAIChat,
    toggleSidebar,
    toggleTerminal,
    setSidebarView,
    zoomIn,
    zoomOut,
    zoomReset,
  } = useLayoutStore()
  const { openWorkspace } = useWorkspaceStore()
  const { setShowSettings, setTheme } = useSettingsStore()
  const { newFile } = useFileStore()
  const t = useT()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commandLabel = (id: string): string =>
    (t.commandPalette.commands as Record<string, string>)[id] ?? id
  const filtered = COMMANDS.filter((cmd) =>
    commandLabel(cmd.id).toLowerCase().includes(query.toLowerCase()),
  )

  useEffect(() => {
    if (commandPaletteVisible) {
      // Dialog-opened reset: clear prior query + selection. Pure
      // derivation would need a prev-visibility ref which is the same
      // shape this rule discourages.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('')
       
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [commandPaletteVisible])

  useEffect(() => {
    // Keep highlight at the top whenever the filter query changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setCommandPaletteVisible(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      executeCommand(filtered[selectedIndex]?.id)
    }
  }

  const executeCommand = (id?: string) => {
    if (!id) return
    switch (id) {
      case 'ai-edit':
        // Cmd+K: Inline Edit — handled by EditorArea keyboard listener
        break
      case 'ai-generate':
        // Cmd+I: Composer
        useLayoutStore.getState().toggleComposer()
        break
      case 'ai-chat':
      case 'toggle-ai-chat':
        toggleAIChat()
        break
      case 'toggle-sidebar':
        toggleSidebar()
        break
      case 'toggle-terminal':
        toggleTerminal()
        break
      case 'command-palette':
        setCommandPaletteVisible(true)
        break
      case 'git-commit':
        setSidebarView('git')
        break
      case 'open-folder':
        openWorkspace()
        break
      case 'new-file':
        newFile()
        break
      case 'open-file':
        void openFileDialog()
        break
      case 'save':
        void handleSave()
        break
      case 'save-all':
        void handleSaveAll()
        break
      case 'settings':
        setShowSettings(true)
        break
      case 'theme': {
        const currentTheme = useSettingsStore.getState().theme
        setTheme(currentTheme === 'dark' ? 'light' : 'dark')
        break
      }
      case 'find':
        setSidebarView('search')
        break
      case 'go-to-line':
        dispatchEditorAction('editor.action.gotoLine')
        break
      case 'ts-restart-server':
        void restartTypeScriptServer()
        break
      case 'clear-terminal':
        clearTerminalInstance()
        break
      case 'zoom-in':
        zoomIn()
        break
      case 'zoom-out':
        zoomOut()
        break
      case 'zoom-reset':
        zoomReset()
        break
      default:
        return
    }
    setCommandPaletteVisible(false)
  }

  const handleSave = async () => {
    const { tabs, activeTabId, markTabSaved } = useFileStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    const rootPath = useWorkspaceStore.getState().rootPath
    if (!rootPath) return
    const fullPath = toWorkspaceAbsoluteFilePath(tab.path, rootPath)
    try {
      await writeFile(fullPath, tab.content)
      markTabSaved(tab.id)
    } catch (error) {
      console.error('Failed to save:', error)
    }
  }

  const handleSaveAll = async () => {
    const { tabs, markTabSaved } = useFileStore.getState()
    const rootPath = useWorkspaceStore.getState().rootPath
    if (!rootPath) return
    for (const tab of tabs) {
      if (!tab.isModified) continue
      try {
        await writeFile(toWorkspaceAbsoluteFilePath(tab.path, rootPath), tab.content)
        markTabSaved(tab.id)
      } catch (error) {
        console.error(`Failed to save ${tab.path}:`, error)
      }
    }
  }

  const openFileDialog = async () => {
    const filePath = await openFileDialogService({ title: '打开文件' })
    if (!filePath) return
    const rootPath = useWorkspaceStore.getState().rootPath
    try {
      const segments = filePath.replace(/\\/g, '/').split('/')
      const fileName = segments.pop()!
      // 统一打开行为表:图片/文档预览类不做 UTF-8 全文读取。
      const content = await readTabContent(filePath, fileName)
      // Previously this fell back to the brittle `.replace(root + '/', '')`
      // which silently left the absolute path in `tab.path` whenever the
      // user picked a file OUTSIDE the workspace (e.g. `~/.claude/...`).
      // Every downstream save site then did `${root}/${tab.path}` and
      // produced garbled paths like `C:\ws\C:\Users\...`. `toRelativePath`
      // strips the root prefix when possible; otherwise it returns the
      // absolute path intact, which `toWorkspaceAbsoluteFilePath` handles
      // correctly on the save path (no double-join).
      const relativePath = rootPath ? toRelativePath(filePath, rootPath) : fileName
      const ext = fileName.split('.').pop() || ''
      const langMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        json: 'json', md: 'markdown', css: 'css', html: 'html',
        py: 'python', rs: 'rust', go: 'go', java: 'java',
        sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
      }
      useFileStore.getState().openFile({
        id: `file-${Date.now()}`,
        name: fileName,
        path: relativePath,
        language: langMap[ext] || 'plaintext',
        content,
        isModified: false,
      })
    } catch (error) {
      console.error('Failed to open file:', error)
    }
  }

  if (!commandPaletteVisible) return null

  return (
    <div className="palette-overlay" onClick={() => setCommandPaletteVisible(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-wrapper">
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={t.commandPalette.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">{t.commandPalette.empty}</div>
          ) : (
            filtered.map((cmd, idx) => {
              const Icon = cmd.icon
              return (
                <div
                  key={cmd.id}
                  className={`palette-item ${idx === selectedIndex ? 'selected' : ''}`}
                  onClick={() => executeCommand(cmd.id)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {Icon && <Icon size={16} className="palette-item-icon" />}
                  <span className="palette-item-label">{commandLabel(cmd.id)}</span>
                  {cmd.shortcut && (
                    <span className="palette-item-shortcut">{cmd.shortcut}</span>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
