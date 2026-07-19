import React from 'react'
import { ChevronDown } from 'lucide-react'

export const IOSToggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <label className={`settings-toggle${disabled ? ' disabled' : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span className="settings-toggle-track" />
  </label>
)

export const SelectField: React.FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ label, hint, value, onChange, options }) => (
  <div className="settings-group">
    <label className="settings-label">{label}</label>
    <div className="settings-select-wrapper">
      <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
      <ChevronDown size={14} className="settings-select-icon" />
    </div>
    {hint && <p className="settings-hint">{hint}</p>}
  </div>
)

export const InputField: React.FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}> = ({ label, hint, value, onChange, placeholder, type = 'text' }) => (
  <div className="settings-group">
    <label className="settings-label">{label}</label>
    <input
      type={type}
      className="settings-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
    {hint && <p className="settings-hint">{hint}</p>}
  </div>
)

export const NumberField: React.FC<{
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}> = ({ label, hint, value, onChange, min, max }) => (
  <div className="settings-group">
    <label className="settings-label">{label}</label>
    <input
      type="number"
      className="settings-input"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
    />
    {hint && <p className="settings-hint">{hint}</p>}
  </div>
)

export const ToggleRow: React.FC<{
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, description, checked, onChange }) => (
  <div className="settings-group">
    <div className="settings-row-toggle">
      <div>
        <label className="settings-label">{label}</label>
        {description && <p className="settings-hint">{description}</p>}
      </div>
      <IOSToggle checked={checked} onChange={onChange} />
    </div>
  </div>
)

export const ChipGroup: React.FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; hint: string }>;
}> = ({ label, hint, value, onChange, options }) => (
  <div className="settings-group">
    <label className="settings-label">{label}</label>
    <div className="settings-chip-row">
      {options.map((o) => (
        <button
          key={o.value}
          className={`settings-chip${value === o.value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
    {hint && <p className="settings-hint">{hint}</p>}
  </div>
)
