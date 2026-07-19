/**
 * TeamMemberList —— 团队成员增删编辑（Sprint 2c.1）
 *
 * 每个成员 = `TeamMember = { agentType, role?, parallelGroup? }`
 *
 * UX:
 *   - 每成员一行:[agentType 下拉] [role 输入] [阶段数字 / —]
 *   - 上下移动 / 删除按钮
 *   - 底部「添加成员」 —— 打开一个额外的 agentType 下拉,可快速添加
 *   - 当协调方式是 sequential 时,显示 parallelGroup (阶段索引);
 *     其它协调方式下此列隐藏,减少视觉噪音(数据仍保留,不删除)
 *
 * 成员 agentType 必须是当前 bundle 中存在的 agent,由下拉限制选择;
 * 输入自定义 agentType 不被允许(服务端 validateBundleSemantics 也会
 * 拒绝未知 agent,双重保护)。
 */

import React, { useCallback } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Users } from 'lucide-react'
import type { TeamMember, TeamTemplate } from '../../../electron/agents/bundles/types'
import { useT } from '../../i18n'
import './TeamMemberList.css'

export interface AvailableAgent {
  agentType: string
  displayName?: string
}

export interface TeamMemberListProps {
  members: TeamMember[]
  availableAgents: AvailableAgent[]
  coordination: TeamTemplate['coordination']
  onChange: (next: TeamMember[]) => void
}

export const TeamMemberList: React.FC<TeamMemberListProps> = ({
  members,
  availableAgents,
  coordination,
  onChange,
}) => {
  const t = useT()
  const tm = t.workbench.teamMember
  const showStage = coordination === 'sequential'

  const emit = useCallback((next: TeamMember[]) => onChange(next), [onChange])

  const firstAvailable = availableAgents[0]?.agentType

  const handleAdd = useCallback(() => {
    if (!firstAvailable) return
    emit([...members, { agentType: firstAvailable }])
  }, [members, emit, firstAvailable])

  const handleDelete = useCallback(
    (idx: number) => {
      const next = members.slice()
      next.splice(idx, 1)
      emit(next)
    },
    [members, emit],
  )

  const handleMove = useCallback(
    (idx: number, direction: -1 | 1) => {
      const t = idx + direction
      if (t < 0 || t >= members.length) return
      const next = members.slice()
      ;[next[idx], next[t]] = [next[t], next[idx]]
      emit(next)
    },
    [members, emit],
  )

  const handleField = useCallback(
    <K extends keyof TeamMember>(idx: number, field: K, value: TeamMember[K]) => {
      const next = members.slice()
      next[idx] = { ...next[idx], [field]: value }
      emit(next)
    },
    [members, emit],
  )

  if (availableAgents.length === 0) {
    return (
      <div className="member-list-empty">
        {tm.noAgents}
      </div>
    )
  }

  return (
    <div className="member-list">
      {members.length === 0 ? (
        <div className="member-list-empty">
          <Users size={14} />
          <span>{tm.noMembers}</span>
        </div>
      ) : (
        members.map((m, idx) => {
          const isFirst = idx === 0
          const isLast = idx === members.length - 1
          // agentType 已知(在 availableAgents 里)时下拉;否则保留并显示为
          // "未知"选项(不直接丢弃,给用户一个改回合法值的机会)。
          const knownAgent = availableAgents.some((a) => a.agentType === m.agentType)

          return (
            <div key={idx} className="member-row">
              <span className="member-row-index">#{idx + 1}</span>

              <select
                className="member-row-agent"
                value={m.agentType}
                onChange={(e) => handleField(idx, 'agentType', e.currentTarget.value)}
                title={tm.selectAgent}
              >
                {!knownAgent ? (
                  <option value={m.agentType} disabled>
                    {m.agentType}{tm.unknownSuffix}
                  </option>
                ) : null}
                {availableAgents.map((a) => (
                  <option key={a.agentType} value={a.agentType}>
                    {a.displayName ? `${a.displayName} · ${a.agentType}` : a.agentType}
                  </option>
                ))}
              </select>

              <input
                className="member-row-role"
                type="text"
                value={m.role ?? ''}
                placeholder={tm.rolePlaceholder}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  handleField(idx, 'role', v.length > 0 ? v : undefined)
                }}
              />

              {showStage ? (
                <input
                  className="member-row-stage"
                  type="number"
                  min={0}
                  max={1024}
                  placeholder={tm.stagePlaceholder}
                  value={m.parallelGroup === undefined ? '' : m.parallelGroup}
                  title={tm.stageTitle}
                  onChange={(e) => {
                    const raw = e.currentTarget.value
                    if (raw === '') {
                      handleField(idx, 'parallelGroup', undefined)
                      return
                    }
                    const n = Number(raw)
                    if (!Number.isFinite(n)) return
                    handleField(idx, 'parallelGroup', n)
                  }}
                />
              ) : null}

              <div className="member-row-actions">
                <button
                  type="button"
                  className="member-icon-btn"
                  title={tm.moveUp}
                  disabled={isFirst}
                  onClick={() => handleMove(idx, -1)}
                >
                  <ArrowUp size={11} />
                </button>
                <button
                  type="button"
                  className="member-icon-btn"
                  title={tm.moveDown}
                  disabled={isLast}
                  onClick={() => handleMove(idx, 1)}
                >
                  <ArrowDown size={11} />
                </button>
                <button
                  type="button"
                  className="member-icon-btn member-icon-btn-danger"
                  title={tm.deleteMember}
                  onClick={() => handleDelete(idx)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })
      )}

      <button
        type="button"
        className="member-list-add"
        onClick={handleAdd}
        disabled={!firstAvailable}
      >
        <Plus size={13} />
        <span>{tm.addMember}</span>
      </button>
    </div>
  )
}
