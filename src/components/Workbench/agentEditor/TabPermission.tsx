import React from 'react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { SelectField, BooleanField, TextField } from './fields'
import { useT } from '../../../i18n'

export const TabPermission: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const tp = t.workbench.permission
  const inherit = t.workbench.inheritDefault
  const none = t.workbench.none
  return (
    <div className="agent-editor-panel">
      <SelectField
        label={tp.mode}
        hint={tp.modeHint}
        value={agent.permissionMode}
        options={[
          { value: '', label: inherit },
          { value: 'default', label: tp.modeDefault },
          { value: 'acceptEdits', label: tp.modeAcceptEdits },
          { value: 'plan', label: tp.modePlan },
          { value: 'bypassPermissions', label: tp.modeBypass },
        ]}
        onChange={(v) => onChange('permissionMode', v)}
      />
      <SelectField
        label={tp.parentPolicy}
        hint={tp.parentPolicyHint}
        value={agent.parentPolicy}
        options={[
          { value: '', label: inherit },
          { value: 'inherit', label: tp.parentInherit },
          { value: 'restricted', label: tp.parentRestricted },
          { value: 'isolated', label: tp.parentIsolated },
        ]}
        onChange={(v) => onChange('parentPolicy', v)}
      />
      <BooleanField
        label={tp.readOnly}
        hint={tp.readOnlyHint}
        value={agent.isReadOnly}
        onChange={(v) => onChange('isReadOnly', v)}
      />
      <BooleanField
        label={tp.omitClaudeMd}
        hint={tp.omitClaudeMdHint}
        value={agent.omitClaudeMd}
        onChange={(v) => onChange('omitClaudeMd', v)}
      />
      <SelectField
        label={tp.memory}
        hint={tp.memoryHint}
        value={agent.memory}
        options={[
          { value: '', label: none },
          { value: 'user', label: tp.memoryUser },
          { value: 'project', label: tp.memoryProject },
          { value: 'local', label: tp.memoryLocal },
        ]}
        onChange={(v) => onChange('memory', v)}
      />
      <SelectField
        label={tp.isolation}
        hint={tp.isolationHint}
        value={agent.isolation}
        options={[
          { value: '', label: none },
          { value: 'worktree', label: tp.isolationWorktree },
          { value: 'remote', label: tp.isolationRemote },
        ]}
        onChange={(v) => onChange('isolation', v)}
      />
      <BooleanField
        label={tp.background}
        hint={tp.backgroundHint}
        value={agent.background}
        onChange={(v) => onChange('background', v)}
      />
      <TextField
        label={tp.initialPrompt}
        hint={tp.initialPromptHint}
        value={agent.initialPrompt}
        multiline
        rows={3}
        onChange={(v) => onChange('initialPrompt', v || undefined)}
      />
      <TextField
        label={tp.criticalReminder}
        hint={tp.criticalReminderHint}
        value={agent.criticalReminder}
        multiline
        rows={3}
        onChange={(v) => onChange('criticalReminder', v || undefined)}
      />
    </div>
  )
}
