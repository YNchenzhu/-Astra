import React, { useCallback, useMemo } from 'react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { HookListEditor, type HookSpec } from '../../common/HookListEditor'
import { useT } from '../../../i18n'

/**
 * Tab 6 —— 智能体级钩子(agentHooks[])编辑。
 *
 * 空数组上报时通过 `onChange('agentHooks', undefined)` 走 null 哨兵
 * 清空路径,保证磁盘 JSON 不留 `agentHooks: []` 死条目。
 */
export const TabHooks: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const th = t.workbench.hooks
  const hooks: HookSpec[] = useMemo(
    () => (Array.isArray(agent.agentHooks) ? (agent.agentHooks as HookSpec[]) : []),
    [agent.agentHooks],
  )

  const handleChange = useCallback(
    (next: HookSpec[]) => {
      if (next.length === 0) {
        onChange('agentHooks', undefined)
      } else {
        // AgentBundleEntry.agentHooks 的类型是
        // AgentHookSpec[];HookSpec 与其字段完全一致。
        onChange('agentHooks', next as unknown as AgentBundleEntry['agentHooks'])
      }
    },
    [onChange],
  )

  return (
    <div className="agent-editor-panel">
      <div className="agent-editor-readonly-notice">
        {th.noticePrefix}<strong>{th.noticeStrong}</strong>{th.noticeSuffix}
      </div>
      <HookListEditor
        hooks={hooks}
        onChange={handleChange}
        addLabel={th.addLabel}
        emptyText={th.emptyText}
      />
    </div>
  )
}
