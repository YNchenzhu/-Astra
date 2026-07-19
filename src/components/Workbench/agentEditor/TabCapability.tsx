import React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { AgentBundleEntry } from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { ALWAYS_AVAILABLE_SUBAGENT_TOOL_NAMES } from './constants'
import { Row } from './fields'
import { useCapabilityCatalogStore } from '../../../stores/capabilityCatalogStore'
import { MultiSelectEditor } from '../MultiSelectEditor'
import { useT } from '../../../i18n'

export const TabCapability: React.FC<{
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ agent, onChange }) => {
  const t = useT()
  const tc = t.workbench.capability
  const catalog = useCapabilityCatalogStore((s) => s.catalog)
  const loading = useCapabilityCatalogStore((s) => s.loading)
  const refresh = useCapabilityCatalogStore((s) => s.refresh)
  const catalogError = useCapabilityCatalogStore((s) => s.error)

  // tools 和 disallowedTools 共享工具目录;从工具目录里排除掉已经被
  // 对方列表选中的名字能避免"白黑名单同时包含同一工具"的悖论,但
  // 暂时不过滤 —— 用户可能有意这么做(比如先宽后禁)。保持直观简单。
  const toolsCatalog = catalog.tools

  return (
    <div className="agent-editor-panel">
      {catalogError ? (
        <div className="agent-editor-error-banner" role="alert">
          <AlertTriangle size={12} />
          <span>{tc.catalogLoadFailed}{catalogError}</span>
        </div>
      ) : null}

      <Row
        label={tc.allowedTools}
        hint={tc.allowedToolsHint}
      >
        <MultiSelectEditor
          value={agent.tools}
          onChange={(next) => onChange('tools', next)}
          catalog={toolsCatalog}
          loading={loading}
          onRefreshCatalog={() => void refresh()}
          allowCustom
          wildcardValue="*"
          wildcardLabel={tc.allWildcard}
          emptyText={tc.allowedEmpty}
          placeholder={tc.addTool}
          autoInjectedItems={ALWAYS_AVAILABLE_SUBAGENT_TOOL_NAMES}
          autoInjectedHint={tc.autoInjectedHint}
        />
      </Row>

      <Row
        label={tc.disallowedTools}
        hint={tc.disallowedToolsHint}
      >
        <MultiSelectEditor
          value={agent.disallowedTools}
          onChange={(next) => onChange('disallowedTools', next)}
          catalog={toolsCatalog}
          loading={loading}
          onRefreshCatalog={() => void refresh()}
          allowCustom
          wildcardValue={null}
          emptyText={tc.disallowedEmpty}
          placeholder={tc.addDisallowed}
        />
      </Row>

      <Row
        label={tc.skills}
        hint={tc.skillsHint}
      >
        <MultiSelectEditor
          value={agent.skills}
          onChange={(next) => onChange('skills', next)}
          catalog={catalog.skills}
          loading={loading}
          onRefreshCatalog={() => void refresh()}
          allowCustom={false}
          wildcardValue={null}
          emptyText={tc.skillsEmpty}
          placeholder={tc.addSkill}
        />
      </Row>

    </div>
  )
}
