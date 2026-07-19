import React from 'react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { Row, TextField, BooleanField } from './fields'
import { useT } from '../../../i18n'

export const TabBasic: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const tb = t.workbench.basic
  return (
    <div className="agent-editor-panel">
      <TextField
        label={tb.displayName}
        hint={tb.displayNameHint}
        value={agent.displayName}
        placeholder={tb.displayNamePlaceholder}
        onChange={(v) => onChange('displayName', v || undefined)}
      />
      <Row label={tb.internalId} hint={tb.internalIdHint}>
        <span className="agent-editor-field-locked mono">{agent.agentType}</span>
      </Row>
      <TextField
        label={tb.tagline}
        value={agent.tagline}
        placeholder={tb.taglinePlaceholder}
        onChange={(v) => onChange('tagline', v || undefined)}
      />
      <TextField
        label={tb.whenToUse}
        hint={tb.whenToUseHint}
        value={agent.whenToUse}
        multiline
        rows={3}
        onChange={(v) => onChange('whenToUse', v)}
      />
      <TextField
        label={tb.capability}
        hint={tb.capabilityHint}
        value={agent.capability}
        placeholder={tb.capabilityPlaceholder}
        onChange={(v) => onChange('capability', v || undefined)}
      />
      <TextField
        label={tb.icon}
        hint={tb.iconHint}
        value={agent.icon}
        placeholder={tb.iconPlaceholder}
        onChange={(v) => onChange('icon', v || undefined)}
      />
      <TextField
        label={tb.color}
        hint={tb.colorHint}
        value={agent.color}
        placeholder={tb.colorPlaceholder}
        onChange={(v) => onChange('color', v || undefined)}
      />
      <BooleanField
        label={tb.setPrimary}
        hint={tb.setPrimaryHint}
        value={agent.isPrimary}
        onChange={(v) => onChange('isPrimary', v)}
      />
    </div>
  )
}
