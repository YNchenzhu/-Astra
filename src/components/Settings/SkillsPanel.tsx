import React, { useState, useEffect, useMemo } from 'react'
import { Zap, RefreshCw, Play, X } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useT } from '../../i18n'
import './SkillsPanel.css'

interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  source: string
  context?: string
  userInvocable?: boolean
  disableModelInvocation?: boolean
}

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  user: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#22c55e' },
  project: { bg: 'rgba(137, 180, 250, 0.12)', fg: '#89b4fa' },
}

export const SkillsPanel: React.FC = () => {
  const t = useT().settings.skills
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningSkill, setRunningSkill] = useState<string | null>(null)
  const [skillOutput, setSkillOutput] = useState<Record<string, string>>({})
  const [viewOutput, setViewOutput] = useState<string | null>(null)

  useEffect(() => {
    loadSkills()
    // Audit P1-7 (2026-05): subscribe to main-process `skill:reloaded`
    // broadcasts (SKILL.md edits / git pull / external writes) so the panel
    // auto-refreshes instead of going stale until the user clicks Reload.
    // Optional chaining keeps old preload shells working.
    const unsubscribe = window.electronAPI.skills.onReloaded?.(() => {
      void loadSkills()
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  const loadSkills = async () => {
    try {
      const result = await window.electronAPI.skills.list()
      setSkills(result.skills || [])
    } catch {
      setSkills([])
    }
  }

  const handleReload = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.skills.reload(rootPath || undefined)
      setSkills(result.skills || [])
      setExpanded(null)
      setSkillOutput({})
    } catch (e) {
      console.error('Failed to reload skills:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleRun = async (skill: SkillInfo) => {
    setRunningSkill(skill.name)
    try {
      const result = await window.electronAPI.skills.execute(skill.name)
      const output = result.output || result.context || t.execDone
      setSkillOutput((prev) => ({ ...prev, [skill.name]: output }))
      setViewOutput(skill.name)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setSkillOutput((prev) => ({
        ...prev,
        [skill.name]: t.execFailed(msg),
      }))
      setViewOutput(skill.name)
    } finally {
      setRunningSkill(null)
    }
  }

  const filteredSkills = useMemo(() => {
    if (!search.trim()) return skills
    const q = search.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q),
    )
  }, [skills, search])

  const grouped = useMemo(() => {
    const userSkills = filteredSkills.filter((s) => s.source === 'user')
    const projectSkills = filteredSkills.filter((s) => s.source === 'project')
    const systemSkills = filteredSkills.filter(
      (s) => s.source !== 'user' && s.source !== 'project',
    )
    return [
      { label: t.groupUser, items: userSkills, source: 'user' },
      { label: t.groupProject, items: projectSkills, source: 'project' },
      { label: t.groupSystem, items: systemSkills, source: 'system' },
    ].filter((g) => g.items.length > 0)
  }, [filteredSkills, t])

  return (
    <div className="skills-panel">
      {/* Header */}
      <div className="skills-header">
        <h3 className="skills-title">
          <Zap size={16} />
          {t.title}
          <span className="skills-count">{skills.length}</span>
        </h3>
        <button
          className="skills-reload-btn"
          onClick={handleReload}
          disabled={loading}
          title={t.reloadTitle}
        >
          <RefreshCw size={13} className={loading ? 'spinning' : ''} />
          {t.refresh}
        </button>
      </div>

      {/* Search */}
      <div className="skills-search">
        <input
          type="text"
          placeholder={t.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="skills-search-clear" onClick={() => setSearch('')}>
            <X size={12} />
          </button>
        )}
      </div>

      {/* List */}
      {skills.length === 0 ? (
        <div className="skills-empty">
          <Zap size={32} />
          <p>{t.emptyTitle}</p>
          <p className="skills-empty-hint">
            {t.emptyHintPre}<code>.claude/skills/</code>{t.emptyHintSuf}
          </p>
        </div>
      ) : grouped.length === 0 ? (
        <div className="skills-empty">
          <p>{t.noMatch}</p>
          <p className="skills-empty-hint">{t.tryOtherKeywords}</p>
        </div>
      ) : (
        <div className="skills-list">
          {grouped.map((group) => {
            const colors = SOURCE_COLORS[group.source] || {
              bg: 'rgba(108, 112, 134, 0.12)',
              fg: '#6c7086',
            }
            return (
              <div key={group.source} className="skills-group">
                <div className="skills-group-header">
                  <span
                    className="skills-group-badge"
                    style={{ background: colors.bg, color: colors.fg }}
                  >
                    {group.label}
                  </span>
                  <span className="skills-group-count">{group.items.length}</span>
                </div>

                {group.items.map((skill) => {
                  const isExpanded = expanded === skill.name
                  const isRunning = runningSkill === skill.name
                  const hasOutput = !!skillOutput[skill.name]

                  return (
                    <div
                      key={skill.name}
                      className={`skill-card${isExpanded ? ' expanded' : ''}`}
                    >
                      <div
                        className="skill-card-header"
                        onClick={() =>
                          setExpanded(isExpanded ? null : skill.name)
                        }
                      >
                        <div className="skill-card-left">
                          <div
                            className="skill-card-icon"
                            style={{
                              background: colors.bg,
                              color: colors.fg,
                            }}
                          >
                            <Zap size={15} />
                          </div>
                          <div className="skill-card-info">
                            <div className="skill-card-name-row">
                              <span className="skill-card-name">
                                {skill.name}
                              </span>
                              {skill.userInvocable && (
                                <span className="skill-badge user">
                                  {t.badgeUser}
                                </span>
                              )}
                              {skill.disableModelInvocation && (
                                <span className="skill-badge silent">{t.badgeSilent}</span>
                              )}
                            </div>
                            <p className="skill-card-brief">
                              {skill.description.slice(0, 70)}
                              {skill.description.length > 70 ? '…' : ''}
                            </p>
                          </div>
                        </div>

                        <div className="skill-card-right">
                          <button
                            className="skill-run-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRun(skill)
                            }}
                            disabled={isRunning}
                            title={t.runTitle}
                          >
                            {isRunning ? (
                              <RefreshCw size={12} className="spinning" />
                            ) : (
                              <Play size={12} />
                            )}
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="skill-card-body">
                          <p className="skill-card-desc">
                            {skill.description}
                          </p>

                          {skill.argumentHint && (
                            <div className="skill-card-hint">
                              <span className="skill-card-hint-label">{t.usage}</span>
                              <code>/{skill.name} {skill.argumentHint}</code>
                            </div>
                          )}

                          <div className="skill-card-meta">
                            <span>
                              {t.sourceLabel}<code>{skill.source}</code>
                            </span>
                            {hasOutput && (
                              <button
                                className="skill-card-view-output"
                                onClick={() =>
                                  setViewOutput(
                                    viewOutput === skill.name
                                      ? null
                                      : skill.name,
                                  )
                                }
                              >
                                {t.viewOutput}
                              </button>
                            )}
                          </div>

                          {viewOutput === skill.name &&
                            skillOutput[skill.name] && (
                              <div className="skill-card-output">
                                <div className="skill-card-output-header">
                                  <span>{t.outputTitle}</span>
                                  <button
                                    onClick={() => setViewOutput(null)}
                                    title={t.close}
                                  >
                                    <X size={13} />
                                  </button>
                                </div>
                                <pre>{skillOutput[skill.name]}</pre>
                              </div>
                            )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
