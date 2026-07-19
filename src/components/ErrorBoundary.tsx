import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Shown in the fallback heading (e.g. "编辑器"). */
  sectionLabel: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.sectionLabel}]`, error, info.componentStack)
  }

  handleReload = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            minHeight: 120,
            flex: 1,
            background: 'var(--vscode-editor-background, #1e1e2e)',
            color: 'var(--vscode-foreground, #cdd6f4)',
            fontFamily: 'system-ui, sans-serif',
            gap: 12,
            padding: 24,
            boxSizing: 'border-box',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            「{this.props.sectionLabel}」渲染出错
          </h2>
          <pre
            style={{
              flex: 1,
              minHeight: 0,
              maxHeight: 160,
              overflow: 'auto',
              background: 'var(--vscode-textBlockQuote-background, #11111b)',
              padding: 12,
              borderRadius: 6,
              fontSize: 11,
              color: '#f38ba8',
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}
          >
            {this.state.error?.message || '未知错误'}
          </pre>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#89b4fa',
              color: '#1e1e2e',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            重试此区域
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
