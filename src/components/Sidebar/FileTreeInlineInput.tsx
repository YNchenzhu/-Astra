import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'

const InlineInput: React.FC<{
  initialName: string
  onCommit: (name: string) => void
  onCancel: () => void
}> = ({ initialName, onCommit, onCancel }) => {
  const t = useT()
  const [value, setValue] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guard against double-fire: Enter's onKeyDown calls onCommit, which kicks
  // off an async refreshFileTree; meanwhile blur can still fire before the
  // input unmounts and would call onCommit/onCancel a second time.
  const finalizedRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = initialName.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initialName])

  const finalize = (kind: 'commit' | 'cancel', v: string) => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    if (kind === 'commit') onCommit(v)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      className="tree-inline-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          finalize('commit', value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finalize('cancel', value)
        } else {
          e.stopPropagation()
        }
      }}
      onBlur={() => {
        // VS Code-style: clicking elsewhere commits if name changed.
        if (value.trim() && value.trim() !== initialName) finalize('commit', value)
        else finalize('cancel', value)
      }}
      placeholder={t.fileTree.inlinePlaceholder}
      spellCheck={false}
      autoComplete="off"
    />
  )
}

export default InlineInput
