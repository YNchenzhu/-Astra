/**
 * CommandChip — the only container-ful feed entry, reserved for shell
 * and PowerShell invocations because those are user-auditable
 * executables that deserve visual weight over, say, a file read.
 *
 * Visual contract (intentionally minimal — see `CommandChip.css`):
 *   - 1px hairline border + very slightly darker background tint;
 *     "hints at a container" rather than "is a card".
 *   - Two lines: top shows a `>_` prefix + the command (truncated to a
 *     single line when collapsed), bottom is hidden until expanded and
 *     holds the full stdout / stderr stream.
 *   - Same status-dot language as `ActivityRow` for consistency.
 *
 * Performance: memoized on shallow props. The `children` slot is where
 * callers render their task-output streams; those should themselves be
 * keyed / memoized to avoid re-rendering the whole chip on every chunk.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight, Terminal } from 'lucide-react'
import type { CardStatus } from '../cards/BaseCard'
import { getCardExpanded, resolveInitialExpanded, setCardExpanded } from '../cardCollapseStore'
import './CommandChip.css'

export interface CommandChipProps {
  /** Which shell produced the command — tweaks the leading glyph tooltip. */
  shell: 'bash' | 'powershell'
  /** The command string as the agent issued it. */
  command: string
  /** Drives the status dot (same semantics as `ActivityRow.status`). */
  status?: CardStatus
  /** Optional trailing meta (duration, exit code). */
  meta?: ReactNode
  /** Right-aligned action buttons (Stop / Retry); clicks don't toggle the chip. */
  actions?: ReactNode
  /** Expanded drawer contents (usually the live stdout/stderr stream). */
  children?: ReactNode
  defaultExpanded?: boolean
  /** Opens when details become available, until the user manually toggles. */
  autoExpand?: boolean
  /**
   * When set, the expand state is persisted in `cardCollapseStore` keyed by
   * this id so it survives unmount/remount (virtualized scroll, tool-batch
   * remounts) instead of resetting to `defaultExpanded`.
   */
  persistKey?: string
  className?: string
}

const CommandChipImpl: React.FC<CommandChipProps> = ({
  shell,
  command,
  status = 'idle',
  meta,
  actions,
  children,
  defaultExpanded = false,
  autoExpand = false,
  persistKey,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(() =>
    resolveInitialExpanded(persistKey, defaultExpanded),
  )
  // Treat a persisted choice as a prior user toggle so `autoExpand` won't
  // re-open a card the user deliberately collapsed before it was unmounted.
  const userToggledRef = useRef(
    persistKey !== undefined && getCardExpanded(persistKey) !== undefined,
  )
  const hasDetails = !!children

  const applyToggle = useCallback(() => {
    userToggledRef.current = true
    setExpanded((v) => {
      const next = !v
      if (persistKey !== undefined) setCardExpanded(persistKey, next)
      return next
    })
  }, [persistKey])

  const toggle = useCallback(() => {
    if (!hasDetails) return
    applyToggle()
  }, [hasDetails, applyToggle])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!hasDetails) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        applyToggle()
      }
    },
    [hasDetails, applyToggle],
  )

  useEffect(() => {
    if (!autoExpand || !hasDetails || userToggledRef.current) return
    // One-shot auto-open on prop flip; pure derivation would need a
    // `prevAutoExpand` ref to detect the rising edge AND honour the
    // user-toggle escape hatch — exactly the shape this rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(true)
  }, [autoExpand, hasDetails])

  const firstLine = command.split(/\r?\n/, 1)[0] ?? ''
  const isMultiline = /\r?\n/.test(command)

  return (
    <div
      className={[
        'command-chip',
        `command-status-${status}`,
        hasDetails ? 'command-interactive' : '',
        expanded ? 'is-expanded' : 'is-collapsed',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-shell={shell}
    >
      <div
        className="command-chip-line"
        onClick={hasDetails ? toggle : undefined}
        onKeyDown={hasDetails ? onKeyDown : undefined}
        role={hasDetails ? 'button' : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <Terminal size={12} className="command-chip-glyph" aria-hidden="true" />
        {status !== 'idle' ? (
          <span
            className={`command-dot command-dot-${status}`}
            aria-hidden="true"
          />
        ) : null}
        <code className="command-chip-text">
          {firstLine}
          {isMultiline ? ' …' : null}
        </code>
        {meta ? <span className="command-chip-meta">{meta}</span> : null}
        {actions ? (
          // stopPropagation on keydown too — otherwise Enter on a focused
          // Stop/Retry button also toggles the chip via the parent handler.
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
            className={`command-chip-chevron ${expanded ? 'is-open' : ''}`}
            aria-hidden="true"
          />
        ) : null}
      </div>

      {hasDetails && expanded ? (
        <div className="command-chip-body">
          {isMultiline ? (
            <pre className="command-chip-full">{command}</pre>
          ) : null}
          <div className="command-chip-output">{children}</div>
        </div>
      ) : null}
    </div>
  )
}

export const CommandChip = memo(CommandChipImpl)
