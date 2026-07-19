import React, { Component, Suspense, lazy, type ReactNode } from 'react'
import { useFileStore } from '../../stores/useFileStore'
import { EditorWelcome } from './EditorWelcome'

/**
 * "编辑区"的轻量入口：
 *   - 没有打开文件 → 直接同步渲染 {@link EditorWelcome}，冷启动无 Monaco 参与。
 *   - 有打开文件 → 懒加载真正的 {@link EditorArea}（含 Monaco / Diff / InlineEdit），
 *     这条重链路只有在用户第一次打开文件时才下载/解析。
 *
 * 这样做彻底消除了以前"应用一启动就看到'加载编辑器…'几秒"的现象 —— 那个
 * 加载是 Vite 在下载 EditorArea chunk + @monaco-editor/react 的大树，而欢
 * 迎页本来不需要这些。
 */
const EditorArea = lazy(() =>
  import('./EditorArea').then((m) => ({ default: m.EditorArea })),
)

const MonacoLoadingFallback: React.FC = () => (
  <div
    className="editor-area"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary, #9399b2)',
      fontSize: 13,
    }}
  >
    加载编辑器…
  </div>
)

/**
 * Local error boundary for the lazy-loaded editor chunk.
 *
 * Without this, a network failure while fetching the `EditorArea` chunk
 * (flaky CDN / offline / local Vite hiccup after HMR) would bubble up
 * through the top-level ErrorBoundary and tear down the *entire* app
 * shell. We catch inside the shell so the rest of the UI (Sidebar,
 * Terminal, ChatPanel, StatusBar) stays interactive and the user can
 * retry just the editor.
 */
class EditorLazyErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[EditorShell] lazy load error:', error)
  }
  private handleRetry = () => {
    this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return (
        <div
          className="editor-area"
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 12,
            padding: 24,
            color: 'var(--text-secondary, #9399b2)',
          }}
        >
          <div style={{ fontSize: 14 }}>
            编辑器加载失败：{this.state.error.message || 'unknown error'}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
              background: 'transparent',
              color: 'var(--text-primary, #cdd6f4)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export const EditorShell: React.FC = () => {
  // 只订阅「是否有 activeTab」，避免 tabs 数组变动触发无意义的 shell 重渲染。
  const hasActiveTab = useFileStore((s) => {
    if (!s.activeTabId) return false
    return s.tabs.some((t) => t.id === s.activeTabId)
  })

  if (!hasActiveTab) {
    return <EditorWelcome />
  }

  return (
    <EditorLazyErrorBoundary>
      <Suspense fallback={<MonacoLoadingFallback />}>
        <EditorArea />
      </Suspense>
    </EditorLazyErrorBoundary>
  )
}
