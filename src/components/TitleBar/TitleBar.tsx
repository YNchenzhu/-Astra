import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useFileStore } from '../../stores/useFileStore'
import { clearTerminalInstance } from '../Terminal/terminalClear'
import { dispatchEditorAction } from '../Editor/editorActions'
import { openFileDialog, writeFile } from '../../services/fileSystem'
import { readTabContent } from '../../services/openBehavior'
import { toRelativePath, toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { BundleSwitcher } from './BundleSwitcher'
import { assistantAvatarUrl } from '../../brandingAssets'
import { useT } from '../../i18n'
import './TitleBar.css'

interface MenuItemDef {
  label: string
  shortcut?: string
  action?: () => void
  separator?: boolean
}

interface MenuDef {
  label: string
  items: MenuItemDef[]
}

const useMenus = (): MenuDef[] => {
  const t = useT()
  const { openWorkspace, closeWorkspace, rootPath } = useWorkspaceStore()
  const {
    toggleSidebar, toggleTerminal, toggleAIChat, toggleComposer,
    setCommandPaletteVisible, zoomIn, zoomOut, zoomReset, openSidebarView,
    requestFocusSearch,
  } = useLayoutStore()
  const { setShowSettings } = useSettingsStore()
  const { newFile } = useFileStore()

  const handleNewFile = () => newFile()

  const handleOpenFile = async () => {
    try {
      const filePath = await openFileDialog({ title: 'Open File' })
      if (!filePath) return
      const segments = filePath.replace(/\\/g, '/').split('/')
      const fileName = segments.pop()!
      // 统一打开行为表:图片/文档预览类不做 UTF-8 全文读取。
      const content = await readTabContent(filePath, fileName)
      // `.replace(root + '/', '')` silently left absolute paths intact when
      // the user picked a file outside the workspace — those then poisoned
      // every downstream `${root}/${tab.path}` save site. `toRelativePath`
      // strips the root when possible and otherwise returns the absolute
      // path intact so save paths stay well-formed.
      const relativePath = rootPath ? toRelativePath(filePath, rootPath) : fileName
      const ext = fileName.split('.').pop() || ''
      const langMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        json: 'json', md: 'markdown', css: 'css', html: 'html',
        py: 'python', rs: 'rust', go: 'go', java: 'java',
        sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
      }
      const tab: import('../../types').TabInfo = {
        id: `file-${Date.now()}`,
        name: fileName,
        path: relativePath,
        language: langMap[ext] || 'plaintext',
        content,
        isModified: false,
      }
      useFileStore.getState().openFile(tab)
    } catch (error) {
      // User clicked "打开文件..." — a silent failure here is exactly the
      // class of bug this audit was cleaning up. Previously only a
      // console.error fired.
      reportUserActionError('打开文件', error)
    }
  }

  const handleSave = async () => {
    const { tabs, activeTabId, markTabSaved } = useFileStore.getState()
    const currentRootPath = useWorkspaceStore.getState().rootPath
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) {
      console.warn('[Save] No active tab found, activeTabId:', activeTabId)
      return
    }
    if (!currentRootPath) {
      console.warn('[Save] No workspace opened, cannot save.')
      return
    }
    const fullPath = toWorkspaceAbsoluteFilePath(tab.path, currentRootPath)
    try {
      await writeFile(fullPath, tab.content)
      markTabSaved(tab.id)
    } catch (error) {
      reportUserActionError('保存文件', error)
    }
  }

  const handleSaveAll = async () => {
    const { tabs, markTabSaved } = useFileStore.getState()
    const rp = useWorkspaceStore.getState().rootPath
    if (!rp) {
      console.warn('[Save All] No workspace opened, cannot save.')
      return
    }
    const failures: string[] = []
    for (const tab of tabs) {
      if (!tab.isModified) continue
      const fullPath = toWorkspaceAbsoluteFilePath(tab.path, rp)
      try {
        await writeFile(fullPath, tab.content)
        markTabSaved(tab.id)
      } catch (error) {
        // Continue saving the rest; surface one consolidated alert at the
        // end so the user isn't bombarded when the preload bridge is down
        // and every tab fails at once.
        failures.push(`${tab.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) {
      reportUserActionError(
        '全部保存',
        new Error(`${failures.length} 个文件保存失败：\n${failures.join('\n')}`),
      )
    }
  }

  return [
    {
      label: t.titleBar.menu.file,
      items: [
        { label: t.titleBar.file.newFile, action: handleNewFile, shortcut: 'Ctrl+N' },
        { label: t.titleBar.file.openFile, action: handleOpenFile, shortcut: 'Ctrl+O' },
        { label: t.titleBar.file.openFolder, action: openWorkspace, shortcut: 'Ctrl+K Ctrl+O' },
        ...(rootPath
          ? [{
              label: t.titleBar.file.closeFolder,
              action: () => {
                closeWorkspace().catch((error) =>
                  reportUserActionError('关闭文件夹', error),
                )
              },
            } satisfies MenuItemDef]
          : []),
        { label: '', separator: true },
        { label: t.titleBar.file.save, action: handleSave, shortcut: 'Ctrl+S' },
        { label: t.titleBar.file.saveAll, action: handleSaveAll, shortcut: 'Ctrl+Shift+S' },
        { label: '', separator: true },
        { label: t.titleBar.file.preferences, action: () => setShowSettings(true), shortcut: 'Ctrl+,' },
      ],
    },
    {
      label: t.titleBar.menu.edit,
      items: [
        { label: t.titleBar.edit.undo, action: () => dispatchEditorAction('undo'), shortcut: 'Ctrl+Z' },
        { label: t.titleBar.edit.redo, action: () => dispatchEditorAction('redo'), shortcut: 'Ctrl+Shift+Z' },
        { label: '', separator: true },
        { label: t.titleBar.edit.cut, action: () => dispatchEditorAction('editor.action.clipboardCutAction'), shortcut: 'Ctrl+X' },
        { label: t.titleBar.edit.copy, action: () => dispatchEditorAction('editor.action.clipboardCopyAction'), shortcut: 'Ctrl+C' },
        { label: t.titleBar.edit.paste, action: () => dispatchEditorAction('editor.action.clipboardPasteAction'), shortcut: 'Ctrl+V' },
        { label: t.titleBar.edit.selectAll, action: () => dispatchEditorAction('editor.action.selectAll'), shortcut: 'Ctrl+A' },
        { label: '', separator: true },
        { label: t.titleBar.edit.find, action: () => dispatchEditorAction('actions.find'), shortcut: 'Ctrl+F' },
        { label: t.titleBar.edit.replace, action: () => dispatchEditorAction('editor.action.startFindReplaceAction'), shortcut: 'Ctrl+H' },
        { label: t.titleBar.edit.findNext, action: () => dispatchEditorAction('editor.action.nextMatchFindAction'), shortcut: 'F3' },
        { label: t.titleBar.edit.findPrev, action: () => dispatchEditorAction('editor.action.previousMatchFindAction'), shortcut: 'Shift+F3' },
        { label: '', separator: true },
        { label: t.titleBar.edit.findInFiles, action: () => { openSidebarView('search'); requestFocusSearch() }, shortcut: 'Ctrl+Shift+F' },
      ],
    },
    {
      label: t.titleBar.menu.select,
      items: [
        { label: t.titleBar.select.selectAll, action: () => dispatchEditorAction('editor.action.selectAll'), shortcut: 'Ctrl+A' },
        { label: t.titleBar.select.expandSelection, action: () => dispatchEditorAction('editor.action.smartSelect.expand'), shortcut: 'Shift+Alt+Right' },
        { label: t.titleBar.select.shrinkSelection, action: () => dispatchEditorAction('editor.action.smartSelect.shrink'), shortcut: 'Shift+Alt+Left' },
        { label: '', separator: true },
        { label: t.titleBar.select.copyLineUp, action: () => dispatchEditorAction('editor.action.copyLinesUpAction'), shortcut: 'Shift+Alt+Up' },
        { label: t.titleBar.select.copyLineDown, action: () => dispatchEditorAction('editor.action.copyLinesDownAction'), shortcut: 'Shift+Alt+Down' },
        { label: t.titleBar.select.moveLineUp, action: () => dispatchEditorAction('editor.action.moveLinesUpAction'), shortcut: 'Alt+Up' },
        { label: t.titleBar.select.moveLineDown, action: () => dispatchEditorAction('editor.action.moveLinesDownAction'), shortcut: 'Alt+Down' },
      ],
    },
    {
      label: t.titleBar.menu.view,
      items: [
        { label: t.titleBar.view.commandPalette, action: () => setCommandPaletteVisible(true), shortcut: 'Ctrl+Shift+P' },
        { label: '', separator: true },
        { label: t.titleBar.view.explorer, action: toggleSidebar, shortcut: 'Ctrl+B' },
        { label: t.titleBar.view.terminal, action: toggleTerminal, shortcut: 'Ctrl+J' },
        { label: t.titleBar.view.aiChat, action: toggleAIChat, shortcut: 'Ctrl+L' },
        { label: t.titleBar.view.composer, action: toggleComposer, shortcut: 'Ctrl+I' },
        { label: '', separator: true },
        { label: t.titleBar.view.zoomIn, action: zoomIn, shortcut: 'Ctrl+=' },
        { label: t.titleBar.view.zoomOut, action: zoomOut, shortcut: 'Ctrl+-' },
        { label: t.titleBar.view.zoomReset, action: zoomReset, shortcut: 'Ctrl+0' },
      ],
    },
    {
      label: t.titleBar.menu.go,
      items: [
        { label: t.titleBar.go.goToFile, action: () => setCommandPaletteVisible(true), shortcut: 'Ctrl+P' },
        { label: t.titleBar.go.goToLine, action: () => dispatchEditorAction('editor.action.gotoLine'), shortcut: 'Ctrl+G' },
        { label: t.titleBar.go.goToSymbol, action: () => dispatchEditorAction('editor.action.quickOutline'), shortcut: 'Ctrl+Shift+O' },
        { label: '', separator: true },
        { label: t.titleBar.go.goToDefinition, action: () => dispatchEditorAction('editor.action.revealDefinition'), shortcut: 'F12' },
        { label: t.titleBar.go.goToReferences, action: () => dispatchEditorAction('editor.action.goToReferences'), shortcut: 'Shift+F12' },
      ],
    },
    {
      label: t.titleBar.menu.run,
      items: [
        { label: t.titleBar.run.startDebug, shortcut: 'F5' },
        { label: t.titleBar.run.runWithoutDebug, shortcut: 'Ctrl+F5' },
        { label: '', separator: true },
        { label: t.titleBar.run.stopDebug, shortcut: 'Shift+F5' },
        { label: t.titleBar.run.toggleBreakpoint, shortcut: 'F9' },
      ],
    },
    {
      label: t.titleBar.menu.terminal,
      items: [
        { label: t.titleBar.terminal.newTerminal, action: toggleTerminal, shortcut: 'Ctrl+J' },
        { label: '', separator: true },
        { label: t.titleBar.terminal.splitTerminal, shortcut: 'Ctrl+Shift+5' },
        { label: t.titleBar.terminal.clearTerminal, action: () => clearTerminalInstance(), shortcut: 'Ctrl+K' },
      ],
    },
    {
      label: t.titleBar.menu.help,
      items: [
        { label: t.titleBar.help.docs, shortcut: 'F1' },
        { label: t.titleBar.help.releaseNotes },
        { label: '', separator: true },
        { label: t.titleBar.help.reportIssue },
        { label: t.titleBar.help.about },
      ],
    },
  ]
}

export const TitleBar: React.FC = () => {
  const t = useT()
  const [openMenuIdx, setOpenMenuIdx] = useState<number | null>(null)
  const menuBarRef = useRef<HTMLDivElement>(null)
  const menus = useMenus()

  const handleMenuClick = useCallback((idx: number) => {
    setOpenMenuIdx((prev) => (prev === idx ? null : idx))
  }, [])

  const handleItemClick = useCallback((item: MenuItemDef) => {
    if (!item.action) return
    item.action()
    setOpenMenuIdx(null)
  }, [])

  const closeMenu = useCallback(() => {
    setOpenMenuIdx(null)
  }, [])

  useEffect(() => {
    if (openMenuIdx === null) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        closeMenu()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [openMenuIdx, closeMenu])

  const handleMinimize = () => {
    window.electronAPI?.window.minimize()
  }

  const handleMaximize = () => {
    window.electronAPI?.window.maximize()
  }

  const handleClose = () => {
    window.electronAPI?.window.close()
  }

  return (
    <div className="titlebar">
      <div className="titlebar-drag-region">
        <div className="titlebar-left" ref={menuBarRef}>
          <img
            className="titlebar-icon"
            src={assistantAvatarUrl}
            alt=""
            width={16}
            height={16}
          />
          <div className="titlebar-menus">
            {menus.map((menu, idx) => (
              <div key={menu.label} className="titlebar-menu-wrapper">
                <button
                  className={`titlebar-menu-item ${openMenuIdx === idx ? 'active' : ''}`}
                  onClick={() => handleMenuClick(idx)}
                  onMouseEnter={() => {
                    if (openMenuIdx !== null) setOpenMenuIdx(idx)
                  }}
                >
                  {menu.label}
                </button>
                {openMenuIdx === idx && (
                  <div className="titlebar-dropdown">
                    {menu.items.map((item, itemIdx) =>
                      item.separator ? (
                        <div key={itemIdx} className="titlebar-dropdown-separator" />
                      ) : (
                        <button
                          key={itemIdx}
                          className="titlebar-dropdown-item"
                          onClick={() => handleItemClick(item)}
                        >
                          <span className="titlebar-dropdown-label">{item.label}</span>
                          {item.shortcut && (
                            <span className="titlebar-dropdown-shortcut">{item.shortcut}</span>
                          )}
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="titlebar-center">
        <span className="titlebar-title">星构Astra</span>
        {/* 工作包切换器:紧邻标题,下拉里含切换/编辑/删除/新建全部功能。 */}
        <BundleSwitcher />
      </div>
      <div className="titlebar-right">
        <button className="titlebar-window-btn" title={t.titleBar.minimize} onClick={handleMinimize}>
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="var(--text-secondary)" />
          </svg>
        </button>
        <button className="titlebar-window-btn" title={t.titleBar.maximize} onClick={handleMaximize}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="var(--text-secondary)" strokeWidth="1" fill="none" />
          </svg>
        </button>
        <button className="titlebar-window-btn titlebar-close-btn" title={t.titleBar.close} onClick={handleClose}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1l-8 8" stroke="var(--text-secondary)" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
