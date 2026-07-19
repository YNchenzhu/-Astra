import React from 'react'
import { FileText, Copy, X } from 'lucide-react'
import { buildBuiltinAgentMeta } from './agentConstants'
import { useT } from '../../../i18n'
import type { useAgentsPanelState } from './useAgentsPanelState'

type PanelState = ReturnType<typeof useAgentsPanelState>

interface PromptViewerModalProps {
  showPrompt: string
  setShowPrompt: PanelState['setShowPrompt']
  tab: PanelState['tab']
  customAgents: PanelState['customAgents']
  copiedId: PanelState['copiedId']
  handleCopyPrompt: PanelState['handleCopyPrompt']
}

export const PromptViewerModal: React.FC<PromptViewerModalProps> = ({
  showPrompt,
  setShowPrompt,
  tab,
  customAgents,
  copiedId,
  handleCopyPrompt,
}) => {
  const t = useT().settings.agents
  const BUILTIN_AGENT_META = React.useMemo(() => buildBuiltinAgentMeta(t), [t])
  return (
    <div className="agent-prompt-overlay" onClick={() => setShowPrompt(null)}>
      <div className="agent-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="agent-prompt-header">
          <h4>
            <FileText size={16} />
            {tab === 'builtin'
              ? `${BUILTIN_AGENT_META.find((a) => a.agentType === showPrompt)?.name || ''}${t.viewerSystemSuffix}`
              : `${customAgents.find((a) => a.id === showPrompt)?.name || ''}${t.viewerPromptSuffix}`}
          </h4>
          <div className="agent-prompt-actions">
            <button
              className="agent-prompt-btn"
              onClick={() => {
                const text = tab === 'builtin'
                  ? BUILTIN_AGENT_META.find((a) => a.agentType === showPrompt)?.whenToUse || ''
                  : customAgents.find((a) => a.id === showPrompt)?.prompt || ''
                handleCopyPrompt(text, 'prompt-viewer')
              }}
              title={t.copy}
            >
              {copiedId === 'prompt-viewer' ? t.copied : <Copy size={13} />}
            </button>
            <button className="agent-prompt-btn" onClick={() => setShowPrompt(null)} title={t.close}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="agent-prompt-body">
          {tab === 'builtin'
            ? BUILTIN_AGENT_META.find((a) => a.agentType === showPrompt)?.whenToUse
            : customAgents.find((a) => a.id === showPrompt)?.prompt}
        </div>
      </div>
    </div>
  )
}
