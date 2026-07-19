import React, { useRef, useState, useEffect, useCallback } from 'react'
import { ChevronRight, Trash2, ChevronDown, Filter } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useT } from '../../i18n'
import './DebugConsole.css'

type ReplMode = 'node' | 'python' | 'powershell'
type EntryLevel = 'input' | 'output' | 'error' | 'warning' | 'info'

interface HistoryEntry {
  type: EntryLevel
  text: string
  expandable?: boolean
  expanded?: boolean
  children?: string[]
}

const REPL_COMMANDS: Record<ReplMode, (expr: string) => string> = {
  node: (expr) => `node -e "${expr.replace(/"/g, '\\"')}"`,
  python: (expr) => `python -c "${expr.replace(/"/g, '\\"')}"`,
  powershell: (expr) => expr,
}

const REPL_LABELS: Record<ReplMode, string> = {
  node: 'Node.js',
  python: 'Python',
  powershell: 'PowerShell',
}

export const DebugConsole: React.FC = () => {
  const t = useT()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([
    { type: 'info', text: t.debug.initialMessage },
  ])
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1)
  const [replMode, setReplMode] = useState<ReplMode>('node')
  const [levelFilter, setLevelFilter] = useState<EntryLevel | 'all'>('all')
  const [showFilter, setShowFilter] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { rootPath } = useWorkspaceStore()

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [history.length])

  const handleExec = useCallback(async () => {
    if (!input.trim()) return

    const expr = input.trim()
    setCmdHistory((prev) => [...prev, expr])
    setCmdHistoryIdx(-1)
    setInput('')

    const newEntries: HistoryEntry[] = [{ type: 'input', text: expr }]

    if (window.electronAPI?.terminal?.exec) {
      try {
        const command = REPL_COMMANDS[replMode](expr)
        const result = await window.electronAPI.terminal.exec(command, rootPath || undefined)
        if (result.stdout) {
          const lines = result.stdout.split('\n')
          const isMultiLine = lines.length > 3
          newEntries.push({
            type: 'output',
            text: isMultiLine ? lines.slice(0, 3).join('\n') + '...' : result.stdout,
            expandable: isMultiLine,
            expanded: false,
            children: isMultiLine ? lines : undefined,
          })
        }
        if (result.stderr) {
          newEntries.push({ type: 'error', text: result.stderr })
        }
        if (!result.stdout && !result.stderr) {
          newEntries.push({ type: 'output', text: `(exit code: ${result.exitCode})` })
        }
      } catch (e) {
        newEntries.push({ type: 'error', text: (e as Error).message })
      }
    } else {
      // Fallback: browser eval for non-Electron environments. Indirect call form
      // `(0, eval)` runs in the global scope so the user's expression doesn't gain
      // access to this function's locals.
      //
      // React Compiler emits `react-hooks/unsupported-syntax` here because it cannot
      // statically analyse eval-ed code — that's expected and correct for a developer-
      // tools REPL fallback path. Disabling the rule on this one line so the rest of
      // the callback still gets compiler optimisation when present.
      try {
        // eslint-disable-next-line react-hooks/unsupported-syntax
        const result = (0, eval)(expr)
        const text = result === undefined ? 'undefined' : typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)
        newEntries.push({ type: 'output', text })
      } catch (e) {
        newEntries.push({ type: 'error', text: (e as Error).message })
      }
    }

    setHistory((prev) => [...prev, ...newEntries])
  }, [input, replMode, rootPath])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleExec()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (cmdHistory.length === 0) return
        const newIdx = cmdHistoryIdx === -1 ? cmdHistory.length - 1 : Math.max(0, cmdHistoryIdx - 1)
        setCmdHistoryIdx(newIdx)
        setInput(cmdHistory[newIdx] || '')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (cmdHistoryIdx === -1) return
        const newIdx = cmdHistoryIdx + 1
        if (newIdx >= cmdHistory.length) {
          setCmdHistoryIdx(-1)
          setInput('')
        } else {
          setCmdHistoryIdx(newIdx)
          setInput(cmdHistory[newIdx] || '')
        }
      }
    },
    [handleExec, cmdHistory, cmdHistoryIdx]
  )

  const handleClear = () => {
    setHistory([{ type: 'info', text: t.debug.clearedMessage }])
  }

  const toggleExpand = (idx: number) => {
    setHistory((prev) => prev.map((entry, i) =>
      i === idx && entry.expandable ? { ...entry, expanded: !entry.expanded } : entry
    ))
  }

  const filteredHistory = levelFilter === 'all'
    ? history
    : history.filter((e) => e.type === levelFilter || e.type === 'input')

  return (
    <div className="debug-console">
      <div className="debug-toolbar">
        <div className="debug-toolbar-left">
          <select
            className="debug-repl-select"
            value={replMode}
            onChange={(e) => setReplMode(e.target.value as ReplMode)}
          >
            {Object.entries(REPL_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            className={`debug-action-btn ${showFilter ? 'active' : ''}`}
            onClick={() => setShowFilter(!showFilter)}
            title={t.debug.filterLevel}
          >
            <Filter size={13} />
          </button>
        </div>
        <button
          className="debug-action-btn"
          onClick={handleClear}
          title={t.debug.clearConsole}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {showFilter && (
        <div className="debug-filter-row">
          {(['all', 'output', 'error', 'warning', 'info'] as const).map((level) => (
            <button
              key={level}
              className={`debug-filter-btn ${levelFilter === level ? 'active' : ''}`}
              onClick={() => setLevelFilter(level)}
            >
              {level === 'all' ? t.debug.levelAll : level === 'output' ? t.debug.levelOutput : level === 'error' ? t.debug.levelError : level === 'warning' ? t.debug.levelWarning : t.debug.levelInfo}
            </button>
          ))}
        </div>
      )}

      <div className="debug-history" ref={listRef}>
        {filteredHistory.map((entry, i) => (
          <div key={i} className={`debug-entry debug-${entry.type}`}>
            {entry.type === 'input' && (
              <span className="debug-prompt">
                <ChevronRight size={12} />{' '}
              </span>
            )}
            {entry.expandable ? (
              <div className="debug-expandable">
                <button className="debug-expand-btn" onClick={() => toggleExpand(i)}>
                  {entry.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <span className="debug-entry-text">
                  {entry.expanded && entry.children ? entry.children.join('\n') : entry.text}
                </span>
              </div>
            ) : (
              <span className="debug-entry-text">{entry.text}</span>
            )}
          </div>
        ))}
      </div>

      <div className="debug-input-row">
        <ChevronRight size={13} className="debug-input-icon" />
        <input
          ref={inputRef}
          className="debug-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.debug.inputPlaceholder(REPL_LABELS[replMode])}
          autoFocus
        />
      </div>
    </div>
  )
}
