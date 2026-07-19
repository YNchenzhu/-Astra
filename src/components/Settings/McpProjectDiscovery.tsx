/**
 * 工程内 .mcp.json / 插件 manifest 中的 MCP 发现与审批。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import type { MCPServerConfig } from '../../types'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { useT } from '../../i18n'
import './MCPPanel.css'

export type ProjectMcpPendingRow = {
  config: MCPServerConfig
  fingerprint: string
  source: string
  pluginId?: string
  sourceLabel: string
}

function formatCfgSummary(c: MCPServerConfig): string {
  if (c.transport === 'sse' && c.url) return `SSE ${c.url}`
  const cmd = (c.command || '').trim() || 'npx'
  const args = (c.args || []).join(' ')
  return args ? `${cmd} ${args}` : cmd
}

export const McpProjectDiscoverySection: React.FC<{
  workspaceRoot: string | undefined
  onCatalogChanged: () => void | Promise<void>
}> = ({ workspaceRoot, onCatalogChanged }) => {
  const t = useT().settings.mcpDiscovery
  const [pending, setPending] = useState<ProjectMcpPendingRow[]>([])
  const [issues, setIssues] = useState<Array<{ code: string; message: string; path?: string }>>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const scan = useCallback(async () => {
    const r = await window.electronAPI.mcp.discoverProject(workspaceRoot ?? null)
    const next = (r.pending ?? []) as ProjectMcpPendingRow[]
    setPending(next)
    setIssues(r.issues ?? [])
    setSelected((prev) => {
      const n = new Set<string>()
      for (const f of prev) {
        if (next.some((p) => p.fingerprint === f)) n.add(f)
      }
      return n
    })
  }, [workspaceRoot])

  useEffect(() => {
    void scan()
  }, [scan])

  const toggleFp = (fp: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(fp)) n.delete(fp)
      else n.add(fp)
      return n
    })
  }

  const approve = async () => {
    const fps = [...selected]
    if (fps.length === 0) return
    setBusy(true)
    try {
      const r = await window.electronAPI.mcp.approveProjectMcp({
        workspacePath: workspaceRoot ?? null,
        fingerprints: fps,
      })
      if (r.success) {
        await onCatalogChanged()
        await scan()
        setModalOpen(false)
      } else {
        window.alert(r.error || t.approveFailed)
      }
    } catch (error) {
      // This is the MCP trust decision modal — a silent failure is especially
      // dangerous because the user has already decided to approve and thinks
      // the servers are in their catalog. Surface the real reason.
      reportUserActionError(t.approveReportLabel, error)
    } finally {
      setBusy(false)
    }
  }

  const decline = async () => {
    const fps = [...selected]
    if (fps.length === 0) return
    setBusy(true)
    try {
      const r = await window.electronAPI.mcp.declineProjectMcp({
        workspacePath: workspaceRoot ?? null,
        fingerprints: fps,
      })
      if (r.success) {
        await scan()
        setModalOpen(false)
      } else {
        window.alert(r.error || t.actionFailed)
      }
    } catch (error) {
      reportUserActionError(t.declineReportLabel, error)
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceRoot?.trim()) {
    return (
      <div className="mcp-project-discovery mcp-project-discovery-muted">
        {t.openWorkspaceHintPre}<code>.mcp.json</code>{t.openWorkspaceHintSuf}
      </div>
    )
  }

  return (
    <>
      {issues.length > 0 && (
        <div className="mcp-banner mcp-banner-error mcp-project-issues">
          <AlertTriangle size={14} />
          <div>
            <div className="mcp-project-issues-title">{t.issuesTitle}</div>
            <ul>
              {issues.slice(0, 5).map((it, i) => (
                <li key={`${it.code}-${i}`}>
                  <code>{it.code}</code> {it.message}
                  {it.path ? <span className="mcp-issue-path"> — {it.path}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mcp-banner mcp-banner-info mcp-project-pending-banner">
          <span>
            {t.detectedPre}<strong>{pending.length}</strong>{t.detectedSuf}
          </span>
          <button
            type="button"
            className="mcp-btn mcp-btn-primary mcp-btn-sm"
            onClick={() => {
              setSelected(new Set(pending.map((p) => p.fingerprint)))
              setModalOpen(true)
            }}
          >
            {t.reviewAdd}
          </button>
        </div>
      )}

      {modalOpen && pending.length > 0 && (
        <div
          className="mcp-modal-overlay"
          role="presentation"
          onClick={() => !busy && setModalOpen(false)}
        >
          <div
            className="mcp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-project-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="mcp-project-modal-title" className="mcp-modal-title">
              {pending.length === 1
                ? t.modalTitleSingle
                : t.modalTitleBatch}
            </h4>
            <p className="mcp-modal-hint">
              {pending.length === 1
                ? t.modalHintSingle
                : t.modalHintBatch}
            </p>
            <div className="mcp-project-modal-list">
              {pending.length === 1 ? (
                <div className="mcp-project-row mcp-project-row-single">
                  <div className="mcp-project-row-body">
                    <div className="mcp-project-row-name">{pending[0]!.config.name}</div>
                    <div className="mcp-project-row-meta">
                      {pending[0]!.sourceLabel}
                      {pending[0]!.pluginId ? ` · ${pending[0]!.pluginId}` : ''}
                    </div>
                    <div className="mcp-project-row-cmd">{formatCfgSummary(pending[0]!.config)}</div>
                  </div>
                </div>
              ) : (
                pending.map((row) => (
                  <label key={row.fingerprint} className="mcp-project-row">
                    <input
                      type="checkbox"
                      checked={selected.has(row.fingerprint)}
                      onChange={() => toggleFp(row.fingerprint)}
                    />
                    <div className="mcp-project-row-body">
                      <div className="mcp-project-row-name">{row.config.name}</div>
                      <div className="mcp-project-row-meta">
                        {row.sourceLabel}
                        {row.pluginId ? ` · ${row.pluginId}` : ''}
                      </div>
                      <div className="mcp-project-row-cmd">{formatCfgSummary(row.config)}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="mcp-modal-actions">
              <button
                type="button"
                className="mcp-btn mcp-btn-ghost"
                disabled={busy}
                onClick={() => void decline()}
              >
                <XCircle size={14} /> {pending.length === 1 ? t.decline : t.declineSelected}
              </button>
              <button
                type="button"
                className="mcp-btn mcp-btn-primary"
                disabled={busy || selected.size === 0}
                onClick={() => void approve()}
              >
                <CheckCircle2 size={14} /> {pending.length === 1 ? t.approveAdd : t.approveMerge}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
