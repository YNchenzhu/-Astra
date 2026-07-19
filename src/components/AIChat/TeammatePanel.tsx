import React, { useMemo, useState } from 'react'
import { useTeammateManagement } from '../../hooks/useTeammateManagement'
import { useExecutionStore } from '../../stores/executionStore'
import { AgentExecutor } from './AgentExecutor'
import type { SpawnTeammateConfig } from '../../services/agent/spawnInProcess'
import './TeammatePanel.css'

export const TeammatePanel: React.FC = () => {
  const { createTeammate, removeTeammate, getTeammates, error } = useTeammateManagement()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [formData, setFormData] = useState<SpawnTeammateConfig>({
    name: '',
    teamName: 'default',
    prompt: '',
    planModeRequired: false,
  })

  const teammates = getTeammates()
  const clearCompleted = useExecutionStore((s) => s.clearCompleted)
  const completedCount = useMemo(
    () =>
      teammates.filter(
        (t) =>
          t.status === 'completed' || t.status === 'failed' || t.status === 'stopped',
      ).length,
    [teammates],
  )

  const handleClearCompleted = () => {
    // If the currently-selected task is one of the completed ones, drop the
    // selection so the executor pane isn't left pointing at a stale id.
    if (selectedTaskId) {
      const sel = teammates.find((t) => t.id === selectedTaskId)
      if (sel && (sel.status === 'completed' || sel.status === 'failed' || sel.status === 'stopped')) {
        setSelectedTaskId(null)
      }
    }
    clearCompleted()
  }

  const handleCreate = () => {
    if (!formData.name || !formData.prompt) return
    const taskId = createTeammate(formData)
    if (taskId) {
      setSelectedTaskId(taskId)
      setShowCreateForm(false)
      setFormData({ name: '', teamName: 'default', prompt: '', planModeRequired: false })
    }
  }

  return (
    <div className="teammate-panel">
      <div className="teammate-panel-header">
        <h2>团队成员</h2>
        <div className="teammate-panel-header-actions">
          {completedCount > 0 && (
            <button
              onClick={handleClearCompleted}
              className="teammate-panel-action-btn"
              title="移除所有已完成 / 失败 / 已停止的成员"
            >
              清理已完成 ({completedCount})
            </button>
          )}
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="teammate-panel-action-btn"
          >
            + 新建
          </button>
        </div>
      </div>

      {showCreateForm && (
        <div className="teammate-form">
          <input
            type="text"
            placeholder="成员名称"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="teammate-input"
          />
          <input
            type="text"
            placeholder="团队名称"
            value={formData.teamName}
            onChange={(e) => setFormData({ ...formData, teamName: e.target.value })}
            className="teammate-input"
          />
          <textarea
            placeholder="提示词 / 任务描述"
            value={formData.prompt}
            onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
            className="teammate-textarea"
          />
          <label className="teammate-checkbox-row">
            <input
              type="checkbox"
              checked={formData.planModeRequired}
              onChange={(e) => setFormData({ ...formData, planModeRequired: e.target.checked })}
            />
            需要计划审批
          </label>
          <div className="teammate-form-actions">
            <button
              onClick={handleCreate}
              className="teammate-small-btn primary"
            >
              创建
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="teammate-small-btn"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="teammate-error">{error}</div>
      )}

      <div className="teammate-list">
        {teammates.length === 0 ? (
          <div className="teammate-empty">
            暂无团队成员。点击「+ 新建」来创建一个。
          </div>
        ) : (
          <div>
            {teammates.map((teammate) => (
              <div
                key={teammate.id}
                className={`teammate-item ${selectedTaskId === teammate.id ? 'selected' : ''}`}
                onClick={() => setSelectedTaskId(teammate.id)}
              >
                <div className="teammate-item-head">
                  <div className="teammate-item-main">
                    <div
                      className={`teammate-status-dot ${
                        teammate.status === 'running'
                          ? 'running'
                          : teammate.status === 'completed'
                            ? 'completed'
                            : teammate.status === 'failed'
                              ? 'failed'
                              : 'idle'
                      }`}
                    />
                    <span className="teammate-name">{teammate.identity.agentName}</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeTeammate(teammate.id)
                    }}
                    className="teammate-remove-btn"
                  >
                    移除
                  </button>
                </div>
                <p className="teammate-prompt">{teammate.prompt}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedTaskId && (
        <div className="teammate-executor-wrap">
          <AgentExecutor taskId={selectedTaskId} />
        </div>
      )}
    </div>
  )
}
