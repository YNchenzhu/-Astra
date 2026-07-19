import React from 'react'
import { useT } from '../../../i18n'

// ─── Field primitives ───────────────────────────────────────────────

/** Row layout wrapper — same grid as Sprint 1's read-only Field. */
export const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="agent-editor-field">
    <span className="agent-editor-field-label">{label}</span>
    <div className="agent-editor-field-value">
      {children}
      {hint ? <div className="agent-editor-field-hint">{hint}</div> : null}
    </div>
  </div>
)

interface TextFieldProps {
  label: string
  hint?: string
  value: string | undefined
  placeholder?: string
  onChange: (v: string | undefined) => void
  multiline?: boolean
  rows?: number
}
export const TextField: React.FC<TextFieldProps> = ({
  label,
  hint,
  value,
  placeholder,
  onChange,
  multiline,
  rows,
}) => (
  <Row label={label} hint={hint}>
    {multiline ? (
      <textarea
        className="agent-editor-input agent-editor-textarea"
        value={value ?? ''}
        rows={rows ?? 4}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.currentTarget.value
          // Empty string IS a meaningful user intent here ("clear this
          // field"). We pass it as empty-string; `normalizeAgent` on the
          // main side demotes it to undefined for the subset of fields
          // where that matters, preserving the legacy shape.
          onChange(v)
        }}
      />
    ) : (
      <input
        className="agent-editor-input"
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    )}
  </Row>
)

interface NumberFieldProps {
  label: string
  hint?: string
  value: number | undefined
  placeholder?: string
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
}
export const NumberField: React.FC<NumberFieldProps> = ({
  label,
  hint,
  value,
  placeholder,
  onChange,
  min,
  max,
}) => (
  <Row label={label} hint={hint}>
    <input
      className="agent-editor-input agent-editor-input-number"
      type="number"
      value={value === undefined ? '' : value}
      placeholder={placeholder}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = e.currentTarget.value
        if (raw === '') {
          onChange(undefined)
          return
        }
        const n = Number(raw)
        if (!Number.isFinite(n)) return
        onChange(n)
      }}
    />
  </Row>
)

interface BooleanFieldProps {
  label: string
  hint?: string
  value: boolean | undefined
  onChange: (v: boolean) => void
}
export const BooleanField: React.FC<BooleanFieldProps> = ({ label, hint, value, onChange }) => {
  const t = useT()
  return (
    <Row label={label} hint={hint}>
      <label className="agent-editor-checkbox">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span>{value === true ? t.workbench.fieldEnabled : t.workbench.fieldDisabled}</span>
      </label>
    </Row>
  )
}

interface SelectFieldProps<T extends string> {
  label: string
  hint?: string
  value: T | undefined
  options: ReadonlyArray<{ value: T | ''; label: string }>
  onChange: (v: T | undefined) => void
}
export function SelectField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  return (
    <Row label={label} hint={hint}>
      <select
        className="agent-editor-input agent-editor-select"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.currentTarget.value
          onChange(v === '' ? undefined : (v as T))
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </Row>
  )
}
