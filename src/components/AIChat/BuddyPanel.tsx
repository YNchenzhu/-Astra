/**
 * Buddy settings panel inside the main Settings dialog.
 * Shows companion info and quick controls.
 */

import React, { useState } from 'react'
import { Heart, Sparkles, Mic, MicOff, Power } from 'lucide-react'
import { useBuddyStore, SPECIES, SPECIES_EMOJI, RARITY_STARS, RARITY_COLORS, type Species } from '../../stores/useBuddyStore'
import './SettingsDialog.css'

export const BuddyPanel: React.FC = () => {
  const {
    enabled,
    muted,
    name,
    persona,
    emoji,
    species,
    rarity,
    shiny,
    hat,
    eye,
    stats,
    toggleEnabled,
    toggleMuted,
    petBuddy,
    hatch,
    setSpecies,
  } = useBuddyStore()

  const hasCompanion = Boolean(species)
  const [selectedSpecies, setSelectedSpecies] = useState<Species>(() => (species as Species) || SPECIES[0])
  const [prevSpecies, setPrevSpecies] = useState(species)

  // P1-35 note: React officially endorses "adjusting state during rendering"
  // for reset-on-prop-change. Moving this to `useEffect` triggers
  // `react-hooks/set-state-in-effect` for exactly the cascading-render
  // reason React's docs cite. The audit's recommendation to migrate to
  // an effect was incorrect; we keep the inline pattern.
  if (species !== prevSpecies) {
    setPrevSpecies(species)
    if (species) setSelectedSpecies(species as Species)
  }

  if (!enabled) {
    return (
      <div className="settings-tab-content">
        <div className="settings-body">
          <div className="buddy-enable-section">
            <div className="buddy-enable-icon">
              <Sparkles size={32} />
            </div>
            <h3>伙伴助手</h3>
            <p className="buddy-enable-desc">
              孵化一个专属伴生兽，它会伴随你的开发过程，提供情绪反馈和实时建议。
            </p>
            {!hasCompanion ? (
              <button className="buddy-hatch-btn" onClick={() => hatch()}>
                <Sparkles size={16} />
                <span>孵化你的伴生兽</span>
              </button>
            ) : (
              <button className="buddy-hatch-btn" onClick={() => toggleEnabled()}>
                <Power size={16} />
                <span>启动伙伴助手</span>
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-body">
        {/* Companion Card */}
        {hasCompanion ? (
          <div className="settings-group">
            <label className="settings-label">你的伴生兽</label>
            <div className="buddy-info-card">
              <div className="buddy-info-header">
                <span className="buddy-info-emoji">{SPECIES_EMOJI[species as keyof typeof SPECIES_EMOJI] || emoji}</span>
                <div>
                  <div className="buddy-info-name">{name}</div>
                  <div className="buddy-info-species">
                    {species}
                    {rarity && <span style={{ color: RARITY_COLORS[rarity] }}> {RARITY_STARS[rarity]}</span>}
                    {shiny && <span> ✨</span>}
                  </div>
                  <div className="buddy-info-traits">
                    {eye && <div className="buddy-info-eye">👁️ {eye}</div>}
                    {hat && hat !== 'none' && <div className="buddy-info-hat">🎩 {hat}</div>}
                    <div className="buddy-info-shiny">闪光：{shiny ? '是' : '否'}</div>
                  </div>
                  <div className="buddy-info-persona">{persona}</div>
                </div>
              </div>
              {stats && (
                <div className="buddy-info-stats">
                  {Object.entries(stats).map(([key, val]) => (
                    <div key={key} className="buddy-info-stat">
                      <span className="buddy-info-stat-name">{key}</span>
                      <div className="buddy-info-stat-bar">
                        <div
                          className="buddy-info-stat-fill"
                          style={{
                            width: `${val}%`,
                            backgroundColor: val >= 70 ? '#22c55e' : val >= 40 ? '#f59e0b' : '#ef4444',
                          }}
                        />
                      </div>
                      <span className="buddy-info-stat-value">{val}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="settings-group">
            <div className="settings-row-toggle">
              <div>
                <label className="settings-label">伙伴助手已启用</label>
                <p className="settings-hint">当前：{name}（{persona}）</p>
              </div>
              <button className="buddy-quick-toggle" onClick={() => toggleEnabled()} title="禁用伙伴助手">
                <Power size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Quick Controls */}
        <div className="settings-group">
          <label className="settings-label">快捷操作</label>
          {hasCompanion && (
            <div className="settings-group" style={{ marginTop: 8, marginBottom: 8 }}>
              <label className="settings-label">形态选择（18 种）</label>
              <div className="settings-row-toggle" style={{ gap: 8 }}>
                <div className="settings-select-wrapper" style={{ flex: 1 }}>
                  <select
                    className="settings-select"
                    value={selectedSpecies}
                    onChange={(e) => setSelectedSpecies(e.target.value as Species)}
                  >
                    {SPECIES.map((s) => (
                      <option key={s} value={s}>
                        {(SPECIES_EMOJI as Record<string, string>)[s] || '🧬'} {s}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="buddy-quick-btn"
                  onClick={() => void setSpecies(selectedSpecies)}
                  title="应用形态"
                >
                  <Sparkles size={14} />
                  <span>应用</span>
                </button>
              </div>
            </div>
          )}
          <div className="buddy-quick-actions">
            {hasCompanion && (
              <button className="buddy-quick-btn" onClick={() => hatch()} title="重新孵化形态">
                <Sparkles size={14} />
                <span>重新孵化</span>
              </button>
            )}
            <button className="buddy-quick-btn" onClick={() => toggleMuted()} title={muted ? '取消静音' : '静音'}>
              {muted ? <MicOff size={14} /> : <Mic size={14} />}
              <span>{muted ? '取消静音' : '静音'}</span>
            </button>
            <button className="buddy-quick-btn" onClick={() => petBuddy()} title="抚摸">
              <Heart size={14} />
              <span>抚摸</span>
            </button>
            {hasCompanion && (
              <button className="buddy-quick-btn" onClick={() => toggleEnabled()} title="禁用伙伴助手">
                <Power size={14} />
                <span>禁用</span>
              </button>
            )}
          </div>
        </div>

        {/* Buddy info */}
        <div className="settings-group">
          <p className="settings-hint" style={{ lineHeight: 1.6 }}>
            伙伴助手是伴随式 AI 角色，会在使用 AI 时提供情绪反馈、鼓励和实时建议。
            你可以随时在上方选择 18 种物种形态，也可以点击“重新孵化”随机生成新的外观与属性。
          </p>
        </div>
      </div>
    </div>
  )
}
