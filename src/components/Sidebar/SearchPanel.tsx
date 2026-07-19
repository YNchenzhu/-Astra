import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, File, Replace } from 'lucide-react'
import { searchWorkspace, readFile, writeFile } from '../../services/fileSystem'
import { readTabContent } from '../../services/openBehavior'
import { toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useFileStore } from '../../stores/useFileStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useT } from '../../i18n'
import type { SearchResult } from '../../types'
import './SearchPanel.css'

export const SearchPanel: React.FC = () => {
  const t = useT()
  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { rootPath } = useWorkspaceStore()
  const { openFile, tabs } = useFileStore()
  // Per-field selector: avoid re-rendering this panel for unrelated
  // layout-store fields (terminal height, sidebar width, …).
  const focusSearchNonce = useLayoutStore((s) => s.focusSearchNonce)

  // Auto-focus on mount AND whenever the menu / Ctrl+Shift+F bumps the
  // nonce. Mount alone is not enough for the case where the panel is
  // already visible — store state doesn't change, so SearchPanel doesn't
  // remount, and the user expects the second press to grab focus.
  useEffect(() => {
    if (!rootPath) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSearchNonce, rootPath])

  useEffect(() => {
    if (!rootPath || !query.trim()) {
      setResults([])
      setTruncated(false)
      setIsSearching(false)
      return
    }

    let cancelled = false
    setIsSearching(true)

    const timer = window.setTimeout(async () => {
      try {
        const response = await searchWorkspace({
          dirPath: rootPath,
          query: query.trim(),
          maxResults: 800,
          maxMatchesPerFile: 20,
        })
        if (cancelled) return
        setResults(response.results)
        setTruncated(response.truncated)
      } catch {
        if (cancelled) return
        setResults([])
        setTruncated(false)
      } finally {
        if (!cancelled) {
          setIsSearching(false)
        }
      }
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, rootPath])

  const totalMatches = useMemo(
    () => results.reduce((count, item) => count + item.matches.length, 0),
    [results]
  )

  const openResult = async (filePath: string, line: number) => {
    if (!rootPath) return

    const existing = tabs.find((tab) => tab.path === filePath)
    if (existing) {
      openFile(existing)
      return
    }

    const fullPath = toWorkspaceAbsoluteFilePath(filePath, rootPath)
    try {
      const fileName = filePath.split('/').pop() || filePath
      // 统一打开行为表:图片/文档预览类不做 UTF-8 全文读取。
      const content = await readTabContent(fullPath, fileName)
      const extension = fileName.split('.').pop()?.toLowerCase() || ''
      const languageMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        json: 'json',
        md: 'markdown',
        css: 'css',
        html: 'html',
        py: 'python',
        rs: 'rust',
        go: 'go',
        java: 'java',
        sh: 'shell',
        yml: 'yaml',
        yaml: 'yaml',
        xml: 'xml',
        sql: 'sql',
      }

      openFile({
        id: `${filePath}-${Date.now()}`,
        name: fileName,
        path: filePath,
        language: languageMap[extension] || 'plaintext',
        content,
        isModified: false,
      })

      void line
    } catch (error) {
      console.error('Failed to open search result file:', error)
    }
  }

  const handleReplaceAll = async () => {
    if (!rootPath || !query.trim() || results.length === 0) return

    setIsReplacing(true)
    setReplaceStatus(null)

    let filesChanged = 0
    let totalReplacements = 0
    const errors: string[] = []

    // Group matches by file path to batch replacements per file
    const byFile = new Map<string, SearchResult>()
    for (const result of results) {
      byFile.set(result.path, result)
    }

    for (const [filePath, result] of byFile) {
      try {
        const fullPath = toWorkspaceAbsoluteFilePath(filePath, rootPath)
        let content = await readFile(fullPath)

        // Sort matches by line descending so we can replace without offset issues
        const sortedMatches = [...result.matches].sort((a, b) => b.line - a.line)

        // Build replacement by processing lines
        const lines = content.split('\n')
        for (const match of sortedMatches) {
          const lineIdx = match.line - 1
          if (lineIdx >= 0 && lineIdx < lines.length) {
            const original = lines[lineIdx]
            // Escape special regex chars in query for literal replacement
            const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const replaced = original.replace(new RegExp(escapedQuery, 'g'), replaceText)
            if (replaced !== original) {
              lines[lineIdx] = replaced
              totalReplacements++
            }
          }
        }

        if (totalReplacements > 0) {
          content = lines.join('\n')
          await writeFile(fullPath, content)
          filesChanged++
        }
      } catch (err) {
        errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    setIsReplacing(false)

    if (errors.length > 0) {
      setReplaceStatus(
        t.search.replacementsWithErrors(totalReplacements, filesChanged, errors.length, errors.slice(0, 2).join('; '))
      )
    } else if (totalReplacements === 0) {
      setReplaceStatus(t.search.noReplacements)
    } else {
      setReplaceStatus(t.search.replacementsDone(totalReplacements, filesChanged))
    }

    // Re-run search to refresh results
    if (totalReplacements > 0) {
      setQuery((prev) => prev + '') // trigger re-search via the useEffect
    }
  }

  return (
    <div className="search-panel">
      <div className="search-input-container">
        <Search size={14} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder={rootPath ? t.search.placeholder : t.search.placeholderNoFolder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!rootPath}
        />
        {query && (
          <button className="search-clear" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {query && (
        <div className="search-input-container">
          <Replace size={14} className="search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder={t.search.replacePlaceholder}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            disabled={results.length === 0}
          />
          <button
            className="search-replace-btn"
            disabled={results.length === 0 || !replaceText || isReplacing}
            onClick={() => { void handleReplaceAll() }}
            title={t.search.replaceAllTitle}
          >
            {isReplacing ? '...' : t.search.replaceAll}
          </button>
        </div>
      )}

      {replaceStatus && (
        <div className="search-replace-status">{replaceStatus}</div>
      )}

      {query && (
        <div className="search-results-header">
          {isSearching
            ? t.search.searching
            : t.search.resultsSummary(totalMatches, results.length, truncated)}
        </div>
      )}

      {results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <div key={result.path} className="search-result-file">
              <div className="search-result-file-header">
                <File size={14} />
                <span>{result.file}</span>
                <span className="search-result-path">{result.path}</span>
              </div>
              {result.matches.map((match, idx) => (
                <div
                  key={`${result.path}-${match.line}-${idx}`}
                  className="search-result-match"
                  onClick={() => {
                    void openResult(result.path, match.line)
                  }}
                  title={t.search.openResultTitle(result.path, match.line)}
                >
                  <span className="search-result-line">{match.line}</span>
                  <span className="search-result-text">{match.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
