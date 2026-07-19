import React from 'react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { Row, SelectField } from './fields'
import { useT } from '../../../i18n'

export const TabCoordination: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const tco = t.workbench.coordination
  const role = agent.orchestrationRole
  // "应用推荐配置" — set sibling fields that the chosen role implies.
  // Kept conservative: we only flip `isReadOnly` and `coordinatorPhase`.
  // Tools are role-AND-domain specific so we never auto-mutate the tool
  // surface — the user picks tools manually.
  const handleApplyRecommended = () => {
    if (!role || role === 'solo') return
    if (role === 'readonly-worker' || role === 'verifier') {
      onChange('isReadOnly', true)
    } else if (role === 'writing-worker' || role === 'coordinator') {
      onChange('isReadOnly', false)
    }
    if (role === 'verifier') {
      onChange('coordinatorPhase', 'verification')
    }
  }
  return (
    <div className="agent-editor-panel">
      <SelectField
        label={tco.role}
        hint={tco.roleHint}
        value={agent.orchestrationRole}
        options={[
          { value: '', label: tco.roleAuto },
          { value: 'solo', label: tco.roleSolo },
          { value: 'readonly-worker', label: tco.roleReadonly },
          { value: 'writing-worker', label: tco.roleWriting },
          { value: 'coordinator', label: tco.roleCoordinator },
          { value: 'verifier', label: tco.roleVerifier },
        ]}
        onChange={(v) => onChange('orchestrationRole', v)}
      />
      {role && role !== 'solo' ? (
        <Row
          label=""
          hint={tco.applyRecommendedHint}
        >
          <button
            type="button"
            className="agent-editor-input"
            style={{ cursor: 'pointer', textAlign: 'left' }}
            onClick={handleApplyRecommended}
          >
            {tco.applyRecommended(role === 'verifier')}
          </button>
        </Row>
      ) : null}
      <SelectField
        label={tco.phase}
        hint={tco.phaseHint}
        value={agent.coordinatorPhase}
        options={[
          { value: '', label: t.workbench.none },
          { value: 'research', label: tco.phaseResearch },
          { value: 'synthesis', label: tco.phaseSynthesis },
          { value: 'implementation', label: tco.phaseImplementation },
          { value: 'verification', label: tco.phaseVerification },
        ]}
        onChange={(v) => onChange('coordinatorPhase', v)}
      />
      <SelectField
        label={tco.toolProfile}
        hint={tco.toolProfileHint}
        value={agent.subagentToolProfile}
        options={[
          { value: '', label: t.workbench.inheritDefault },
          { value: 'default', label: tco.toolProfileDefault },
          { value: 'async_agent', label: tco.toolProfileAsync },
          { value: 'in_process_teammate', label: tco.toolProfileInProcess },
        ]}
        onChange={(v) => onChange('subagentToolProfile', v)}
      />
      <div className="agent-editor-empty-block">
        {tco.teamVizNote}
      </div>
    </div>
  )
}
