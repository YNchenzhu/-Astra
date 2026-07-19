import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Command } from 'lucide-react'
import {
  filterSlashCommands,
  type SlashCommandDefinition,
} from '../../data/slashCommands'

interface SlashCommandPopupProps {
  /** Query body after `/`. Empty string shows the full command list. */
  query: string
  onSelect: (command: SlashCommandDefinition) => void
  onClose: () => void
}

export const SlashCommandPopup: React.FC<SlashCommandPopupProps> = ({
  query,
  onSelect,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const filtered = filterSlashCommands(query)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (filtered.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        onSelect(filtered[selectedIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  if (filtered.length === 0) return null

  return (
    <div ref={containerRef} className="skill-popup">
      <div className="skill-popup-header">
        <Command size={12} />
        <span>Slash commands</span>
      </div>
      <div className="skill-popup-list">
        {filtered.map((cmd, idx) => (
          <div
            key={cmd.id}
            className={`skill-popup-item ${idx === selectedIndex ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIndex(idx)}
            onClick={() => onSelect(cmd)}
          >
            <div className="skill-popup-item-main">
              <span className="skill-popup-item-name">{cmd.label}</span>
              {cmd.argumentHint && (
                <span className="skill-popup-item-args">{cmd.argumentHint}</span>
              )}
            </div>
            <div className="skill-popup-item-desc">{cmd.description}</div>
            <span className="skill-popup-item-source manual-only">Host</span>
          </div>
        ))}
      </div>
      <div className="skill-popup-footer">
        <span>
          <kbd>Enter</kbd> to run
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
      </div>
    </div>
  )
}
