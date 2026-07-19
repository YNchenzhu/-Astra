import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Zap, AtSign } from 'lucide-react'

export interface SkillItem {
  name: string
  description: string
  argumentHint?: string
  source: string
  disableModelInvocation?: boolean
}

interface SkillPopupProps {
  /** Current query text after the trigger character */
  query: string
  /** Which trigger character was used: '/' for slash command, '@' for skill attachment */
  trigger: '/' | '@'
  /** Called when a skill is selected */
  onSelect: (skill: SkillItem) => void
  /** Called when popup is dismissed */
  onClose: () => void
}

export const SkillPopup: React.FC<SkillPopupProps> = ({ query, trigger, onSelect, onClose }) => {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Declaring `loadSkills` before the `useEffect` that consumes it keeps
  // the closure reference valid at the point of capture (previously the
  // effect referenced the const above its declaration, which tripped
  // `react-hooks/immutability` even though the effect body only runs
  // after all module-scope bindings are initialised).
  const loadSkills = async () => {
    try {
      const result = await window.electronAPI.skills.list()
      setSkills(result.skills || [])
    } catch (error) {
      console.error('Failed to load skills:', error)
    }
  }

  // Load skills once. `loadSkills` transitively calls `setSkills`; the
  // rule follows the call graph so the suppression must live on the
  // call site inside the effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSkills()
  }, [])

  // Filter skills by query. Memoised so it doesn't re-scan the full skill
  // list on every unrelated re-render (e.g. selection move) and so the
  // `filtered` identity stays stable while query/skills are unchanged —
  // which keeps the keydown-listener effect from re-binding each render.
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q),
    )
  }, [skills, query])

  // Reset selection when query changes. True reactive reset, not a
  // derivation candidate (see sibling `CommandPalette` effects for the
  // same pattern + rationale).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIndex(0)
  }, [query])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      onSelect(filtered[selectedIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab' && filtered.length > 0) {
      e.preventDefault()
      onSelect(filtered[selectedIndex])
    }
  }, [filtered, selectedIndex, onSelect, onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  // Close on outside click
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

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'bundled': return 'Built-in'
      case 'project': return 'Project'
      case 'user': return 'User'
      default: return source
    }
  }

  const headerIcon = trigger === '/' ? <Zap size={12} /> : <AtSign size={12} />
  const headerText = trigger === '/' ? 'Skills' : 'Attach Skill'

  return (
    <div ref={containerRef} className="skill-popup">
      <div className="skill-popup-header">
        {headerIcon}
        <span>{headerText}</span>
      </div>
      <div className="skill-popup-list">
        {filtered.map((skill, idx) => (
          <div
            key={skill.name}
            className={`skill-popup-item ${idx === selectedIndex ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIndex(idx)}
            onClick={() => onSelect(skill)}
          >
            <div className="skill-popup-item-main">
              <span className="skill-popup-item-name">{trigger}{skill.name}</span>
              {skill.argumentHint && (
                <span className="skill-popup-item-args">{skill.argumentHint}</span>
              )}
            </div>
            <div className="skill-popup-item-desc">{skill.description}</div>
            <span className={`skill-popup-item-source ${skill.source}`}>
              {sourceLabel(skill.source)}
            </span>
            {skill.disableModelInvocation && (
              <span className="skill-popup-item-source manual-only">Manual</span>
            )}
          </div>
        ))}
      </div>
      <div className="skill-popup-footer">
        <span><kbd>Enter</kbd> to select</span>
        <span><kbd>Esc</kbd> to close</span>
      </div>
    </div>
  )
}
