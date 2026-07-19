import React from 'react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { NumberField, SelectField } from './fields'
import { useT } from '../../../i18n'

export const TabModel: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const tm = t.workbench.model
  return (
    <div className="agent-editor-panel">
      <NumberField
        label={tm.maxTurns}
        hint={tm.maxTurnsHint}
        value={agent.maxTurns}
        placeholder={tm.maxTurnsPlaceholder}
        min={0}
        max={10000}
        onChange={(v) => onChange('maxTurns', v)}
      />
      <NumberField
        label={tm.tokenBudget}
        hint={tm.tokenBudgetHint}
        value={agent.maxTokenBudget}
        placeholder={tm.tokenBudgetPlaceholder}
        min={0}
        max={50_000_000}
        onChange={(v) => onChange('maxTokenBudget', v)}
      />
      <NumberField
        label={tm.timeout}
        hint={tm.timeoutHint}
        value={agent.timeout}
        placeholder={tm.timeoutPlaceholder}
        min={0}
        max={24 * 60 * 60 * 1000}
        onChange={(v) => onChange('timeout', v)}
      />
      <NumberField
        label={tm.thinkingBudget}
        hint={tm.thinkingBudgetHint}
        value={agent.thinkingBudgetTokens}
        placeholder={tm.thinkingBudgetPlaceholder}
        min={0}
        max={1_000_000}
        onChange={(v) => onChange('thinkingBudgetTokens', v)}
      />
      <SelectField
        label={tm.effort}
        hint={tm.effortHint}
        value={agent.effort}
        options={[
          { value: '', label: t.workbench.inheritDefault },
          { value: 'low', label: tm.effortLow },
          { value: 'medium', label: tm.effortMedium },
          { value: 'high', label: tm.effortHigh },
          { value: 'max', label: tm.effortMax },
        ]}
        onChange={(v) => onChange('effort', v)}
      />
    </div>
  )
}
