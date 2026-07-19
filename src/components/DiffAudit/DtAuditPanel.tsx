/**
 * Audit panel for DiffTransactions (P4e).
 *
 * Read-only view over `useDiffTransactionStore`. Shows every DT the current session has
 * seen — live ones first (Pending/Approved/Writing/Failed/Stale) and historical ones
 * (Applied/Rejected) afterwards. Clicking a row reveals the state-history timeline with
 * timestamps + reasons so users can reconstruct "what did the AI do at 14:02 and why
 * did it fail?" without digging through logs.
 *
 * Design notes:
 *   • Panel is a modal overlay, not a sidebar tab. We expect it to be rarely opened
 *     (debugging / audit), so embedding into the main layout doesn't earn its keep.
 *   • Self-contained styles — one less CSS file to wire through the build.
 *   • Filtering happens entirely client-side on already-received DT snapshots. WAL-
 *     backed historical data is already in the renderer store because the main process
 *     broadcasts restored DTs on rehydrate.
 *   • No write actions from this panel — intents (Retry/Rebase/Abort/Undo) live in the
 *     InlineDiffController / toast, which already have the right user context.
 */

import React, { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Clock, FileCode, Filter, Search, X } from 'lucide-react'
import {
  useDiffTransactionStore,
  type RendererDiffTransaction,
  type RendererDtState,
} from '../../stores/useDiffTransactionStore'
import {
  EMPTY_FILTER,
  STATE_META,
  basename,
  filterAndSort,
  humanizeRelative,
  summarizeLineDelta,
} from './auditFilters'

interface DtAuditPanelProps {
  open: boolean
  onClose: () => void
}

const ALL_STATES: RendererDtState[] = [
  'Pending',
  'Approved',
  'Writing',
  'Applied',
  'Failed',
  'Rejected',
  'Stale',
]

export const DtAuditPanel: React.FC<DtAuditPanelProps> = ({ open, onClose }) => {
  // Subscribe to the Map **reference** (which is stable between store mutations
  // because the reducer allocates a new Map only on real writes), then
  // derive the flat array via useMemo. Previously the selector was
  // `(s) => Array.from(s.transactionsById.values())`, which returned a
  // brand-new array every render; Zustand v5 compares selector outputs
  // with Object.is so it detected a change on every subscription check
  // and fired forceStoreRerender in a loop → "Maximum update depth".
  const transactionsById = useDiffTransactionStore((s) => s.transactionsById)
  const transactions = useMemo(
    () => Array.from(transactionsById.values()),
    [transactionsById],
  )
  const [text, setText] = useState('')
  const [states, setStates] = useState<Set<RendererDtState>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filter = useMemo(
    () => ({ ...EMPTY_FILTER, text, states, sinceMs: 0 }),
    [text, states],
  )

  const rows = useMemo(() => filterAndSort(transactions, filter), [transactions, filter])

  const selected = useMemo(
    () => (selectedId ? transactions.find((t) => t.id === selectedId) : undefined),
    [selectedId, transactions],
  )

  const toggleState = useCallback((s: RendererDtState) => {
    setStates((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }, [])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="DiffTransaction audit panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(980px, 92vw)',
          height: 'min(620px, 85vh)',
          background: 'var(--color-surface, #1a1a1a)',
          border: '1px solid var(--color-border, #2a2a2a)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
          color: 'var(--color-fg, #d4d4d4)',
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-border, #2a2a2a)',
            gap: 8,
          }}
        >
          <strong style={{ flex: 1 }}>Diff Transactions</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {rows.length} of {transactions.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 4,
              opacity: 0.7,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Filter row */}
        <div
          style={{
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderBottom: '1px solid var(--color-border, #2a2a2a)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 200 }}>
            <Search size={14} style={{ opacity: 0.6 }} />
            <input
              type="text"
              placeholder="Filter by file path, tool, or error..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{
                flex: 1,
                background: 'var(--color-input-bg, #0f0f0f)',
                border: '1px solid var(--color-border, #2a2a2a)',
                borderRadius: 4,
                color: 'inherit',
                padding: '4px 8px',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Filter size={14} style={{ opacity: 0.6 }} />
            {ALL_STATES.map((s) => {
              const active = states.has(s)
              const meta = STATE_META[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleState(s)}
                  style={{
                    padding: '2px 8px',
                    fontSize: 11,
                    border: `1px solid ${active ? meta.color : 'var(--color-border, #2a2a2a)'}`,
                    background: active ? `${meta.color}22` : 'transparent',
                    color: active ? meta.color : 'var(--color-fg, #d4d4d4)',
                    borderRadius: 999,
                    cursor: 'pointer',
                  }}
                  title={`Toggle ${meta.label}`}
                >
                  {meta.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Body: list + detail */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* List */}
          <div
            style={{
              width: 420,
              overflowY: 'auto',
              borderRight: '1px solid var(--color-border, #2a2a2a)',
            }}
          >
            {rows.length === 0 ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  color: 'var(--color-muted, #666)',
                  fontSize: 12,
                }}
              >
                {transactions.length === 0
                  ? 'No diff transactions yet. The AI must have proposed at least one edit.'
                  : 'No transactions match your filter.'}
              </div>
            ) : (
              rows.map((tx) => (
                <AuditRow
                  key={tx.id}
                  tx={tx}
                  selected={selectedId === tx.id}
                  onClick={() => setSelectedId(tx.id)}
                />
              ))
            )}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {selected ? <AuditDetail tx={selected} /> : <DetailEmpty />}
          </div>
        </div>
      </div>
    </div>
  )
}

const AuditRow: React.FC<{
  tx: RendererDiffTransaction
  selected: boolean
  onClick: () => void
}> = ({ tx, selected, onClick }) => {
  const meta = STATE_META[tx.state]
  const stats = summarizeLineDelta(tx)
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--color-border, #2a2a2a)',
        background: selected ? 'var(--color-surface-hover, #262626)' : 'transparent',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <FileCode size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={tx.filePath}
        >
          {basename(tx.filePath)}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 3,
            background: `${meta.color}22`,
            color: meta.color,
            whiteSpace: 'nowrap',
          }}
        >
          {meta.label}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          fontSize: 11,
          opacity: 0.7,
        }}
      >
        <span>{tx.proposed?.toolName ?? 'edit'}</span>
        <span style={{ color: '#22c55e' }}>+{stats.added}</span>
        <span style={{ color: '#ef4444' }}>−{stats.removed}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <Clock size={10} />
          {humanizeRelative(tx.updatedAt)}
        </span>
      </div>
      {tx.error && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--color-error-fg, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <AlertTriangle size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            [{tx.error.code}] {tx.error.message}
          </span>
        </div>
      )}
    </div>
  )
}

const AuditDetail: React.FC<{ tx: RendererDiffTransaction }> = ({ tx }) => {
  const stats = summarizeLineDelta(tx)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>File</div>
        <div
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            wordBreak: 'break-all',
          }}
        >
          {tx.filePath}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <DetailField label="State" value={tx.state} color={STATE_META[tx.state].color} />
        <DetailField label="Tool" value={tx.proposed?.toolName ?? '—'} />
        <DetailField label="Added" value={`+${stats.added}`} color="#22c55e" />
        <DetailField label="Removed" value={`−${stats.removed}`} color="#ef4444" />
        <DetailField label="Created" value={new Date(tx.createdAt).toLocaleString()} />
        <DetailField label="Updated" value={new Date(tx.updatedAt).toLocaleString()} />
      </div>
      {tx.error && (
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--color-error-bg, rgba(239, 68, 68, 0.12))',
            border: '1px solid var(--color-error-border, rgba(239, 68, 68, 0.4))',
            borderRadius: 4,
            color: 'var(--color-error-fg, #ef4444)',
            fontSize: 12,
          }}
        >
          <strong>[{tx.error.code}]</strong> {tx.error.message}
          {tx.error.recoverable && (
            <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
              Marked recoverable — Retry from the diff toolbar.
            </div>
          )}
        </div>
      )}
      <div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>State timeline</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tx.stateHistory.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>No history recorded.</div>
          ) : (
            tx.stateHistory.map((h, i) => (
              <TimelineRow key={`${h.at}-${i}`} entry={h} />
            ))
          )}
        </div>
      </div>
      {tx.riskWarnings && tx.riskWarnings.length > 0 && (
        <div>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Risk warnings</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {tx.riskWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const DetailField: React.FC<{ label: string; value: string; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <div>
    <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 12, color: color ?? 'inherit' }}>{value}</div>
  </div>
)

const TimelineRow: React.FC<{ entry: RendererDiffTransaction['stateHistory'][number] }> = ({
  entry,
}) => {
  const toMeta = STATE_META[entry.to]
  const fromMeta = STATE_META[entry.from]
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        padding: '4px 8px',
        background: 'var(--color-surface-soft, rgba(255,255,255,0.02))',
        borderRadius: 4,
      }}
    >
      <span style={{ color: fromMeta.color, minWidth: 64 }}>{fromMeta.label}</span>
      <span style={{ opacity: 0.4 }}>→</span>
      <span style={{ color: toMeta.color, minWidth: 64 }}>{toMeta.label}</span>
      <span style={{ opacity: 0.5, fontSize: 11 }}>
        {new Date(entry.at).toLocaleTimeString()}
      </span>
      {entry.reason && (
        <span style={{ opacity: 0.7, flex: 1, fontSize: 11 }}>· {entry.reason}</span>
      )}
      {entry.errorCode && (
        <span style={{ color: STATE_META.Failed.color, fontSize: 11 }}>[{entry.errorCode}]</span>
      )}
    </div>
  )
}

const DetailEmpty: React.FC = () => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--color-muted, #666)',
      fontSize: 12,
    }}
  >
    Select a transaction to inspect its timeline.
  </div>
)
