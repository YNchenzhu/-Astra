/**
 * ActivityRow — the default feed entry for tool invocations.
 *
 * Visual contract:
 *   - No background, no border. Just a single text line that reads like a
 *     sentence: `<action> <subject> <meta>`.
 *   - The action word is rendered in the main foreground colour; subject
 *     and meta are muted so a transcript of 30 tool calls scans quickly
 *     without drowning the actual AI prose.
 *   - Clicking the row toggles an optional details drawer (Input / Output
 *     / Error) that opens inline below, also without a container — keeps
 *     the whole surface visually flat.
 *   - A trailing status dot replaces the colourful chips of the previous
 *     "BaseCard" revision: it's a single 6px filled circle in the current
 *     accent (blue = running / green = success / red = error) and is
 *     invisible for idle rows.
 *
 * Performance:
 *   - The component is wrapped in `React.memo`. During streaming, a row
 *     only re-renders when its own status, subject, meta, or children
 *     change — not when an unrelated neighbour does. Consumers should
 *     pass stable callback references when interactive.
 */
import React, {
  memo,
  useCallback,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight } from 'lucide-react'
import type { CardStatus } from '../cards/BaseCard'
import { resolveInitialExpanded, setCardExpanded } from '../cardCollapseStore'
import './ActivityRow.css'

export interface ActivityRowProps {
  /** Short verb ("Read", "Edited", "Grepped"). Rendered in primary text. */
  actionWord: string
  /** Path / query / url — rendered muted next to the verb. */
  subject?: ReactNode
  /** Trailing metadata (line range, diff size, duration). Smaller + muted. */
  meta?: ReactNode
  /**
   * Right-aligned action buttons (Stop / Retry). Clicks are stop-propagated
   * so they don't toggle the details drawer.
   */
  actions?: ReactNode
  /** Drives the status dot colour; omit to hide the dot entirely. */
  status?: CardStatus
  /**
   * Optional details region. When present, the row becomes interactive
   * (keyboard + click) and a chevron appears on the right. When absent,
   * the row is a passive one-liner.
   */
  children?: ReactNode
  /** Initial expand state (uncontrolled). Ignored when `expanded` is provided. */
  defaultExpanded?: boolean
  /**
   * Controlled expand state. When set, the row defers to the caller for
   * expand/collapse decisions — useful for auto-expand-during-streaming
   * patterns (see `ThinkingBlock`).
   */
  expanded?: boolean
  /** Fired whenever the user activates the header. Pair with `expanded`. */
  onExpandedChange?: (next: boolean) => void
  /**
   * When set (and the row is uncontrolled), the expand state is persisted in
   * `cardCollapseStore` keyed by this id, so it survives unmount/remount
   * (virtualized scroll, tool-batch remounts). Without it the row resets to
   * `defaultExpanded` on every remount.
   */
  persistKey?: string
  /** Extra class name on the root element. */
  className?: string
}

const ActivityRowImpl: React.FC<ActivityRowProps> = ({
  actionWord,
  subject,
  meta,
  actions,
  status = 'idle',
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  persistKey,
  className = '',
}) => {
  const [uncontrolled, setUncontrolled] = useState(() =>
    resolveInitialExpanded(persistKey, defaultExpanded),
  )
  const hasDetails = !!children
  const isControlled = controlledExpanded !== undefined
  const expanded = isControlled ? !!controlledExpanded : uncontrolled

  const toggle = useCallback(() => {
    if (!hasDetails) return
    const next = !expanded
    if (!isControlled) {
      setUncontrolled(next)
      if (persistKey !== undefined) setCardExpanded(persistKey, next)
    }
    onExpandedChange?.(next)
  }, [expanded, hasDetails, isControlled, onExpandedChange, persistKey])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!hasDetails) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    },
    [hasDetails, toggle],
  )

  return (
    <div
      className={[
        'activity-row',
        `activity-status-${status}`,
        hasDetails ? 'activity-interactive' : '',
        expanded ? 'is-expanded' : 'is-collapsed',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="activity-line"
        onClick={hasDetails ? toggle : undefined}
        onKeyDown={hasDetails ? onKeyDown : undefined}
        role={hasDetails ? 'button' : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        aria-expanded={hasDetails ? expanded : undefined}
        data-status={status}
      >
        {status !== 'idle' ? (
          <span
            className={`activity-dot activity-dot-${status}`}
            aria-hidden="true"
          />
        ) : null}
        <span className="activity-action">{actionWord}</span>
        {subject ? <span className="activity-subject">{subject}</span> : null}
        {meta ? <span className="activity-meta">{meta}</span> : null}
        {actions ? (
          // Stop BOTH click and keydown: the row's own handlers live on the
          // parent div, so an Enter/Space press on a focused action button
          // would otherwise activate the button AND toggle the drawer.
          <span
            className="activity-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        ) : null}
        {hasDetails ? (
          <ChevronRight
            size={12}
            className={`activity-chevron ${expanded ? 'is-open' : ''}`}
            aria-hidden="true"
          />
        ) : null}
      </div>

      {hasDetails && expanded ? (
        <div className="activity-details">{children}</div>
      ) : null}
    </div>
  )
}

/**
 * `React.memo` with default shallow comparison is sufficient here:
 *   - Primitives (actionWord, subject as string, status) compare by value
 *   - `children` in streaming transcripts change identity only when the
 *     upstream row actually has new content — parent components must use
 *     stable keys / memoized children to benefit fully.
 */
export const ActivityRow = memo(ActivityRowImpl)
