import React from 'react'
import {
  Files,
  Search,
  GitBranch,
  Blocks,
  Sparkles,
  Layers,
  Settings,
  SlidersHorizontal,
  Activity,
} from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useBundleStore } from '../../stores/bundleStore'
import { useT } from '../../i18n'
import type { SidebarView } from '../../types'
import './ActivityBar.css'

const topItems: { id: SidebarView; icon: React.ElementType }[] = [
  { id: 'explorer', icon: Files },
  { id: 'search', icon: Search },
  { id: 'git', icon: GitBranch },
  { id: 'extensions', icon: Blocks },
]

// Sprint 3.2: all three bundle-level entries are now live.
// (Gallery / Workbench / Running Agents) — no stubs remain.

export const ActivityBar: React.FC = () => {
  // 性能:精细订阅,每个字段单独 selector,避免全量解构导致 store
  // 内任一无关字段(terminalVisible / sidebarVisible / 等)变化都
  // 触发整条 ActivityBar re-render。hover/点击的视觉响应因此更跟手。
  const sidebarView = useLayoutStore((s) => s.sidebarView)
  const setSidebarView = useLayoutStore((s) => s.setSidebarView)
  const aiChatVisible = useLayoutStore((s) => s.aiChatVisible)
  const toggleAIChat = useLayoutStore((s) => s.toggleAIChat)
  const composerVisible = useLayoutStore((s) => s.composerVisible)
  const toggleComposer = useLayoutStore((s) => s.toggleComposer)
  const workbenchVisible = useLayoutStore((s) => s.workbenchVisible)
  const toggleWorkbench = useLayoutStore((s) => s.toggleWorkbench)
  const runningAgentsPanelVisible = useLayoutStore((s) => s.runningAgentsPanelVisible)
  const toggleRunningAgentsPanel = useLayoutStore((s) => s.toggleRunningAgentsPanel)
  const setShowSettings = useSettingsStore((s) => s.setShowSettings)
  // 性能:只订阅"是否有激活 bundle"一个布尔,不要整个 bundle 对象。
  // 任何 agent/team/meta 保存都不会影响这个布尔,因此 ActivityBar
  // 不会被 upsertBundle 广播触发重渲染。
  const hasActiveBundle = useBundleStore((s) => s.activeBundleId !== null)
  const t = useT()
  const itemTitles: Record<SidebarView, string> = {
    explorer: t.activityBar.explorer,
    search: t.activityBar.search,
    git: t.activityBar.git,
    extensions: t.activityBar.extensions,
  }

  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        {/* Bundle stubs — top group, above the classic sidebar view
            switchers. Present only when the bundle store has hydrated
            so the stub cluster doesn't flash in on cold start. The
            divider is drawn as a CSS ::after on the cluster. */}
        {hasActiveBundle && (
          <div className="activity-bar-bundle-group" aria-label={t.activityBar.workbenchEntry}>
            {/* 工作包库入口已移除:新建工作包用 TabBar 的 + 按钮,
                浏览/管理用下方"智能体工作台"。 */}

            {/* Workbench — 智能体 / 团队 / 工作包编辑。 */}
            <button
              className={`activity-bar-item activity-bar-bundle-stub ${
                workbenchVisible ? 'active' : ''
              }`}
              title={t.activityBar.workbench}
              onClick={toggleWorkbench}
              data-stub-id="workbench"
            >
              <SlidersHorizontal size={22} strokeWidth={1.5} />
            </button>

            {/* Running Agents — 实时查看 ActiveAgent registry + 终止失控 agent。 */}
            <button
              className={`activity-bar-item activity-bar-bundle-stub ${
                runningAgentsPanelVisible ? 'active' : ''
              }`}
              title={t.activityBar.runningAgents}
              onClick={toggleRunningAgentsPanel}
              data-stub-id="running-agents"
            >
              <Activity size={22} strokeWidth={1.5} />
            </button>
          </div>
        )}

        {topItems.map(({ id, icon: Icon }) => (
          <button
            key={id}
            className={`activity-bar-item ${sidebarView === id ? 'active' : ''}`}
            title={itemTitles[id]}
            onClick={() => setSidebarView(id)}
          >
            <Icon size={24} strokeWidth={1.5} />
          </button>
        ))}
      </div>
      <div className="activity-bar-bottom">
        <button
          className={`activity-bar-item ${aiChatVisible ? 'active' : ''}`}
          title={t.activityBar.aiChat}
          onClick={toggleAIChat}
        >
          <Sparkles size={24} strokeWidth={1.5} />
        </button>
        <button
          className={`activity-bar-item ${composerVisible ? 'active' : ''}`}
          title={t.activityBar.composer}
          onClick={toggleComposer}
        >
          <Layers size={24} strokeWidth={1.5} />
        </button>
        <button className="activity-bar-item" title={t.activityBar.settings} onClick={() => setShowSettings(true)}>
          <Settings size={24} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
