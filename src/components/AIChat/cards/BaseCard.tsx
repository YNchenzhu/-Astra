/**
 * Unified card chrome for AI chat artifacts — tools, sub-agents, thinking,
 * shell output, file edits, etc.
 *
 * Phase 1 of the "visual language unification" work:
 *   - Every artifact card shares the same header / body / footer structure
 *   - A 2px status accent bar on the left signals idle / running / success / error
 *   - Collapse is the default affordance; the chevron rotates 90° on expand
 *   - All inner sections (input / output / diff / error) share one wrapper
 *     (`CardSection`) with copy-to-clipboard baked in
 *
 * Consumers keep their own domain logic (diff builder, task-output hooks,
 * etc.) and just pass slots into `BaseCard` / `CardSection`. No existing
 * prop contract changes.
 */
import React, {
  useCallback,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight, Copy, Check } from 'lucide-react'
import { resolveInitialExpanded, setCardExpanded } from '../cardCollapseStore'
import './BaseCard.css'

/**
 * Normalized status vocabulary.
 *
 * Different producers across the codebase use different words ("completed"
 * vs "success", "failed"/"stopped" vs "error"). `normalizeCardStatus()`
 * maps the raw values to this 4-state union so the visual layer has a
 * single switch point.
 */
export type CardStatus = 'idle' | 'running' | 'success' | 'error'

// Co-located helper: the visual mapping lives right next to the component
// that consumes it, so keep the HMR warning off this file. (Moving it to a
// sibling would cost readability for every contributor touching card UI.)
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeCardStatus(raw: string | undefined | null): CardStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'running':
    case 'pending':
    case 'in_progress':
    case 'streaming':
      return 'running'
    case 'completed':
    case 'success':
    case 'done':
    case 'ok':
      return 'success'
    case 'failed':
    case 'error':
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'timeout':
      return 'error'
    default:
      return 'idle'
  }
}

export interface BaseCardProps {
  /** Visual state. Drives the left accent bar colour. */
  status?: CardStatus
  /** Leading icon (lucide or any react node). */
  icon?: ReactNode
  /** Main title. Rendered in a mono font by default. */
  title: ReactNode
  /**
   * Short one-line summary shown next to the title when the card is
   * collapsed. Equivalent to the IDE's "result in one sentence" affordance.
   * Kept visible even when expanded (it stays in the header row).
   */
  subtitle?: ReactNode
  /** Right-aligned metadata — duration, token count, status word, etc. */
  meta?: ReactNode
  /**
   * Right-aligned action buttons (Stop / Retry). Clicks are stop-propagated
   * so they don't toggle the card.
   */
  actions?: ReactNode
  /** Card body — only mounted when expanded, unless `alwaysOpen`. */
  children?: ReactNode
  /** Initial expand state (uncontrolled). Defaults to collapsed. */
  defaultExpanded?: boolean
  /** Controlled expand state. Pair with `onToggle`. */
  expanded?: boolean
  /** Called with the new expand state when the header is activated. */
  onToggle?: (next: boolean) => void
  /** Tighter chrome for nested lists (e.g. inside ToolBlockGroup). */
  compact?: boolean
  /** Extra class on the root wrapper. */
  className?: string
  /** Disables the collapse affordance; body is always visible. */
  alwaysOpen?: boolean
  /**
   * When set (and the card is uncontrolled), the expand state is persisted in
   * `cardCollapseStore` keyed by this id so it survives unmount/remount
   * (virtualized scroll, tool-batch remounts) instead of resetting to
   * `defaultExpanded`.
   */
  persistKey?: string
  /**
   * Rendered below the collapsible body but inside the card boundary.
   * Used for nested sub-agent lists that must stay visible when the parent
   * card collapses.
   */
  footer?: ReactNode
}

export const BaseCard: React.FC<BaseCardProps> = ({
  status = 'idle',
  icon,
  title,
  subtitle,
  meta,
  actions,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onToggle,
  compact = false,
  className = '',
  alwaysOpen = false,
  footer,
  persistKey,
}) => {
  const [uncontrolled, setUncontrolled] = useState(() =>
    resolveInitialExpanded(persistKey, defaultExpanded),
  )
  const isControlled = controlledExpanded !== undefined
  const isExpanded = alwaysOpen || (isControlled ? !!controlledExpanded : uncontrolled)

  const toggle = useCallback(() => {
    if (alwaysOpen) return
    const next = !isExpanded
    if (!isControlled) {
      setUncontrolled(next)
      if (persistKey !== undefined) setCardExpanded(persistKey, next)
    }
    onToggle?.(next)
  }, [alwaysOpen, isControlled, isExpanded, onToggle, persistKey])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (alwaysOpen) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    },
    [alwaysOpen, toggle],
  )

  const clickable = !alwaysOpen
  const hasBody = !!children

  return (
    <div
      className={[
        'card',
        `card-status-${status}`,
        compact ? 'card-compact' : '',
        isExpanded ? 'is-expanded' : 'is-collapsed',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-status={status}
    >
      <span className="card-accent-bar" aria-hidden="true" />

      <div
        className="card-header"
        onClick={clickable ? toggle : undefined}
        onKeyDown={clickable ? onKeyDown : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? isExpanded : undefined}
      >
        <div className="card-header-left">
          {icon ? <span className="card-icon">{icon}</span> : null}
          <span className="card-title">{title}</span>
          {subtitle ? <span className="card-subtitle">{subtitle}</span> : null}
        </div>
        <div
          className="card-header-right"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {meta ? <span className="card-meta">{meta}</span> : null}
          {actions ? <span className="card-actions">{actions}</span> : null}
          {clickable ? (
            <ChevronRight
              size={14}
              className={`card-chevron ${isExpanded ? 'is-open' : ''}`}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>

      {hasBody && isExpanded ? <div className="card-body">{children}</div> : null}

      {footer ? <div className="card-footer">{footer}</div> : null}
    </div>
  )
}

// ─── CardSection ────────────────────────────────────────────────────────
// A labelled slot inside the card body. Handles the "label + optional copy
// button" pattern used everywhere (Input / Output / Diff / Error).

export interface CardSectionProps {
  label: ReactNode
  /** When set, a copy icon appears in the section header and puts this text on the clipboard. */
  copyText?: string
  /** Optional right-aligned extra node in the section header. */
  headerRight?: ReactNode
  children?: ReactNode
  /** Extra class on the section wrapper. */
  className?: string
}

export const CardSection: React.FC<CardSectionProps> = ({
  label,
  copyText,
  headerRight,
  children,
  className = '',
}) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable under restrictive policies — silent */
    }
  }, [copyText])

  return (
    <div className={['card-section', className].filter(Boolean).join(' ')}>
      <div className="card-section-header">
        <div className="card-section-label">{label}</div>
        <div className="card-section-header-right">
          {headerRight}
          {copyText ? (
            <button
              type="button"
              className="card-copy-btn"
              onClick={handleCopy}
              title="复制"
              aria-label="复制"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  )
}
